"use strict";

function createTaskStateRuntime(deps) {
  const {
    fsp,
    path,
    crypto,
    nowIso,
    ensureDir,
    sleep,
    reconcileTask
  } = deps;
  const FINAL_TASK_STATUSES = new Set(["done", "failed", "cancelled", "timeout", "stale", "policy_violation"]);
  const TASK_LOCK_TIMEOUT_MS = 30000;
  const TASK_LOCK_STALE_MS = 120000;

  async function readJson(file) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const text = await fsp.readFile(file, "utf8");
        return JSON.parse(text);
      } catch (error) {
        lastError = error;
        await sleep(25 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async function writeJson(file, value) {
    await ensureDir(path.dirname(file));
    const temp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(temp, file);
  }

  function taskId() {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
    return `task_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
  }

  function tasksDir(config) {
    return path.join(config.__stateDir, "tasks");
  }

  function assertTaskId(id) {
    if (!/^task_[A-Za-z0-9_.-]+$/.test(String(id || ""))) {
      throw new Error(`Invalid task id: ${id}`);
    }
  }

  function taskDir(config, id) {
    assertTaskId(id);
    return path.join(tasksDir(config), id);
  }

  function taskFile(config, id) {
    return path.join(taskDir(config, id), "task.json");
  }

  function locksDir(config) {
    return path.join(config.__stateDir, "locks", "workspace-write");
  }

  function workspaceLockFile(config, taskOrId) {
    const id = typeof taskOrId === "string" ? taskOrId : taskOrId.task_id;
    assertTaskId(id);
    return path.join(locksDir(config), `${id}.json`);
  }

  function worktreesDir(config) {
    return path.join(config.__stateDir, "worktrees");
  }

  function taskWorktreeDir(config, task) {
    return path.join(worktreesDir(config), task.task_id);
  }

  function taskWorktreeCheckoutPath(config, task) {
    return path.join(taskWorktreeDir(config, task), "checkout");
  }

  function safeResultFile(config, task) {
    return task.safe_result_file || path.join(taskDir(config, task.task_id), "result.safe.md");
  }

  function safeLogsFile(config, task) {
    return task.safe_logs_file || path.join(taskDir(config, task.task_id), "logs.safe.txt");
  }

  function optionalTaskId(value) {
    const text = String(value || "").trim();
    if (!text) {
      return null;
    }
    assertTaskId(text);
    return text;
  }

  async function readTask(config, id) {
    return readJson(taskFile(config, id));
  }

  function taskLockDir(config, id) {
    return path.join(taskDir(config, id), ".task.lock");
  }

  function taskLockOwnerFile(config, id) {
    return path.join(taskLockDir(config, id), "owner.json");
  }

  function taskLockTimeoutMs(config) {
    return Math.max(100, Number(config.taskLockTimeoutMs || TASK_LOCK_TIMEOUT_MS));
  }

  function taskLockStaleMs(config) {
    return Math.max(1000, Number(config.taskLockStaleMs || TASK_LOCK_STALE_MS));
  }

  function processLooksAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return Boolean(error && error.code === "EPERM");
    }
  }

  async function readTaskLockOwner(config, id) {
    return readJson(taskLockOwnerFile(config, id)).catch(() => null);
  }

  async function writeTaskLockOwner(config, id, operation) {
    await writeJson(taskLockOwnerFile(config, id), {
      pid: process.pid,
      task_id: id,
      operation: operation || "task_lock",
      created_at: nowIso()
    });
  }

  async function lockAgeMs(config, id, owner) {
    const createdAt = owner && owner.created_at ? new Date(owner.created_at).getTime() : NaN;
    if (Number.isFinite(createdAt) && createdAt > 0) {
      return Math.max(0, Date.now() - createdAt);
    }
    const stat = await fsp.stat(taskLockDir(config, id)).catch(() => null);
    if (!stat) {
      return 0;
    }
    return Math.max(0, Date.now() - Math.round(stat.mtimeMs));
  }

  async function reclaimStaleTaskLock(config, id) {
    const owner = await readTaskLockOwner(config, id);
    const ageMs = await lockAgeMs(config, id, owner);
    if (ageMs < taskLockStaleMs(config)) {
      return false;
    }
    if (owner && processLooksAlive(owner.pid)) {
      return false;
    }
    await fsp.rm(taskLockDir(config, id), { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async function withTaskLock(config, id, fn, options = {}) {
    const lockDir = taskLockDir(config, id);
    const deadline = Date.now() + taskLockTimeoutMs(config);
    while (true) {
      try {
        await ensureDir(taskDir(config, id));
        await fsp.mkdir(lockDir);
        try {
          await writeTaskLockOwner(config, id, options.operation);
        } catch (error) {
          await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          continue;
        }
        if (!error || error.code !== "EEXIST") {
          throw error;
        }
        if (await reclaimStaleTaskLock(config, id)) {
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for task lock: ${id}`);
        }
        await sleep(50);
      }
    }
    try {
      return await fn();
    } finally {
      await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function writeTask(config, task) {
    task.updated_at = nowIso();
    await writeJson(taskFile(config, task.task_id), task);
  }

  async function patchTask(config, id, patch) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, "status")) {
      throw new Error("task status must be changed through transitionTask");
    }
    return withTaskLock(config, id, async () => {
      const task = await readTask(config, id);
      Object.assign(task, patch);
      await writeTask(config, task);
      return task;
    }, { operation: "patch_task" });
  }

  function annotateTransition(task, meta) {
    Object.defineProperty(task, "__transition", {
      value: meta,
      enumerable: false,
      configurable: true
    });
    return task;
  }

  async function transitionTask(config, id, options) {
    const expectedStatuses = new Set((options.expectedStatuses || []).map((status) => String(status)));
    const nextStatus = String(options.nextStatus || "").trim();
    const patch = Object.assign({}, options.patch || {});
    if (!nextStatus) {
      throw new Error("transitionTask requires nextStatus.");
    }
    delete patch.status;

    return withTaskLock(config, id, async () => {
      const task = await readTask(config, id);
      const currentStatus = String(task.status || "");

      if (FINAL_TASK_STATUSES.has(currentStatus) && currentStatus !== nextStatus) {
        return annotateTransition(task, {
          accepted: false,
          stateChanged: false,
          applied: false,
          reason: "final_status_immutable",
          from: currentStatus,
          to: nextStatus
        });
      }

      if (expectedStatuses.size && currentStatus !== nextStatus && !expectedStatuses.has(currentStatus)) {
        return annotateTransition(task, {
          accepted: false,
          stateChanged: false,
          applied: false,
          reason: "unexpected_status",
          from: currentStatus,
          to: nextStatus
        });
      }

      const stateChanged = currentStatus !== nextStatus;
      Object.assign(task, patch);
      task.status = nextStatus;
      await writeTask(config, task);
      return annotateTransition(task, {
        accepted: true,
        stateChanged,
        applied: stateChanged,
        reason: stateChanged ? "transition_applied" : "already_in_target_state",
        from: currentStatus,
        to: nextStatus
      });
    }, { operation: "transition_task" });
  }

  async function appendTaskLog(config, task, line) {
    const file = path.join(taskDir(config, task.task_id), "bridge.log");
    await fsp.appendFile(file, `[${nowIso()}] ${line}\n`, "utf8");
  }

  async function listTasks(config) {
    const dir = tasksDir(config);
    const names = await fsp.readdir(dir).catch(() => []);
    const tasks = [];
    for (const name of names) {
      if (!name.startsWith("task_")) {
        continue;
      }
      try {
        tasks.push(await reconcileTask(config, await readTask(config, name)));
      } catch (_error) {
        // Ignore malformed task directories in the prototype listing.
      }
    }
    return tasks.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  return {
    readJson,
    writeJson,
    taskId,
    tasksDir,
    taskDir,
    taskFile,
    locksDir,
    workspaceLockFile,
    worktreesDir,
    taskWorktreeDir,
    taskWorktreeCheckoutPath,
    safeResultFile,
    safeLogsFile,
    assertTaskId,
    optionalTaskId,
    readTask,
    writeTask,
    patchTask,
    transitionTask,
    appendTaskLog,
    listTasks
  };
}

module.exports = {
  createTaskStateRuntime
};
