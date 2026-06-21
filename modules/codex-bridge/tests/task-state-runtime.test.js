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

function makeConfig(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-state-runtime-"));
  return Object.assign({
    __stateDir: path.join(root, "state")
  }, overrides);
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
  assert.strictEqual(result.__transition.accepted, false);
  assert.strictEqual(result.__transition.stateChanged, false);
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
  assert.strictEqual(done.__transition.accepted, true);
  assert.strictEqual(done.__transition.stateChanged, true);

  const cancelled = await runtime.transitionTask(config, id, {
    expectedStatuses: ["running", "cancelling"],
    nextStatus: "cancelled",
    patch: { termination_reason: "cancelled" }
  });
  assert.strictEqual(cancelled.status, "done");
  assert.strictEqual(cancelled.__transition.accepted, false);
  assert.strictEqual(cancelled.__transition.stateChanged, false);
  assert.strictEqual(cancelled.__transition.reason, "final_status_immutable");
}

async function testTransitionSameTargetDoesNotCountAsStateChange() {
  const runtime = makeRuntime();
  const config = makeConfig();
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "cancelled"));

  const cancelled = await runtime.transitionTask(config, id, {
    expectedStatuses: ["cancelled"],
    nextStatus: "cancelled",
    patch: { termination_reason: "cancelled" }
  });

  assert.strictEqual(cancelled.status, "cancelled");
  assert.strictEqual(cancelled.__transition.accepted, true);
  assert.strictEqual(cancelled.__transition.stateChanged, false);
  assert.strictEqual(cancelled.__transition.reason, "already_in_target_state");
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

  const appliedCount = [done, cancelled].filter((task) => task.__transition && task.__transition.stateChanged).length;
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

  const appliedCount = [cancelled, failed].filter((task) => task.__transition && task.__transition.stateChanged).length;
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

async function testPatchTaskRejectsStatusMutation() {
  const runtime = makeRuntime();
  const config = makeConfig();
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "queued"));

  await assert.rejects(
    runtime.patchTask(config, id, { status: "done" }),
    /task status must be changed through transitionTask/
  );
}

async function testPatchTaskReclaimsDeadStaleLock() {
  const runtime = makeRuntime();
  const config = makeConfig({
    taskLockTimeoutMs: 250,
    taskLockStaleMs: 50
  });
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "queued"));

  const lockDir = path.join(config.__stateDir, "tasks", id, ".task.lock");
  await fs.promises.mkdir(lockDir, { recursive: true });
  await fs.promises.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: 999999,
    task_id: id,
    operation: "patch_task",
    created_at: "2000-01-01T00:00:00.000Z"
  }, null, 2));

  const patched = await runtime.patchTask(config, id, {
    note: "stale lock recovered"
  });

  assert.strictEqual(patched.note, "stale lock recovered");
}

async function testPatchTaskDoesNotReclaimLiveLockOwner() {
  const runtime = makeRuntime();
  const config = makeConfig({
    taskLockTimeoutMs: 150,
    taskLockStaleMs: 50
  });
  const id = taskId();
  await runtime.writeTask(config, baseTask(config, id, "queued"));

  const lockDir = path.join(config.__stateDir, "tasks", id, ".task.lock");
  await fs.promises.mkdir(lockDir, { recursive: true });
  await fs.promises.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: process.pid,
    task_id: id,
    operation: "patch_task",
    created_at: "2000-01-01T00:00:00.000Z"
  }, null, 2));

  await assert.rejects(
    runtime.patchTask(config, id, { note: "should timeout" }),
    /Timed out waiting for task lock/
  );

  await fs.promises.rm(lockDir, { recursive: true, force: true });
}

async function main() {
  await testTransitionRejectsUnexpectedStatus();
  await testFinalStatusImmutableAgainstOverwrite();
  await testTransitionSameTargetDoesNotCountAsStateChange();
  await testConcurrentDoneVsCancelledOnlyOneWins();
  await testConcurrentCancelledVsFailedOnlyOneWins();
  await testPatchTaskAllowsMetadataOnFinalTask();
  await testPatchTaskRejectsStatusMutation();
  await testPatchTaskReclaimsDeadStaleLock();
  await testPatchTaskDoesNotReclaimLiveLockOwner();
  console.log("task state runtime tests OK");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
