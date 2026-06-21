#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { createTaskStateRuntime } = require("../lib/task-state-runtime");

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRuntime() {
  return createTaskStateRuntime({
    fsp: fs.promises,
    path,
    crypto,
    nowIso,
    ensureDir: async (dir) => {
      await fs.promises.mkdir(dir, { recursive: true });
    },
    sleep,
    reconcileTask: async (_config, task) => task
  });
}

function makeConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-state-runtime-"));
  return {
    __stateDir: path.join(root, "state")
  };
}

let nextId = 0;
function taskId() {
  nextId += 1;
  return `task_20260621_120000_tstate${String(nextId).padStart(2, "0")}`;
}

function baseTask(config, id, status = "queued") {
  const dir = path.join(config.__stateDir, "tasks", id);
  return {
    version: 1,
    task_id: id,
    status,
    created_at: nowIso(),
    updated_at: nowIso(),
    result_file: path.join(dir, "result.md"),
    stdout_file: path.join(dir, "stdout.jsonl"),
    stderr_file: path.join(dir, "stderr.log"),
    bridge_log_file: path.join(dir, "bridge.log")
  };
}

async function testTransitionRejectsUnexpectedStatus() {
  const runtime = makeRuntime();
  const config = makeConfig();
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "queued"));

  const result = await runtime.transitionTask(config, id, {
    expectedStatuses: ["running"],
    nextStatus: "done",
    patch: { finished_at: nowIso() }
  });

  assert.strictEqual(result.status, "queued");
  assert(result.__transition);
  assert.strictEqual(result.__transition.applied, false);
  assert.strictEqual(result.__transition.reason, "unexpected_status");
}

async function testFinalStatusImmutableAgainstOverwrite() {
  const runtime = makeRuntime();
  const config = makeConfig();
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "running"));

  const done = await runtime.transitionTask(config, id, {
    expectedStatuses: ["running"],
    nextStatus: "done",
    patch: { finished_at: nowIso() }
  });
  assert.strictEqual(done.status, "done");
  assert.strictEqual(done.__transition.applied, true);

  const cancelled = await runtime.transitionTask(config, id, {
    expectedStatuses: ["running", "cancelling"],
    nextStatus: "cancelled",
    patch: { termination_reason: "cancelled" }
  });
  assert.strictEqual(cancelled.status, "done");
  assert.strictEqual(cancelled.__transition.applied, false);
  assert.strictEqual(cancelled.__transition.reason, "final_status_immutable");
}

async function testConcurrentDoneVsCancelledOnlyOneWins() {
  const runtime = makeRuntime();
  const config = makeConfig();
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "running"));

  const [done, cancelled] = await Promise.all([
    runtime.transitionTask(config, id, {
      expectedStatuses: ["running"],
      nextStatus: "done",
      patch: { finished_at: nowIso(), exit_code: 0 }
    }),
    runtime.transitionTask(config, id, {
      expectedStatuses: ["running"],
      nextStatus: "cancelled",
      patch: { finished_at: nowIso(), termination_reason: "cancelled" }
    })
  ]);

  const appliedCount = [done, cancelled].filter((task) => task.__transition && task.__transition.applied).length;
  assert.strictEqual(appliedCount, 1);
  const finalTask = await runtime.readTask(config, id);
  assert(["done", "cancelled"].includes(finalTask.status));
}

async function testConcurrentCancelledVsFailedOnlyOneWins() {
  const runtime = makeRuntime();
  const config = makeConfig();
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "running"));

  const [cancelled, failed] = await Promise.all([
    runtime.transitionTask(config, id, {
      expectedStatuses: ["running", "cancelling"],
      nextStatus: "cancelled",
      patch: { finished_at: nowIso(), termination_reason: "cancelled" }
    }),
    runtime.transitionTask(config, id, {
      expectedStatuses: ["running", "cancelling"],
      nextStatus: "failed",
      patch: { finished_at: nowIso(), error: "worker exception" }
    })
  ]);

  const appliedCount = [cancelled, failed].filter((task) => task.__transition && task.__transition.applied).length;
  assert.strictEqual(appliedCount, 1);
  const finalTask = await runtime.readTask(config, id);
  assert(["cancelled", "failed"].includes(finalTask.status));
}

async function testPatchTaskAllowsMetadataOnFinalTask() {
  const runtime = makeRuntime();
  const config = makeConfig();
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "done"));

  const patched = await runtime.patchTask(config, id, {
    exit_signal: "SIGTERM",
    safe_result_file: path.join(config.__stateDir, "safe.md")
  });

  assert.strictEqual(patched.status, "done");
  assert.strictEqual(patched.exit_signal, "SIGTERM");
  assert(patched.safe_result_file.endsWith("safe.md"));
}

async function main() {
  await testTransitionRejectsUnexpectedStatus();
  await testFinalStatusImmutableAgainstOverwrite();
  await testConcurrentDoneVsCancelledOnlyOneWins();
  await testConcurrentCancelledVsFailedOnlyOneWins();
  await testPatchTaskAllowsMetadataOnFinalTask();
  console.log("task state runtime tests OK");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
