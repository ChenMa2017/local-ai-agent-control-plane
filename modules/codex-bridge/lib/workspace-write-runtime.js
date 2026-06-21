"use strict";

function createWorkspaceWriteRuntime(deps) {
  const {
    fs,
    fsp,
    path,
    cp,
    crypto,
    PROTECTED_PATH_PATTERNS,
    SNAPSHOT_SKIP_DIRS,
    FINAL_STATUSES,
    nowIso,
    sleep,
    ensureDir,
    readJson,
    writeJson,
    readTask,
    patchTask,
    appendTaskLog,
    taskDir,
    realDirectory,
    normalizeRelativePath,
    releaseWorkspaceWriteLock,
    writeResultIfEmpty,
    ensureSafeResult,
    sanitizeOutput,
    terminateTaskProcessGroup
  } = deps;

  function taskWorktreeDir(config, task) {
    return path.join(config.__stateDir, "worktrees", task.task_id);
  }

  function taskWorktreeCheckoutPath(config, task) {
    return path.join(taskWorktreeDir(config, task), "checkout");
  }

  function writeAuditFile(config, task) {
    return path.join(taskDir(config, task.task_id), "write_audit.json");
  }

  function writeBaselineFile(config, task) {
    return path.join(taskDir(config, task.task_id), "write_baseline.json");
  }

  function diffStatFile(config, task) {
    return path.join(taskDir(config, task.task_id), "diff_stat.safe.txt");
  }

  function changedFilesFile(config, task) {
    return path.join(taskDir(config, task.task_id), "changed_files.safe.txt");
  }

  async function runGit(config, cwd, args, options = {}) {
    return new Promise((resolve) => {
      cp.execFile("git", ["-C", cwd, ...args], {
        timeout: Math.max(1000, Number(options.timeoutMs || 10000)),
        maxBuffer: 1024 * 1024
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout: stdout || "",
          stderr: stderr || ""
        });
      });
    });
  }

  async function isGitWorkspace(config, workspacePath) {
    const result = await runGit(config, workspacePath, ["rev-parse", "--is-inside-work-tree"]);
    return result.ok && result.stdout.trim() === "true";
  }

  async function gitWorkspaceInfo(config, workspacePath) {
    const inside = await runGit(config, workspacePath, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      return {
        eligible: false,
        reason: "not_git_workspace"
      };
    }

    const rootResult = await runGit(config, workspacePath, ["rev-parse", "--show-toplevel"]);
    if (!rootResult.ok) {
      return {
        eligible: false,
        reason: "git_root_unavailable"
      };
    }
    const repoRoot = await realDirectory(rootResult.stdout.trim());
    const headResult = await runGit(config, workspacePath, ["rev-parse", "--verify", "HEAD"]);
    if (!headResult.ok) {
      return {
        eligible: false,
        reason: "git_head_unavailable",
        repoRoot
      };
    }

    const relativeProjectPath = normalizeRelativePath(path.relative(repoRoot, workspacePath));
    const statusResult = await runGit(config, workspacePath, ["status", "--porcelain"]);
    return {
      eligible: true,
      reason: "git_worktree",
      repoRoot,
      head: headResult.stdout.trim(),
      relativeProjectPath,
      dirty: Boolean((statusResult.stdout || "").trim())
    };
  }

  function taskExecutionProjectPath(task) {
    return task.execution_project_path || task.project_path;
  }

  function taskWriteAuditRootPath(task) {
    return task.write_audit_root_path || task.execution_project_path || task.project_path;
  }

  async function prepareWorkspaceWriteExecution(config, task) {
    if (!task || task.mode !== "workspace-write") {
      return task;
    }
    if (task.execution_project_path) {
      return task;
    }

    const info = await gitWorkspaceInfo(config, task.project_path);
    if (!info.eligible) {
      const patched = await patchTask(config, task.task_id, {
        execution_strategy: "direct",
        execution_strategy_reason: info.reason,
        execution_project_path: task.project_path,
        write_audit_root_path: task.project_path
      });
      await appendTaskLog(config, patched, `workspace-write using direct project path reason=${info.reason}`);
      return patched;
    }

    const checkoutPath = taskWorktreeCheckoutPath(config, task);
    await ensureDir(taskWorktreeDir(config, task));
    const addResult = await runGit(config, info.repoRoot, ["worktree", "add", "--detach", checkoutPath, info.head], { timeoutMs: 30000 });
    if (!addResult.ok) {
      throw new Error(`git worktree add failed: ${(addResult.stderr || addResult.stdout || "unknown error").trim()}`);
    }

    const executionProjectPath = await realDirectory(
      info.relativeProjectPath ? path.join(checkoutPath, info.relativeProjectPath) : checkoutPath
    );
    const patched = await patchTask(config, task.task_id, {
      execution_strategy: "git_worktree",
      execution_strategy_reason: info.dirty ? "git_worktree_dirty_head_snapshot" : "git_worktree_head_snapshot",
      execution_project_path: executionProjectPath,
      write_audit_root_path: checkoutPath,
      worktree_path: checkoutPath,
      worktree_repo_root: info.repoRoot,
      worktree_relative_project_path: info.relativeProjectPath,
      worktree_head: info.head,
      worktree_source_dirty: info.dirty,
      worktree_created_at: nowIso(),
      worktree_cleanup_status: null
    });
    await appendTaskLog(
      config,
      patched,
      info.dirty
        ? `prepared isolated git worktree at HEAD=${info.head} (source workspace had uncommitted changes)`
        : `prepared isolated git worktree at HEAD=${info.head}`
    );
    return patched;
  }

  async function cleanupWorkspaceWriteExecution(config, task, reason = "cleanup") {
    if (!task || task.mode !== "workspace-write" || task.execution_strategy !== "git_worktree" || !task.worktree_path) {
      return task;
    }
    if (task.worktree_cleanup_status === "removed" || task.worktree_cleanup_status === "missing") {
      return task;
    }

    const exists = await fsp.stat(task.worktree_path).then((stat) => stat.isDirectory()).catch(() => false);
    if (!exists) {
      const patchedMissing = await patchTask(config, task.task_id, {
        worktree_removed_at: task.worktree_removed_at || nowIso(),
        worktree_cleanup_status: "missing",
        worktree_cleanup_reason: reason
      }).catch(() => task);
      await appendTaskLog(config, patchedMissing, `worktree cleanup skipped reason=${reason} status=missing`).catch(() => {});
      return patchedMissing;
    }

    const removeResult = await runGit(
      config,
      task.worktree_repo_root || task.project_path,
      ["worktree", "remove", "--force", task.worktree_path],
      { timeoutMs: 30000 }
    );
    if (!removeResult.ok) {
      const message = (removeResult.stderr || removeResult.stdout || "unknown error").trim();
      const patchedFailed = await patchTask(config, task.task_id, {
        worktree_cleanup_status: "remove_failed",
        worktree_cleanup_reason: reason,
        worktree_cleanup_error: message
      }).catch(() => task);
      await appendTaskLog(config, patchedFailed, `worktree cleanup failed reason=${reason}: ${message}`).catch(() => {});
      return patchedFailed;
    }

    const patched = await patchTask(config, task.task_id, {
      worktree_removed_at: nowIso(),
      worktree_cleanup_status: "removed",
      worktree_cleanup_reason: reason,
      worktree_cleanup_error: null
    }).catch(() => task);
    await appendTaskLog(config, patched, `worktree cleanup completed reason=${reason}`).catch(() => {});
    return patched;
  }

  async function snapshotWorkspace(root) {
    const files = {};
    async function walk(dir, relBase = "") {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = normalizeRelativePath(path.join(relBase, entry.name));
        if (entry.isDirectory()) {
          if (SNAPSHOT_SKIP_DIRS.has(entry.name)) {
            continue;
          }
          await walk(path.join(dir, entry.name), rel);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
        if (!stat) {
          continue;
        }
        files[rel] = {
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs)
        };
      }
    }
    await walk(root);
    return files;
  }

  function diffSnapshots(before, after) {
    const changes = [];
    const all = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const file of Array.from(all).sort()) {
      const left = before && before[file];
      const right = after && after[file];
      if (!left && right) {
        changes.push({ status: "A", file });
      } else if (left && !right) {
        changes.push({ status: "D", file });
      } else if (left && right && (left.size !== right.size || left.mtimeMs !== right.mtimeMs)) {
        changes.push({ status: "M", file });
      }
    }
    return changes;
  }

  function protectedPathMatches(changes) {
    const matches = [];
    for (const change of changes) {
      const file = normalizeRelativePath(change.file);
      for (const pattern of PROTECTED_PATH_PATTERNS) {
        if (pattern.test(file)) {
          matches.push({ file, status: change.status, rule: pattern.label });
        }
      }
    }
    return matches;
  }

  function parseGitStatusPorcelain(text) {
    const changes = [];
    for (const rawLine of String(text || "").split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) {
        continue;
      }
      const statusToken = line.slice(0, 2).trim() || "M";
      const rest = line.slice(3).trim();
      if (!rest) {
        continue;
      }
      if (rest.includes(" -> ")) {
        const parts = rest.split(" -> ");
        changes.push({ status: statusToken.charAt(0) || "M", file: parts[0] });
        changes.push({ status: statusToken.charAt(0) || "M", file: parts[parts.length - 1] });
        continue;
      }
      changes.push({ status: statusToken.charAt(0) || "M", file: rest });
    }
    return changes;
  }

  async function currentProtectedPathMatches(config, task, baseline) {
    const auditRoot = baseline.audit_root_path || taskWriteAuditRootPath(task);
    if (baseline.git || await isGitWorkspace(config, auditRoot)) {
      const gitStatus = await runGit(config, auditRoot, ["status", "--porcelain", "--untracked-files=all"]);
      if (!gitStatus.ok) {
        return [];
      }
      return protectedPathMatches(parseGitStatusPorcelain(gitStatus.stdout));
    }
    const afterSnapshot = await snapshotWorkspace(auditRoot);
    return protectedPathMatches(diffSnapshots(baseline.snapshot || {}, afterSnapshot));
  }

  function describeProtectedPathMatches(matches) {
    return matches.map((item) => `${item.status}:${item.file}:${item.rule}`).join(", ");
  }

  async function beginWriteAudit(config, task) {
    if (task.mode !== "workspace-write") {
      return task;
    }
    const auditRoot = taskWriteAuditRootPath(task);
    const git = await isGitWorkspace(config, auditRoot);
    const gitStatus = git ? await runGit(config, auditRoot, ["status", "--porcelain"]) : { stdout: "" };
    const gitDiffStat = git ? await runGit(config, auditRoot, ["diff", "--stat"]) : { stdout: "" };
    const snapshot = await snapshotWorkspace(auditRoot);
    const baselineFile = writeBaselineFile(config, task);
    await writeJson(baselineFile, {
      captured_at: nowIso(),
      audit_root_path: auditRoot,
      git,
      git_status_before: gitStatus.stdout,
      git_diff_stat_before: gitDiffStat.stdout,
      snapshot
    });
    const auditFile = writeAuditFile(config, task);
    await writeJson(auditFile, {
      version: 1,
      task_id: task.task_id,
      project: task.project,
      mode: task.mode,
      execution_strategy: task.execution_strategy || "direct",
      execution_project_path: taskExecutionProjectPath(task),
      audit_root_path: auditRoot,
      started_at: nowIso(),
      completed_at: null,
      git,
      changed_files_count: null,
      protected_path_violation: false
    });
    const patched = await patchTask(config, task.task_id, {
      write_audit_path: auditFile,
      write_baseline_path: baselineFile,
      diff_stat_file: diffStatFile(config, task),
      changed_files_file: changedFilesFile(config, task),
      changed_files_count: 0,
      protected_path_violation: false
    });
    await appendTaskLog(config, patched, "captured workspace-write audit baseline");
    return patched;
  }

  function countChanges(changes) {
    return {
      added: changes.filter((item) => item.status === "A").length,
      modified: changes.filter((item) => item.status === "M").length,
      deleted: changes.filter((item) => item.status === "D").length
    };
  }

  function writeSummaryText(audit) {
    const lines = [
      "",
      "## Write Summary",
      "",
      `Mode: ${audit.mode}`,
      `Changed files: ${audit.changed_files_count}`,
      `Added: ${audit.added_count}`,
      `Modified: ${audit.modified_count}`,
      `Deleted: ${audit.deleted_count}`,
      `Protected path violation: ${audit.protected_path_violation ? "yes" : "no"}`
    ];
    if (audit.changed_files.length) {
      lines.push("", "Changed file list:");
      for (const item of audit.changed_files.slice(0, 200)) {
        lines.push(`- ${item.status} ${item.file}`);
      }
    }
    if (audit.protected_path_matches.length) {
      lines.push("", "Protected path matches:");
      for (const item of audit.protected_path_matches) {
        lines.push(`- ${item.status} ${item.file} (${item.rule})`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  async function appendWriteSummaryToResult(task, summary) {
    const raw = await fsp.readFile(task.result_file, "utf8").catch(() => "");
    if (raw.includes("## Write Summary")) {
      return;
    }
    await fsp.appendFile(task.result_file, summary, "utf8").catch(() => {});
  }

  async function finalizeWriteAudit(config, task) {
    if (!task || task.mode !== "workspace-write") {
      return task;
    }
    const baseline = await readJson(task.write_baseline_path || writeBaselineFile(config, task)).catch(() => null);
    if (!baseline || !baseline.snapshot) {
      return task;
    }
    const auditRoot = baseline.audit_root_path || taskWriteAuditRootPath(task);
    const afterSnapshot = await snapshotWorkspace(auditRoot);
    const changes = diffSnapshots(baseline.snapshot, afterSnapshot);
    const counts = countChanges(changes);
    const protectedMatches = protectedPathMatches(changes);
    const git = baseline.git || await isGitWorkspace(config, auditRoot);
    const gitStatusAfter = git ? await runGit(config, auditRoot, ["status", "--porcelain"]) : { stdout: "" };
    const gitDiffStatAfter = git ? await runGit(config, auditRoot, ["diff", "--stat"]) : { stdout: "" };
    const gitNameStatusAfter = git ? await runGit(config, auditRoot, ["diff", "--name-status"]) : { stdout: "" };
    const audit = {
      version: 1,
      task_id: task.task_id,
      project: task.project,
      mode: task.mode,
      execution_strategy: task.execution_strategy || "direct",
      execution_project_path: taskExecutionProjectPath(task),
      audit_root_path: auditRoot,
      started_at: task.started_at,
      completed_at: nowIso(),
      git,
      git_status_before: baseline.git_status_before || "",
      git_status_after: gitStatusAfter.stdout,
      git_diff_stat_before: baseline.git_diff_stat_before || "",
      git_diff_stat_after: gitDiffStatAfter.stdout,
      git_name_status_after: gitNameStatusAfter.stdout,
      changed_files_count: changes.length,
      added_count: counts.added,
      modified_count: counts.modified,
      deleted_count: counts.deleted,
      changed_files: changes,
      protected_path_violation: protectedMatches.length > 0,
      protected_path_matches: protectedMatches
    };
    const sanitizedDiff = sanitizeOutput(
      git
        ? [
          "# Git Diff Stat",
          "",
          gitDiffStatAfter.stdout.trim() || "(empty)",
          "",
          "# Git Name Status",
          "",
          gitNameStatusAfter.stdout.trim() || "(empty)"
        ].join("\n")
        : [
          "# Workspace Snapshot Diff",
          "",
          changes.map((item) => `${item.status}\t${item.file}`).join("\n") || "(empty)"
        ].join("\n"),
      { config, task }
    ).text;
    const changedText = sanitizeOutput(
      changes.map((item) => `${item.status}\t${item.file}`).join("\n") || "(empty)",
      { config, task }
    ).text;
    await writeJson(writeAuditFile(config, task), audit);
    await fsp.writeFile(diffStatFile(config, task), `${sanitizedDiff.trimEnd()}\n`, "utf8").catch(() => {});
    await fsp.writeFile(changedFilesFile(config, task), `${changedText.trimEnd()}\n`, "utf8").catch(() => {});
    const current = await readTask(config, task.task_id).catch(() => task);
    const nextStatus = audit.protected_path_violation && current.status === "done" ? "policy_violation" : current.status;
    const patched = await patchTask(config, task.task_id, {
      status: nextStatus,
      write_audit_path: writeAuditFile(config, task),
      diff_stat_file: diffStatFile(config, task),
      changed_files_file: changedFilesFile(config, task),
      changed_files_count: audit.changed_files_count,
      added_files_count: audit.added_count,
      modified_files_count: audit.modified_count,
      deleted_files_count: audit.deleted_count,
      protected_path_violation: audit.protected_path_violation,
      protected_path_matches: audit.protected_path_matches,
      write_audit_completed_at: audit.completed_at,
      termination_reason: nextStatus === "policy_violation" ? "policy_violation" : current.termination_reason || null
    });
    await appendWriteSummaryToResult(patched, writeSummaryText(audit));
    await appendTaskLog(config, patched, `write audit completed changed_files=${audit.changed_files_count} protected=${audit.protected_path_violation}`);
    return patched;
  }

  async function finalizeWorkspaceWriteTask(config, task, reason = "finalize") {
    let current = await readTask(config, task.task_id).catch(() => task);
    if (current && current.mode === "workspace-write") {
      current = await finalizeWriteAudit(config, current).catch(async (error) => {
        await appendTaskLog(config, current, `write audit failed: ${error.message}`).catch(() => {});
        return current;
      });
      await releaseWorkspaceWriteLock(config, current, reason).catch(() => {});
      current = await cleanupWorkspaceWriteExecution(config, await readTask(config, task.task_id).catch(() => current), reason).catch(async (error) => {
        await appendTaskLog(config, current, `worktree cleanup failed: ${error.message}`).catch(() => {});
        return current;
      });
    }
    current = await readTask(config, task.task_id).catch(() => current || task);
    await ensureSafeResult(config, current).catch(() => {});
    return current;
  }

  async function markTaskPolicyViolation(config, task, matches, source = "protected_path_guard") {
    const fresh = await readTask(config, task.task_id).catch(() => task);
    if (FINAL_STATUSES.has(fresh.status)) {
      return fresh;
    }
    const finishedAt = nowIso();
    const updated = await patchTask(config, fresh.task_id, {
      status: "policy_violation",
      ended_at: fresh.ended_at || finishedAt,
      finished_at: fresh.finished_at || finishedAt,
      termination_reason: "policy_violation",
      protected_path_violation: true,
      protected_path_matches: matches
    });
    await appendTaskLog(config, updated, `${source} triggered matches=${describeProtectedPathMatches(matches)}`).catch(() => {});
    const termination = await terminateTaskProcessGroup(config, updated, "policy_violation");
    const finalTask = await patchTask(config, fresh.task_id, {
      status: "policy_violation",
      ended_at: finishedAt,
      finished_at: finishedAt,
      termination_reason: "policy_violation",
      protected_path_violation: true,
      protected_path_matches: matches,
      exit_signal: termination.signal || fresh.exit_signal || null
    }).catch(() => updated);
    await writeResultIfEmpty(finalTask, `Task ${fresh.task_id} was stopped because it touched a protected path during execution.\n`);
    return finalTask;
  }

  function startProtectedPathGuard(config, task) {
    const intervalMs = Math.max(50, Number(config.protectedPathWatchIntervalMs || 250));
    let stopped = false;
    let timer = null;
    let inFlight = false;

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function schedule() {
      if (stopped) {
        return;
      }
      timer = setTimeout(tick, intervalMs);
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
    }

    async function tick() {
      clearTimer();
      if (stopped || inFlight) {
        if (!stopped) {
          schedule();
        }
        return;
      }
      inFlight = true;
      try {
        const latest = await readTask(config, task.task_id).catch(() => task);
        if (!latest || FINAL_STATUSES.has(latest.status)) {
          stopped = true;
          return;
        }
        const baseline = await readJson(latest.write_baseline_path || writeBaselineFile(config, latest)).catch(() => null);
        if (!baseline) {
          schedule();
          return;
        }
        const matches = await currentProtectedPathMatches(config, latest, baseline);
        if (matches.length) {
          await markTaskPolicyViolation(config, latest, matches);
          stopped = true;
          return;
        }
      } catch (error) {
        await appendTaskLog(config, task, `protected path guard error: ${error.message}`).catch(() => {});
      } finally {
        inFlight = false;
      }
      schedule();
    }

    schedule();
    return {
      stop() {
        stopped = true;
        clearTimer();
      }
    };
  }

  return {
    reconcileWorkspaceWriteLocks: async function reconcileWorkspaceWriteLocks(config) {
      const dir = path.join(config.__stateDir, "locks", "workspace-write");
      await ensureDir(dir);
      const mutex = path.join(dir, ".index.lock");
      const deadline = Date.now() + 30000;
      while (true) {
        try {
          await fsp.mkdir(mutex);
          break;
        } catch (error) {
          if (!error || error.code !== "EEXIST") {
            throw error;
          }
          if (Date.now() > deadline) {
            throw new Error("Timed out waiting for workspace write lock index.");
          }
          await sleep(100);
        }
      }
      try {
        const names = await fsp.readdir(dir).catch(() => []);
        const locks = [];
        for (const name of names) {
          if (!name.endsWith(".json")) {
            continue;
          }
          try {
            locks.push(await readJson(path.join(dir, name)));
          } catch (_error) {
            // Ignore malformed lock files.
          }
        }
        for (const lock of locks) {
          if (!lock || lock.released_at || !lock.task_id) {
            continue;
          }
          const task = await readTask(config, lock.task_id).catch(() => null);
          if (!task) {
            await writeJson(path.join(dir, `${lock.task_id}.json`), Object.assign({}, lock, {
              released_at: nowIso(),
              release_reason: "missing_task"
            })).catch(() => {});
            continue;
          }
          if (FINAL_STATUSES.has(task.status) || !(await deps.taskWorkerLooksAlive(task))) {
            await releaseWorkspaceWriteLock(config, task, FINAL_STATUSES.has(task.status) ? "final_status" : "stale_worker");
          }
        }
      } finally {
        await fsp.rmdir(mutex).catch(() => {});
      }
    },
    acquireWorkspaceWriteLock: async function acquireWorkspaceWriteLock(config, task) {
      if (task.mode !== "workspace-write") {
        return task;
      }

      function pathsOverlap(a, b) {
        const left = path.resolve(String(a || ""));
        const right = path.resolve(String(b || ""));
        return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
      }

      async function readWorkspaceWriteLocks(configValue) {
        const dir = path.join(configValue.__stateDir, "locks", "workspace-write");
        const names = await fsp.readdir(dir).catch(() => []);
        const locks = [];
        for (const name of names) {
          if (!name.endsWith(".json")) {
            continue;
          }
          try {
            locks.push(await readJson(path.join(dir, name)));
          } catch (_error) {
            // Ignore malformed lock files.
          }
        }
        return locks;
      }

      async function withLockIndex(configValue, fn) {
        const dir = path.join(configValue.__stateDir, "locks", "workspace-write");
        await ensureDir(dir);
        const mutex = path.join(dir, ".index.lock");
        const deadline = Date.now() + 30000;
        while (true) {
          try {
            await fsp.mkdir(mutex);
            break;
          } catch (error) {
            if (!error || error.code !== "EEXIST") {
              throw error;
            }
            if (Date.now() > deadline) {
              throw new Error("Timed out waiting for workspace write lock index.");
            }
            await sleep(100);
          }
        }
        try {
          return await fn();
        } finally {
          await fsp.rmdir(mutex).catch(() => {});
        }
      }

      async function reconcileWorkspaceWriteLocksUnlocked(configValue) {
        const locks = await readWorkspaceWriteLocks(configValue);
        for (const lock of locks) {
          if (!lock || lock.released_at || !lock.task_id) {
            continue;
          }
          const lockTask = await readTask(configValue, lock.task_id).catch(() => null);
          if (!lockTask) {
            await writeJson(path.join(configValue.__stateDir, "locks", "workspace-write", `${lock.task_id}.json`), Object.assign({}, lock, {
              released_at: nowIso(),
              release_reason: "missing_task"
            })).catch(() => {});
            continue;
          }
          if (FINAL_STATUSES.has(lockTask.status) || !(await deps.taskWorkerLooksAlive(lockTask))) {
            await releaseWorkspaceWriteLock(configValue, lockTask, FINAL_STATUSES.has(lockTask.status) ? "final_status" : "stale_worker");
          }
        }
      }

      async function findConflictingWorkspaceWriteLock(configValue, currentTask) {
        const locks = await readWorkspaceWriteLocks(configValue);
        for (const lock of locks) {
          if (!lock || lock.released_at || lock.task_id === currentTask.task_id) {
            continue;
          }
          if (!pathsOverlap(lock.project_path, currentTask.project_path)) {
            continue;
          }
          const holder = await readTask(configValue, lock.task_id).catch(() => null);
          if (!holder || FINAL_STATUSES.has(holder.status)) {
            await releaseWorkspaceWriteLock(configValue, holder || lock, "stale_conflict").catch(() => {});
            continue;
          }
          return { lock, task: holder };
        }
        return null;
      }

      while (true) {
        const fresh = await readTask(config, task.task_id);
        if (fresh.status === "cancel_requested" || fresh.status === "cancelling" || fresh.status === "cancelled") {
          return null;
        }
        const acquired = await withLockIndex(config, async () => {
          await reconcileWorkspaceWriteLocksUnlocked(config).catch(() => {});
          const conflict = await findConflictingWorkspaceWriteLock(config, fresh);
          if (conflict) {
            return { conflict };
          }
          const lockId = `${fresh.task_id}_${crypto.randomBytes(4).toString("hex")}`;
          const dir = path.join(config.__stateDir, "locks", "workspace-write");
          const file = path.join(dir, `${fresh.task_id}.json`);
          const lock = {
            version: 1,
            lock_id: lockId,
            task_id: fresh.task_id,
            project: fresh.project,
            project_path: fresh.project_path,
            mode: fresh.mode,
            pid: process.pid,
            acquired_at: nowIso(),
            released_at: null
          };
          await writeJson(file, lock);
          const patched = await patchTask(config, fresh.task_id, {
            write_lock_id: lockId,
            write_lock_file: file,
            write_lock_acquired_at: lock.acquired_at
          });
          return { task: patched };
        });
        if (acquired.task) {
          await appendTaskLog(config, acquired.task, `acquired workspace-write lock ${acquired.task.write_lock_id}`);
          return acquired.task;
        }
        const holder = acquired.conflict && acquired.conflict.task;
        await appendTaskLog(config, fresh, `waiting for workspace-write lock held by ${holder ? holder.task_id : "unknown"}`);
        await sleep(1000);
      }
    },
    taskExecutionProjectPath,
    prepareWorkspaceWriteExecution,
    beginWriteAudit,
    finalizeWorkspaceWriteTask,
    startProtectedPathGuard
  };
}

module.exports = {
  createWorkspaceWriteRuntime
};
