"use strict";

function createTaskRunnerRuntime(deps) {
  const {
    fs,
    fsp,
    cp,
    entryScript,
    repoRoot,
    loadConfig,
    assertTaskId,
    readTask,
    patchTask,
    transitionTask,
    appendTaskLog,
    activeTaskCount,
    sleep,
    nowIso,
    isoAfterSeconds,
    sandboxForMode,
    workspaceWriteRuntime,
    taskOutputRuntime,
    FINAL_STATUSES,
    taskWorkerLooksAlive,
    reconcileTask,
    terminateTaskProcessGroup,
    writeResultIfEmpty
  } = deps;

  function spawnWorker(config, id) {
    const args = [entryScript, "__worker", id];
    if (config.__configPath) {
      args.push("--config", config.__configPath);
    }
    if (process.env.CODEX_BRIDGE_STATE_DIR) {
      args.push("--state-dir", config.__stateDir);
    }
    const child = cp.spawn(process.execPath, args, {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: Object.assign({}, process.env, {
        CUDA_VISIBLE_DEVICES: ""
      })
    });
    child.unref();
    return child;
  }

  function spawnTaskWatchdog(config, id) {
    const args = [entryScript, "__watchdog", id];
    if (config.__configPath) {
      args.push("--config", config.__configPath);
    }
    if (process.env.CODEX_BRIDGE_STATE_DIR) {
      args.push("--state-dir", config.__stateDir);
    }
    const child = cp.spawn(process.execPath, args, {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: Object.assign({}, process.env, {
        CUDA_VISIBLE_DEVICES: ""
      })
    });
    child.unref();
    return child;
  }

  async function waitForSlot(config, task) {
    while (await activeTaskCount(config, task.task_id) >= config.maxConcurrent) {
      const fresh = await readTask(config, task.task_id);
      if (fresh.status === "cancel_requested" || fresh.status === "cancelling" || fresh.status === "cancelled") {
        return false;
      }
      await appendTaskLog(config, task, "waiting for concurrency slot");
      await sleep(1000);
    }
    return true;
  }

  async function workerMain(taskIdValue, opts) {
    let config;
    let task;
    let failed = false;

    async function markWorkerFailed(error) {
      if (failed || !config || !task) {
        return;
      }
      failed = true;
      const message = error && error.stack ? error.stack : error && error.message ? error.message : String(error);
      await fsp.writeFile(task.result_file, `Bridge worker failed before completion:\n\n${message}\n`, "utf8").catch(() => {});
      const failedTask = await transitionTask(config, task.task_id, {
        expectedStatuses: ["queued", "running", "cancel_requested", "cancelling"],
        nextStatus: "failed",
        patch: {
        ended_at: nowIso(),
        finished_at: nowIso(),
        error: message
        }
      }).catch(() => {});
      if (failedTask && failedTask.__transition && failedTask.__transition.applied) {
        await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, failedTask, "worker_failed").catch(() => {});
      }
      await appendTaskLog(config, failedTask || task, `worker failed: ${message.split("\n")[0]}`).catch(() => {});
    }

    process.once("uncaughtException", (error) => {
      markWorkerFailed(error).finally(() => process.exit(1));
    });
    process.once("unhandledRejection", (error) => {
      markWorkerFailed(error).finally(() => process.exit(1));
    });

    try {
      config = await loadConfig(opts);
      task = await readTask(config, taskIdValue);
      if (!(await waitForSlot(config, task))) {
        const cancelled = await transitionTask(config, task.task_id, {
          expectedStatuses: ["queued", "cancel_requested", "cancelling", "cancelled"],
          nextStatus: "cancelled",
          patch: {
          ended_at: nowIso(),
          finished_at: nowIso(),
          termination_reason: "cancelled"
          }
        });
        if (cancelled.__transition && cancelled.__transition.applied) {
          await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancelled_before_start");
          await appendTaskLog(config, cancelled, "cancelled before start");
        }
        return;
      }

      if (task.mode === "workspace-write") {
        const locked = await workspaceWriteRuntime.acquireWorkspaceWriteLock(config, task);
        if (!locked) {
          const cancelled = await transitionTask(config, task.task_id, {
            expectedStatuses: ["queued", "cancel_requested", "cancelling", "cancelled"],
            nextStatus: "cancelled",
            patch: {
            ended_at: nowIso(),
            finished_at: nowIso(),
            termination_reason: "cancelled"
            }
          });
          if (cancelled.__transition && cancelled.__transition.applied) {
            await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancelled_before_lock");
            await appendTaskLog(config, cancelled, "cancelled before acquiring workspace-write lock");
          }
          return;
        }
        const isolated = await workspaceWriteRuntime.prepareWorkspaceWriteExecution(config, locked);
        task = await workspaceWriteRuntime.beginWriteAudit(config, isolated);
      }

      const started = await transitionTask(config, task.task_id, {
        expectedStatuses: ["queued"],
        nextStatus: "running",
        patch: {
        pid: process.pid,
        pgid: process.pid,
        started_at: nowIso(),
        deadline_at: isoAfterSeconds(config.timeoutSeconds),
        timeout_seconds: config.timeoutSeconds
        }
      });
      if (!started.__transition || !started.__transition.applied) {
        if (started.status === "cancelling" || started.status === "cancel_requested") {
          const cancelled = await transitionTask(config, task.task_id, {
            expectedStatuses: ["cancelling", "cancel_requested"],
            nextStatus: "cancelled",
            patch: {
              ended_at: nowIso(),
              finished_at: nowIso(),
              termination_reason: "cancelled"
            }
          });
          if (cancelled.__transition && cancelled.__transition.applied) {
            await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancelled_before_running");
            await appendTaskLog(config, cancelled, "cancelled before worker could start");
          }
        }
        return;
      }
      task = started;
      await appendTaskLog(config, started, `started worker pid=${process.pid}`);

      if (started.dry_run) {
        await runDryTask(config, started);
      } else {
        await runCodexTask(config, started);
      }
      const finalTask = await readTask(config, task.task_id).catch(() => started);
      if (FINAL_STATUSES.has(finalTask.status)) {
        await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, finalTask, "worker_finished");
      }
    } catch (error) {
      await markWorkerFailed(error);
      process.exitCode = 1;
    }
  }

  async function lifecycleWatchdogMain(taskIdValue, opts) {
    const config = await loadConfig(opts);
    assertTaskId(taskIdValue);
    while (true) {
      const task = await readTask(config, taskIdValue).catch(() => null);
      if (!task || FINAL_STATUSES.has(task.status)) {
        return;
      }
      const reconciled = await reconcileTask(config, task);
      if (!reconciled || FINAL_STATUSES.has(reconciled.status)) {
        return;
      }
      await sleep(config.watchdogIntervalMs);
    }
  }

  async function wasCancelRequested(config, task) {
    const fresh = await readTask(config, task.task_id);
    return fresh.status === "cancel_requested" || fresh.status === "cancelling" || fresh.status === "cancelled";
  }

  function shellQuote(value) {
    const text = String(value);
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
      return text;
    }
    return `'${text.replace(/'/g, "'\\''")}'`;
  }

  async function runDryTask(config, task) {
    const stepMs = Math.max(50, Number(task.dry_run_step_ms || config.dryRunStepMs));
    const steps = [
      "parsed external command",
      `validated user=${task.user}`,
      `validated project=${task.project}`,
      `created ${task.mode} Codex runner plan`,
      "captured simulated Codex events",
      "wrote final result"
    ];
    for (const step of steps) {
      if (await wasCancelRequested(config, task)) {
        await fsp.writeFile(task.result_file, `Task ${task.task_id} was cancelled before completion.\n`, "utf8");
        const cancelled = await transitionTask(config, task.task_id, {
          expectedStatuses: ["running", "cancel_requested", "cancelling", "cancelled"],
          nextStatus: "cancelled",
          patch: {
          ended_at: nowIso(),
          finished_at: nowIso(),
          termination_reason: "cancelled"
          }
        });
        await taskOutputRuntime.ensureSafeResult(config, cancelled);
        if (cancelled.__transition && cancelled.__transition.applied) {
          await appendTaskLog(config, task, "cancelled during dry-run");
        }
        return;
      }
      const event = {
        time: nowIso(),
        type: "dry_run_step",
        message: step
      };
      await fsp.appendFile(task.stdout_file, `${JSON.stringify(event)}\n`, "utf8");
      await appendTaskLog(config, task, step);
      await sleep(stepMs);
    }

    const result = [
      `# Codex-Bridge Dry Run Result`,
      ``,
      `Task: ${task.task_id}`,
      `Project: ${task.project}`,
      `User: ${task.user}`,
      `Mode: ${task.mode}`,
      task.reference_task_id ? `Reference Task: ${task.reference_task_id}` : null,
      ``,
      `This was a safe simulation. A real run would execute:`,
      ``,
      "```bash",
      `${config.codexBin} --ask-for-approval never exec --json --sandbox ${sandboxForMode(task.mode)} --cd ${shellQuote(workspaceWriteRuntime.taskExecutionProjectPath(task))} --skip-git-repo-check --output-last-message ${shellQuote(task.result_file)} ${shellQuote(task.prompt)}`,
      "```",
      ``,
      `Prompt: ${task.prompt}`,
      task.execution_strategy === "git_worktree" ? `Execution isolation: git worktree snapshot at ${task.worktree_head || "HEAD"}` : null,
      task.reference_task_id ? `` : null,
      task.reference_task_id ? `A real run would prepend safe context from ${task.reference_task_id}.` : null,
      ``,
      `Prototype takeaway: external text became a whitelisted, logged, queryable task.`
    ].filter((line) => line !== null).join("\n");
    await fsp.writeFile(task.result_file, `${result}\n`, "utf8");
    const done = await transitionTask(config, task.task_id, {
      expectedStatuses: ["running"],
      nextStatus: "done",
      patch: {
      ended_at: nowIso(),
      finished_at: nowIso(),
      exit_code: 0
      }
    });
    await taskOutputRuntime.ensureSafeResult(config, done);
    if (done.__transition && done.__transition.applied) {
      await appendTaskLog(config, task, "done dry-run");
    }
  }

  async function timeoutTask(config, task) {
    const fresh = await readTask(config, task.task_id);
    if (FINAL_STATUSES.has(fresh.status)) {
      return fresh;
    }
    if (!["running", "cancel_requested"].includes(fresh.status)) {
      return fresh;
    }

    const now = nowIso();
    const timedOut = await transitionTask(config, fresh.task_id, {
      expectedStatuses: ["running", "cancel_requested"],
      nextStatus: "timeout",
      patch: {
      timeout_at: now,
      ended_at: now,
      finished_at: now,
      termination_reason: "timeout"
      }
    });
    if (!timedOut.__transition || !timedOut.__transition.applied) {
      return timedOut;
    }
    await appendTaskLog(config, timedOut, `timeout reached deadline_at=${fresh.deadline_at || "-"}`);
    const termination = await terminateTaskProcessGroup(config, timedOut, "timeout");
    const finalTask = await patchTask(config, fresh.task_id, {
      timeout_at: now,
      ended_at: now,
      finished_at: now,
      termination_reason: "timeout",
      exit_signal: termination.signal
    });
    await writeResultIfEmpty(finalTask, `Task ${fresh.task_id} timed out after ${fresh.timeout_seconds || config.timeoutSeconds}s.\n`);
    await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, finalTask, "timeout");
    await appendTaskLog(config, finalTask, "timeout completed");
    return finalTask;
  }

  async function runCodexTask(config, task) {
    const effectivePrompt = await taskOutputRuntime.effectivePromptForTask(config, task);
    const args = [
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      sandboxForMode(task.mode),
      "--cd",
      workspaceWriteRuntime.taskExecutionProjectPath(task),
      "--skip-git-repo-check",
      "--output-last-message",
      task.result_file,
      effectivePrompt
    ];

    const logArgs = args.slice(0, -1).concat([`<prompt:${effectivePrompt.length} chars>`]);
    await appendTaskLog(config, task, `spawning ${config.codexBin} ${logArgs.map(shellQuote).join(" ")}`);
    const out = fs.openSync(task.stdout_file, "a");
    const err = fs.openSync(task.stderr_file, "a");
    const protectedPathGuard = task.mode === "workspace-write" ? workspaceWriteRuntime.startProtectedPathGuard(config, task) : null;

    let closed = false;
    function closeFiles() {
      if (closed) {
        return;
      }
      closed = true;
      fs.closeSync(out);
      fs.closeSync(err);
    }

    const child = cp.spawn(config.codexBin, args, {
      cwd: workspaceWriteRuntime.taskExecutionProjectPath(task),
      stdio: ["ignore", out, err],
      env: Object.assign({}, process.env, {
        CUDA_VISIBLE_DEVICES: ""
      })
    });

    await new Promise(async (resolve) => {
      let settled = false;

      async function finish(patch, logLine) {
        if (settled) {
          return;
        }
        settled = true;
        if (protectedPathGuard) {
          protectedPathGuard.stop();
        }
        closeFiles();
        const updated = await transitionTask(config, task.task_id, patch);
        if (FINAL_STATUSES.has(updated.status)) {
          await taskOutputRuntime.ensureSafeResult(config, updated).catch(() => {});
        }
        await appendTaskLog(config, task, logLine);
        resolve();
      }

      child.once("error", async (error) => {
        await fsp.writeFile(task.result_file, `Codex runner failed: ${error.message}\n`, "utf8").catch(() => {});
        await finish({
          expectedStatuses: ["running", "cancel_requested", "cancelling"],
          nextStatus: "failed",
          patch: {
          ended_at: nowIso(),
          finished_at: nowIso(),
          error: error.message
          }
        }, `codex spawn failed: ${error.message}`);
      });

      child.once("exit", async (code, signal) => {
        const fresh = await readTask(config, task.task_id);
        if (FINAL_STATUSES.has(fresh.status)) {
          if (protectedPathGuard) {
            protectedPathGuard.stop();
          }
          closeFiles();
          resolve();
          return;
        }
        const cancelled = fresh.status === "cancel_requested" || fresh.status === "cancelling";
        await finish({
          expectedStatuses: ["running", "cancel_requested", "cancelling"],
          nextStatus: cancelled ? "cancelled" : code === 0 && !signal ? "done" : "failed",
          patch: {
          ended_at: nowIso(),
          finished_at: nowIso(),
          exit_code: code,
          exit_signal: signal || null,
          termination_reason: cancelled ? "cancelled" : signal ? "signal" : null
          }
        }, `codex exited code=${code} signal=${signal || ""}`);
      });

      await patchTask(config, task.task_id, {
        child_pid: child.pid || null
      });
      await appendTaskLog(config, task, `codex child pid=${child.pid || "unknown"}`);
    });
  }

  return {
    spawnWorker,
    spawnTaskWatchdog,
    workerMain,
    lifecycleWatchdogMain,
    timeoutTask
  };
}

module.exports = {
  createTaskRunnerRuntime
};
