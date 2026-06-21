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

  async function writeTask(config, task) {
    task.updated_at = nowIso();
    await writeJson(taskFile(config, task.task_id), task);
  }

  async function patchTask(config, id, patch) {
    const task = await readTask(config, id);
    Object.assign(task, patch);
    await writeTask(config, task);
    return task;
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
    appendTaskLog,
    listTasks
  };
}

module.exports = {
  createTaskStateRuntime
};
