"use strict";

function createCommandRuntime(deps) {
  const {
    parseArgv,
    loadConfig,
    createTask,
    safeUsername,
    reconcileTask,
    readTask,
    listTasks,
    DEFAULT_TASK_LIMIT,
    taskOutputRuntime,
    FINAL_STATUSES,
    CANCELLABLE_STATUSES,
    nowIso,
    patchTask,
    transitionTask,
    appendTaskLog,
    terminateTaskProcessGroup,
    writeResultIfEmpty,
    workspaceWriteRuntime,
    reconcileAllTasks,
    path,
    validateUser
  } = deps;

  async function commandRun(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    const prompt = opts._.join(" ");
    const task = await createTask(config, {
      user: opts.user || safeUsername(),
      project: opts.project,
      prompt,
      mode: opts.mode,
      dryRun: Boolean(opts["dry-run"] || opts.dry_run),
      dryRunStepMs: opts["dry-run-step-ms"],
      source: opts.source || "cli",
      sourceUserId: opts["source-user-id"] || opts.source_user_id,
      sourceChannelId: opts["source-channel-id"] || opts.source_channel_id,
      sourceMessageId: opts["source-message-id"] || opts.source_message_id,
      idempotencyKey: opts["idempotency-key"] || opts.idempotency_key,
      referenceTaskId: opts["reference-task-id"] || opts.reference_task_id,
      metadata: opts.metadata
    });
    console.log(`queued ${task.task_id}`);
    if (task.__idempotent_replay) {
      console.log("idempotent=true");
    }
    console.log(`project=${task.project} user=${task.user} dry_run=${task.dry_run}`);
    console.log(`status: node scripts/codex-bridge.js status ${task.task_id}`);
    console.log(`logs:   node scripts/codex-bridge.js logs ${task.task_id}`);
    console.log(`result: node scripts/codex-bridge.js result ${task.task_id}`);
  }

  function formatDuration(start, end) {
    if (!start) {
      return "-";
    }
    const stop = end ? new Date(end).getTime() : Date.now();
    const ms = Math.max(0, stop - new Date(start).getTime());
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }

  async function commandStatus(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    const id = opts._[0];
    if (id) {
      const task = await reconcileTask(config, await readTask(config, id));
      printTaskDetail(task);
      return;
    }
    const tasks = (await listTasks(config)).slice(0, Number(opts.limit || DEFAULT_TASK_LIMIT));
    if (!tasks.length) {
      console.log("No bridge tasks yet.");
      return;
    }
    for (const task of tasks) {
      console.log(`${task.task_id}  ${task.status.padEnd(16)}  ${task.project.padEnd(12)}  ${formatDuration(task.started_at, task.ended_at).padEnd(8)}  ${task.prompt.slice(0, 80)}`);
    }
  }

  function printTaskDetail(task) {
    console.log(`task_id: ${task.task_id}`);
    console.log(`status: ${task.status}`);
    console.log(`user: ${task.user}`);
    console.log(`project: ${task.project}`);
    console.log(`project_path: ${task.project_path}`);
    console.log(`execution_strategy: ${task.execution_strategy || "direct"}`);
    console.log(`execution_project_path: ${task.execution_project_path || task.project_path}`);
    console.log(`worktree_path: ${task.worktree_path || "-"}`);
    console.log(`worktree_head: ${task.worktree_head || "-"}`);
    console.log(`worktree_cleanup_status: ${task.worktree_cleanup_status || "-"}`);
    console.log(`mode: ${task.mode}`);
    console.log(`dry_run: ${task.dry_run}`);
    console.log(`reference_task_id: ${task.reference_task_id || "-"}`);
    console.log(`created_at: ${task.created_at}`);
    console.log(`started_at: ${task.started_at || "-"}`);
    console.log(`ended_at: ${task.ended_at || "-"}`);
    console.log(`finished_at: ${task.finished_at || "-"}`);
    console.log(`deadline_at: ${task.deadline_at || "-"}`);
    console.log(`timeout_seconds: ${task.timeout_seconds || "-"}`);
    console.log(`duration: ${formatDuration(task.started_at, task.ended_at)}`);
    console.log(`pid: ${task.pid || "-"}`);
    console.log(`pgid: ${task.pgid || "-"}`);
    console.log(`child_pid: ${task.child_pid || "-"}`);
    console.log(`cancel_requested_at: ${task.cancel_requested_at || "-"}`);
    console.log(`termination_reason: ${task.termination_reason || "-"}`);
    console.log(`exit_code: ${task.exit_code === null || task.exit_code === undefined ? "-" : task.exit_code}`);
    console.log(`write_lock_id: ${task.write_lock_id || "-"}`);
    console.log(`write_audit_path: ${task.write_audit_path || "-"}`);
    console.log(`changed_files_count: ${task.changed_files_count === undefined || task.changed_files_count === null ? "-" : task.changed_files_count}`);
    console.log(`protected_path_violation: ${task.protected_path_violation ? "yes" : "no"}`);
    console.log(`prompt: ${task.prompt}`);
  }

  function jsonOutputRequested(opts) {
    return Boolean(opts.json || opts["json-output"]);
  }

  async function commandLogs(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    const id = opts._[0];
    if (!id) {
      throw new Error("logs requires a task_id.");
    }
    let task = await reconcileTask(config, await readTask(config, id));
    const payload = await taskOutputRuntime.logsPayload(config, task, {
      raw: Boolean(opts.raw),
      tail: opts.tail || 80,
      maxChars: opts["max-chars"] || opts.max_chars
    });
    if (jsonOutputRequested(opts)) {
      console.log(JSON.stringify(payload));
      return;
    }
    console.log(payload.text.trimEnd());
  }

  async function commandResult(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    const id = opts._[0];
    if (!id) {
      throw new Error("result requires a task_id.");
    }
    const task = await reconcileTask(config, await readTask(config, id));
    const payload = await taskOutputRuntime.resultPayload(config, task, {
      raw: Boolean(opts.raw),
      maxChars: opts["max-chars"] || opts.max_chars
    });
    if (jsonOutputRequested(opts)) {
      console.log(JSON.stringify(payload));
      return;
    }
    if (!payload.text) {
      console.log(`No result yet. Current status: ${task.status}`);
      return;
    }
    console.log(payload.text.trimEnd());
  }

  async function commandCancel(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    const id = opts._[0];
    if (!id) {
      throw new Error("cancel requires a task_id.");
    }
    const task = await reconcileTask(config, await readTask(config, id));
    if (FINAL_STATUSES.has(task.status)) {
      throw new Error(`${task.task_id} is already finished with status=${task.status}.`);
    }

    if (!CANCELLABLE_STATUSES.has(task.status)) {
      throw new Error(`${task.task_id} cannot be cancelled from status=${task.status}.`);
    }

    const requestedAt = nowIso();
    if (task.status === "queued") {
      const cancelled = await transitionTask(config, id, {
        expectedStatuses: ["queued"],
        nextStatus: "cancelled",
        patch: {
        cancel_requested_at: requestedAt,
        ended_at: requestedAt,
        finished_at: requestedAt,
        termination_reason: "cancelled"
        }
      });
      if (cancelled.__transition && cancelled.__transition.applied) {
        await appendTaskLog(config, cancelled, "cancelled while queued");
        await terminateTaskProcessGroup(config, cancelled, "cancel");
        await writeResultIfEmpty(cancelled, `Task ${task.task_id} was cancelled before it started.\n`);
        await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancel_queued");
        console.log(`${task.task_id} cancelled.`);
        return;
      }
      task = await reconcileTask(config, await readTask(config, id));
      if (FINAL_STATUSES.has(task.status)) {
        console.log(`${task.task_id} already ${task.status}.`);
        return;
      }
    }

    if (!CANCELLABLE_STATUSES.has(task.status)) {
      throw new Error(`${task.task_id} cannot be cancelled from status=${task.status}.`);
    }

    const cancelling = await transitionTask(config, id, {
      expectedStatuses: ["running", "cancel_requested", "cancelling"],
      nextStatus: "cancelling",
      patch: {
      cancel_requested_at: task.cancel_requested_at || requestedAt,
      termination_reason: "cancelled"
      }
    });
    if (!cancelling.__transition || !cancelling.__transition.applied) {
      if (FINAL_STATUSES.has(cancelling.status)) {
        console.log(`${task.task_id} already ${cancelling.status}.`);
        return;
      }
    }
    if (cancelling.__transition && cancelling.__transition.applied) {
      await appendTaskLog(config, cancelling, "cancelling by bridge user");
    }
    const termination = await terminateTaskProcessGroup(config, cancelling, "cancel");
    const finishedAt = nowIso();
    const cancelled = await transitionTask(config, id, {
      expectedStatuses: ["running", "cancel_requested", "cancelling"],
      nextStatus: "cancelled",
      patch: {
      ended_at: finishedAt,
      finished_at: finishedAt,
      termination_reason: "cancelled",
      exit_signal: termination.signal
      }
    });
    if (!cancelled.exit_signal && termination.signal) {
      await patchTask(config, id, { exit_signal: termination.signal }).catch(() => {});
    }
    if (!cancelled.__transition || !cancelled.__transition.applied) {
      console.log(cancelled.status === "cancelled" ? `${task.task_id} cancelled.` : `${task.task_id} already ${cancelled.status}.`);
      return;
    }
    if (cancelled.__transition && cancelled.__transition.applied) {
      await writeResultIfEmpty(cancelled, `Task ${task.task_id} was cancelled.\n`);
      await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancel");
      await appendTaskLog(config, cancelled, "cancel completed");
    }
    console.log(`${task.task_id} cancelled.`);
  }

  async function commandReconcile(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    const count = await reconcileAllTasks(config);
    console.log(`reconciled ${count} task(s).`);
  }

  function taskTimestampMs(task) {
    const value = task.updated_at || task.finished_at || task.ended_at || task.created_at;
    const parsed = new Date(value || 0).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function cleanupNumberOption(value, fallback, name) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`${name} must be a non-negative integer.`);
    }
    return parsed;
  }

  async function commandCleanup(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    if (!opts["dry-run"] && !opts.dry_run) {
      throw new Error("cleanup currently supports dry-run only. Pass --dry-run.");
    }

    const olderThanDays = cleanupNumberOption(opts["older-than-days"] || opts.older_than_days, 30, "--older-than-days");
    const keepLast = cleanupNumberOption(opts["keep-last"] || opts.keep_last, 200, "--keep-last");
    const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const tasks = (await listTasks(config)).sort((a, b) => taskTimestampMs(b) - taskTimestampMs(a));
    const candidates = [];

    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const reasons = [];
      const updatedMs = taskTimestampMs(task);
      if (olderThanDays > 0 && updatedMs > 0 && updatedMs < cutoffMs) {
        reasons.push(`older_than_${olderThanDays}d`);
      }
      if (keepLast > 0 && index >= keepLast) {
        reasons.push(`beyond_keep_last_${keepLast}`);
      }
      if (reasons.length) {
        candidates.push({ task, reasons });
      }
    }

    console.log("cleanup dry-run only; no files were moved or deleted.");
    console.log(`tasks_scanned=${tasks.length}`);
    console.log(`candidates=${candidates.length}`);
    console.log(`archive_dir=${path.join(config.__stateDir, "archive")}`);
    for (const item of candidates) {
      const task = item.task;
      console.log([
        task.task_id,
        `status=${task.status}`,
        `project=${task.project}`,
        `updated_at=${task.updated_at || "-"}`,
        `reason=${item.reasons.join(",")}`
      ].join("  "));
    }
  }

  function parseExternalMessage(text) {
    const trimmed = String(text || "").trim();
    const prefix = trimmed.startsWith("/codex ") ? "/codex " : trimmed.startsWith("@codex ") ? "@codex " : null;
    if (!prefix) {
      throw new Error("Message must start with /codex or @codex.");
    }
    const body = trimmed.slice(prefix.length).trim();
    const parts = body.split(/\s+/);
    const command = parts.shift();
    if (!command) {
      throw new Error("Missing /codex command.");
    }
    const kv = {};
    const rest = [];
    for (const part of parts) {
      if (!rest.length) {
        const eq = part.indexOf("=");
        if (eq > 0) {
          kv[part.slice(0, eq)] = part.slice(eq + 1);
          continue;
        }
        if (part === "--dry-run") {
          kv.dry_run = "true";
          continue;
        }
      }
      rest.push(part);
    }
    return {
      command,
      kv,
      rest
    };
  }

  async function commandMessage(argv) {
    const opts = parseArgv(argv);
    const config = await loadConfig(opts);
    const user = String(opts.user || safeUsername());
    validateUser(config, user);
    const message = opts._.join(" ").trim();
    if (!message) {
      throw new Error("message requires text, for example: \"/codex status\"");
    }
    const parsed = parseExternalMessage(message);
    if (parsed.command === "run") {
      const task = await createTask(config, {
        user,
        project: parsed.kv.project,
        prompt: parsed.rest.join(" "),
        dryRun: parsed.kv.dry_run === "true" || parsed.kv.dryRun === "true",
        dryRunStepMs: parsed.kv.dry_run_step_ms || parsed.kv.dryRunStepMs,
        referenceTaskId: parsed.kv.reference_task_id || parsed.kv.referenceTaskId || parsed.kv.reference,
        source: "message",
        receivedText: message
      });
      console.log(`外部消息已转换成任务: ${task.task_id}`);
      console.log(`状态: ${task.status}`);
      return;
    }

    if (parsed.command === "status") {
      await commandStatus(forwardConfigArgs(opts, parsed.rest));
      return;
    }

    if (parsed.command === "logs") {
      await commandLogs(forwardConfigArgs(opts, parsed.rest));
      return;
    }

    if (parsed.command === "result") {
      await commandResult(forwardConfigArgs(opts, parsed.rest));
      return;
    }

    if (parsed.command === "cancel") {
      await commandCancel(forwardConfigArgs(opts, parsed.rest));
      return;
    }

    throw new Error(`Unsupported /codex command: ${parsed.command}`);
  }

  function forwardConfigArgs(opts, rest) {
    const forwarded = [];
    if (opts.config) {
      forwarded.push("--config", String(opts.config));
    }
    if (opts["state-dir"]) {
      forwarded.push("--state-dir", String(opts["state-dir"]));
    }
    return forwarded.concat(rest);
  }

  const handlers = {
    run: commandRun,
    status: commandStatus,
    logs: commandLogs,
    result: commandResult,
    cancel: commandCancel,
    reconcile: commandReconcile,
    cleanup: commandCleanup,
    message: commandMessage
  };

  function isUserCommand(command) {
    return Object.prototype.hasOwnProperty.call(handlers, command);
  }

  async function dispatchUserCommand(command, argv) {
    const handler = handlers[command];
    if (!handler) {
      throw new Error(`Unknown command: ${command}`);
    }
    await handler(argv);
  }

  return {
    commandRun,
    commandStatus,
    commandLogs,
    commandResult,
    commandCancel,
    commandReconcile,
    commandCleanup,
    commandMessage,
    dispatchUserCommand,
    isUserCommand
  };
}

module.exports = {
  createCommandRuntime
};
