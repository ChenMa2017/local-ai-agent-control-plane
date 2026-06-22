#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const bridgeScript = path.join(repoRoot, "scripts", "codex-bridge.js");
const OPENAI_KEY_FIXTURE = `sk-${"d".repeat(32)}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runBridge(args, options = {}) {
  const result = cp.spawnSync(process.execPath, [bridgeScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: Object.assign({}, process.env, options.env || {})
  });
  if (!options.expectFailure) {
    assert.strictEqual(result.status, 0, `command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function parseTaskId(output) {
  const match = String(output).match(/queued\s+(task_[A-Za-z0-9_.-]+)/);
  assert(match, `missing queued task id in output:\n${output}`);
  return match[1];
}

function makeFixture(name, extraConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-bridge-${name}-`));
  const project = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const fakeCodex = path.join(root, "fake-codex.js");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# Test Project\n");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--output-last-message");
const resultFile = outIndex >= 0 ? args[outIndex + 1] : "";
const ms = Number(process.env.FAKE_CODEX_SLEEP_MS || "10000");
const writeDelayMs = Number(process.env.FAKE_CODEX_WRITE_DELAY_MS || "0");
const termExitDelayMs = Number(process.env.FAKE_CODEX_TERM_EXIT_DELAY_MS || "0");
const termExitCode = Number(process.env.FAKE_CODEX_TERM_EXIT_CODE || "1");
let finished = false;
if (process.env.FAKE_CODEX_CAPTURE_PROMPT_FILE) {
  fs.writeFileSync(process.env.FAKE_CODEX_CAPTURE_PROMPT_FILE, args[args.length - 1] || "");
}
function writeWorkspaceFile() {
  if (!process.env.FAKE_CODEX_WRITE_FILE) {
    return;
  }
  const target = path.resolve(process.cwd(), process.env.FAKE_CODEX_WRITE_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, process.env.FAKE_CODEX_WRITE_CONTENT || "fake write\\n");
}
if (process.env.FAKE_CODEX_WRITE_FILE) {
  if (writeDelayMs > 0) {
    setTimeout(writeWorkspaceFile, writeDelayMs);
  } else {
    writeWorkspaceFile();
  }
}
function finish(code, options = {}) {
  if (finished) {
    return;
  }
  finished = true;
  if (resultFile && options.writeResult !== false) {
    fs.writeFileSync(resultFile, "fake codex done\\n");
  }
  process.exit(code);
}
const timer = setTimeout(() => finish(0), ms);
process.on("SIGTERM", () => {
  clearTimeout(timer);
  setTimeout(() => finish(termExitCode, { writeResult: false }), termExitDelayMs);
});
`);
  fs.chmodSync(fakeCodex, 0o755);
  const config = Object.assign({
    version: 1,
    users: ["tester"],
    projects: {
      self: {
        path: project,
        mode: "readonly"
      }
    },
    stateDir,
    codexBin: fakeCodex,
    maxConcurrent: 1,
    timeoutSeconds: 20,
    cancelGraceMs: 200,
    watchdogIntervalMs: 100,
    dryRunStepMs: 50
  }, extraConfig);
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { root, project, stateDir, configPath };
}

function runGitLocal(cwd, args) {
  const result = cp.spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  assert.strictEqual(result.status, 0, `git command failed\ncwd=${cwd}\nargs=${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function makeGitFixture(name, extraConfig = {}) {
  const fixture = makeFixture(name, extraConfig);
  runGitLocal(fixture.project, ["init"]);
  runGitLocal(fixture.project, ["config", "user.name", "Test User"]);
  runGitLocal(fixture.project, ["config", "user.email", "test@example.com"]);
  runGitLocal(fixture.project, ["add", "README.md"]);
  runGitLocal(fixture.project, ["commit", "-m", "initial"]);
  return fixture;
}

function taskFile(fixture, id) {
  return path.join(fixture.stateDir, "tasks", id, "task.json");
}

function readTask(fixture, id) {
  return JSON.parse(fs.readFileSync(taskFile(fixture, id), "utf8"));
}

async function waitForTask(fixture, id, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let task = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(taskFile(fixture, id))) {
      task = readTask(fixture, id);
      if (predicate(task)) {
        return task;
      }
    }
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${label}; last task=${JSON.stringify(task, null, 2)}`);
}

function processGroupAlive(pgid) {
  try {
    process.kill(-Number(pgid), 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

async function testRunningTaskCanBeCancelled() {
  const fixture = makeFixture("cancel");
  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "slow task"], {
    env: { FAKE_CODEX_SLEEP_MS: "60000" }
  });
  const id = parseTaskId(run.stdout);
  const running = await waitForTask(fixture, id, (task) => task.status === "running", "running");
  assert(running.pid);
  assert(running.pgid);

  const cancelledOutput = runBridge(["cancel", "--config", fixture.configPath, id]).stdout;
  assert(cancelledOutput.includes("cancelled"));
  const cancelled = await waitForTask(fixture, id, (task) => task.status === "cancelled", "cancelled");
  assert.strictEqual(cancelled.termination_reason, "cancelled");
  assert(cancelled.cancel_requested_at);
  assert(cancelled.finished_at);
  runBridge(["reconcile", "--config", fixture.configPath]);
  assert.strictEqual(readTask(fixture, id).status, "cancelled");

  const groupDeadline = Date.now() + 4000;
  while (Date.now() < groupDeadline && processGroupAlive(running.pgid)) {
    await sleep(100);
  }
  assert(!processGroupAlive(running.pgid), `process group ${running.pgid} should be gone after cancel`);
}

async function testTimeoutTerminatesTask() {
  const fixture = makeFixture("timeout", { timeoutSeconds: 1 });
  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "timeout task"], {
    env: { FAKE_CODEX_SLEEP_MS: "60000" }
  });
  const id = parseTaskId(run.stdout);
  const timedOut = await waitForTask(fixture, id, (task) => task.status === "timeout", "timeout", 8000);
  assert.strictEqual(timedOut.termination_reason, "timeout");
  assert(timedOut.finished_at);
  assert(timedOut.deadline_at);
}

async function testWorkspaceWriteTimeoutWinsAgainstChildExit() {
  const fixture = makeGitFixture("write-timeout-race", {
    timeoutSeconds: 1,
    watchdogIntervalMs: 50,
    cancelGraceMs: 100
  });
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "timeout write"], {
    env: {
      FAKE_CODEX_SLEEP_MS: "60000",
      FAKE_CODEX_TERM_EXIT_DELAY_MS: "25",
      FAKE_CODEX_TERM_EXIT_CODE: "1",
      FAKE_CODEX_WRITE_FILE: "NOTES.md",
      FAKE_CODEX_WRITE_CONTENT: "# Timeout Notes\\n"
    }
  });
  const id = parseTaskId(run.stdout);
  const timedOut = await waitForTask(
    fixture,
    id,
    (task) => task.status === "timeout" && task.worktree_cleanup_status === "removed" && Boolean(task.write_audit_completed_at),
    "workspace-write timeout",
    12000
  );

  assert.strictEqual(timedOut.termination_reason, "timeout");
  assert.strictEqual(timedOut.worktree_cleanup_status, "removed");
  assert.strictEqual(timedOut.changed_files_count, 1);
  assert.strictEqual(fs.existsSync(timedOut.worktree_path), false);

  const result = fs.readFileSync(timedOut.safe_result_file, "utf8");
  const writeSummaryCount = (result.match(/## Write Summary/g) || []).length;
  assert.strictEqual(writeSummaryCount, 1, result);

  const bridgeLog = fs.readFileSync(path.join(fixture.stateDir, "tasks", id, "bridge.log"), "utf8");
  const auditCompletedCount = (bridgeLog.match(/write audit completed/g) || []).length;
  const finalizedCount = (bridgeLog.match(/finalized workspace-write task status=timeout/g) || []).length;
  assert.strictEqual(auditCompletedCount, 1, bridgeLog);
  assert.strictEqual(finalizedCount, 1, bridgeLog);
}

async function testFinalizingOwnerAlivePreventsStaleReconcile() {
  const fixture = makeFixture("finalizing-owner");
  const owner = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    cwd: repoRoot,
    stdio: "ignore"
  });
  owner.unref();

  try {
    const id = "task_20260622_120000_owner01";
    const dir = path.join(fixture.stateDir, "tasks", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "result.md"), "pending finalization\n");
    fs.writeFileSync(path.join(dir, "task.json"), `${JSON.stringify({
      version: 1,
      task_id: id,
      status: "finalizing",
      user: "tester",
      project: "self",
      project_path: fixture.project,
      mode: "workspace-write",
      prompt: "owner-aware reconcile",
      dry_run: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60000).toISOString(),
      timeout_seconds: 60,
      pid: 999999999,
      pgid: 999999999,
      child_pid: null,
      finalization_owner_pid: owner.pid,
      finalization_target_status: "timeout",
      finalization_requested_at: new Date().toISOString(),
      result_file: path.join(dir, "result.md"),
      stdout_file: path.join(dir, "stdout.jsonl"),
      stderr_file: path.join(dir, "stderr.log"),
      bridge_log_file: path.join(dir, "bridge.log")
    }, null, 2)}\n`);

    runBridge(["status", "--config", fixture.configPath, id]);
    const stillFinalizing = readTask(fixture, id);
    assert.strictEqual(stillFinalizing.status, "finalizing");
    assert.strictEqual(stillFinalizing.finalization_target_status, "timeout");

    try {
      process.kill(owner.pid, "SIGTERM");
    } catch (_error) {
      // Ignore if the helper process has already exited.
    }
    await sleep(250);

    runBridge(["reconcile", "--config", fixture.configPath]);
    const stale = await waitForTask(fixture, id, (task) => task.status === "stale", "stale finalizing recovery", 4000);
    assert.strictEqual(stale.termination_reason, "stale");
  } finally {
    try {
      process.kill(owner.pid, "SIGKILL");
    } catch (_error) {
      // Ignore if already gone.
    }
  }
}

async function testDoneTaskCannotBeCancelled() {
  const fixture = makeFixture("done");
  const run = runBridge([
    "run",
    "--config",
    fixture.configPath,
    "--project",
    "self",
    "--user",
    "tester",
    "--dry-run",
    "--dry-run-step-ms",
    "50",
    "quick task"
  ]);
  const id = parseTaskId(run.stdout);
  await waitForTask(fixture, id, (task) => task.status === "done", "done");
  const cancelled = runBridge(["cancel", "--config", fixture.configPath, id], { expectFailure: true });
  assert.notStrictEqual(cancelled.status, 0);
  assert(cancelled.stderr.includes("already finished"));
  assert.strictEqual(readTask(fixture, id).status, "done");
}

async function testStaleTaskReconciles() {
  const fixture = makeFixture("stale");
  const id = "task_20260523_120000_stale1";
  const dir = path.join(fixture.stateDir, "tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), `${JSON.stringify({
    version: 1,
    task_id: id,
    status: "running",
    user: "tester",
    project: "self",
    project_path: fixture.project,
    mode: "readonly",
    prompt: "stale task",
    dry_run: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ended_at: null,
    finished_at: null,
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    timeout_seconds: 60,
    pid: 999999999,
    pgid: 999999999,
    child_pid: null,
    exit_code: null,
    result_file: path.join(dir, "result.md"),
    stdout_file: path.join(dir, "stdout.jsonl"),
    stderr_file: path.join(dir, "stderr.log"),
    bridge_log_file: path.join(dir, "bridge.log")
  }, null, 2)}\n`);
  runBridge(["reconcile", "--config", fixture.configPath]);
  const stale = readTask(fixture, id);
  assert.strictEqual(stale.status, "stale");
  assert.strictEqual(stale.termination_reason, "stale");
}

async function testAdapterMetadataAndIdempotency() {
  const fixture = makeFixture("adapter");
  const metadata = JSON.stringify({ client: "web-ui", view: "console" });
  const args = [
    "run",
    "--config",
    fixture.configPath,
    "--project",
    "self",
    "--user",
    "tester",
    "--dry-run",
    "--source",
    "web",
    "--source-user-id",
    "chenma",
    "--source-channel-id",
    "browser",
    "--source-message-id",
    "submit-1",
    "--idempotency-key",
    "web:test-key",
    "--metadata",
    metadata,
    "adapter task"
  ];
  const first = runBridge(args);
  const firstId = parseTaskId(first.stdout);
  const task = readTask(fixture, firstId);
  assert.strictEqual(task.source, "web");
  assert.strictEqual(task.source_user_id, "chenma");
  assert.strictEqual(task.source_channel_id, "browser");
  assert.strictEqual(task.source_message_id, "submit-1");
  assert.strictEqual(task.idempotency_key, "web:test-key");
  assert.deepStrictEqual(task.adapter_metadata, { client: "web-ui", view: "console" });

  const second = runBridge(args);
  const secondId = parseTaskId(second.stdout);
  assert.strictEqual(secondId, firstId);
  assert(second.stdout.includes("idempotent=true"));
  const taskDirs = fs.readdirSync(path.join(fixture.stateDir, "tasks")).filter((name) => name.startsWith("task_"));
  assert.strictEqual(taskDirs.length, 1);
}

async function testWorkspaceWriteModeUsesWorkspaceSandbox() {
  const fixture = makeFixture("write-mode");
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "write task"], {
    env: { FAKE_CODEX_SLEEP_MS: "10" }
  });
  const id = parseTaskId(run.stdout);
  const done = await waitForTask(
    fixture,
    id,
    (task) => task.status === "done" && Boolean(task.write_audit_completed_at),
    "done"
  );
  assert.strictEqual(done.mode, "workspace-write");
  const bridgeLog = fs.readFileSync(path.join(fixture.stateDir, "tasks", id, "bridge.log"), "utf8");
  assert(bridgeLog.includes("--sandbox workspace-write"), bridgeLog);
}

async function testWorkspaceWriteGeneratesAudit() {
  const fixture = makeFixture("write-audit");
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "write note"], {
    env: {
      FAKE_CODEX_SLEEP_MS: "10",
      FAKE_CODEX_WRITE_FILE: "NOTES.md",
      FAKE_CODEX_WRITE_CONTENT: "# Notes\\n"
    }
  });
  const id = parseTaskId(run.stdout);
  const done = await waitForTask(
    fixture,
    id,
    (task) => task.status === "done" && Boolean(task.write_audit_completed_at),
    "done"
  );
  const taskDir = path.join(fixture.stateDir, "tasks", id);
  assert.strictEqual(done.mode, "workspace-write");
  assert.strictEqual(done.changed_files_count, 1);
  assert.strictEqual(done.protected_path_violation, false);
  assert(fs.existsSync(path.join(taskDir, "write_audit.json")));
  assert(fs.existsSync(path.join(taskDir, "changed_files.safe.txt")));
  assert(fs.existsSync(path.join(taskDir, "diff_stat.safe.txt")));
  const result = fs.readFileSync(done.safe_result_file, "utf8");
  assert(result.includes("## Write Summary"), result);
  assert(result.includes("NOTES.md"), result);
}

async function testWorkspaceWriteUsesIsolatedGitWorktree() {
  const fixture = makeGitFixture("write-worktree");
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "isolated write"], {
    env: {
      FAKE_CODEX_SLEEP_MS: "10",
      FAKE_CODEX_WRITE_FILE: "NOTES.md",
      FAKE_CODEX_WRITE_CONTENT: "# Isolated Notes\\n"
    }
  });
  const id = parseTaskId(run.stdout);
  const done = await waitForTask(
    fixture,
    id,
    (task) => task.status === "done" && task.worktree_cleanup_status === "removed",
    "done"
  );

  assert.strictEqual(done.execution_strategy, "git_worktree");
  assert.strictEqual(done.worktree_source_dirty, false);
  assert(done.worktree_head);
  assert.strictEqual(done.worktree_cleanup_status, "removed");
  assert.strictEqual(fs.existsSync(path.join(fixture.project, "NOTES.md")), false);
  assert.strictEqual(fs.existsSync(done.worktree_path), false);
  assert.strictEqual(done.changed_files_count, 1);

  const originalStatus = runGitLocal(fixture.project, ["status", "--porcelain"]).stdout.trim();
  assert.strictEqual(originalStatus, "");
}

async function testProtectedPathViolationIsDetected() {
  const fixture = makeFixture("protected-path");
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "write env"], {
    env: {
      FAKE_CODEX_SLEEP_MS: "10",
      FAKE_CODEX_WRITE_FILE: ".env",
      FAKE_CODEX_WRITE_CONTENT: "SECRET_TOKEN=should-not-leak\\n"
    }
  });
  const id = parseTaskId(run.stdout);
  const violation = await waitForTask(
    fixture,
    id,
    (task) => task.status === "policy_violation" && Boolean(task.write_audit_completed_at),
    "policy_violation"
  );
  assert.strictEqual(violation.protected_path_violation, true);
  assert(Array.isArray(violation.protected_path_matches));
  assert(violation.protected_path_matches.some((item) => item.file === ".env"));
  const result = fs.readFileSync(violation.safe_result_file, "utf8");
  assert(result.includes("Protected path violation: yes"), result);
  assert(!result.includes("should-not-leak"), result);
}

async function testProtectedPathGuardStopsGitWorkspaceWriteEarly() {
  const fixture = makeGitFixture("protected-guard", {
    protectedPathWatchIntervalMs: 50,
    cancelGraceMs: 100
  });
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const run = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "write protected"], {
    env: {
      FAKE_CODEX_SLEEP_MS: "3000",
      FAKE_CODEX_WRITE_FILE: ".env",
      FAKE_CODEX_WRITE_CONTENT: "SECRET_TOKEN=guard-stop\\n"
    }
  });
  const id = parseTaskId(run.stdout);
  const violation = await waitForTask(
    fixture,
    id,
    (task) => task.status === "policy_violation" && task.worktree_cleanup_status === "removed",
    "policy_violation",
    12000
  );

  assert.strictEqual(violation.execution_strategy, "git_worktree");
  assert.strictEqual(violation.termination_reason, "policy_violation");
  assert.strictEqual(fs.existsSync(path.join(fixture.project, ".env")), false);
  assert.strictEqual(fs.existsSync(violation.worktree_path), false);
  const bridgeLog = fs.readFileSync(path.join(fixture.stateDir, "tasks", id, "bridge.log"), "utf8");
  assert(bridgeLog.includes("protected_path_guard triggered"), bridgeLog);
}

async function testWorkspaceWriteLockSerializesSameWorkspace() {
  const fixture = makeFixture("write-lock", { maxConcurrent: 2 });
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const first = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "first"], {
    env: { FAKE_CODEX_SLEEP_MS: "1200", FAKE_CODEX_WRITE_FILE: "first.txt" }
  });
  const firstId = parseTaskId(first.stdout);
  const firstRunning = await waitForTask(fixture, firstId, (task) => task.status === "running", "first running");
  assert(firstRunning.write_lock_id);

  const second = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "second"], {
    env: { FAKE_CODEX_SLEEP_MS: "10", FAKE_CODEX_WRITE_FILE: "second.txt" }
  });
  const secondId = parseTaskId(second.stdout);
  await sleep(400);
  const secondWaiting = readTask(fixture, secondId);
  assert.notStrictEqual(secondWaiting.status, "running", JSON.stringify(secondWaiting, null, 2));

  await waitForTask(fixture, firstId, (task) => task.status === "done", "first done", 6000);
  const secondDone = await waitForTask(fixture, secondId, (task) => task.status === "done", "second done", 6000);
  assert(secondDone.write_lock_id);
}

async function testNestedWorkspaceWriteLockSerializes() {
  const fixture = makeFixture("nested-lock", { maxConcurrent: 2 });
  const childProject = path.join(fixture.project, "child");
  fs.mkdirSync(childProject, { recursive: true });
  fs.writeFileSync(path.join(childProject, "README.md"), "# Child\\n");
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  config.projects.child = {
    path: childProject,
    mode: "workspace-write",
    allowedModes: ["workspace-write"]
  };
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const parent = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "parent"], {
    env: { FAKE_CODEX_SLEEP_MS: "1200", FAKE_CODEX_WRITE_FILE: "parent.txt" }
  });
  const parentId = parseTaskId(parent.stdout);
  await waitForTask(fixture, parentId, (task) => task.status === "running", "parent running");

  const child = runBridge(["run", "--config", fixture.configPath, "--project", "child", "--user", "tester", "child"], {
    env: { FAKE_CODEX_SLEEP_MS: "10", FAKE_CODEX_WRITE_FILE: "child.txt" }
  });
  const childId = parseTaskId(child.stdout);
  await sleep(400);
  const childWaiting = readTask(fixture, childId);
  assert.notStrictEqual(childWaiting.status, "running", JSON.stringify(childWaiting, null, 2));

  await waitForTask(fixture, parentId, (task) => task.status === "done", "parent done", 6000);
  await waitForTask(fixture, childId, (task) => task.status === "done", "child done", 6000);
}

async function testCancelReleasesWorkspaceWriteLock() {
  const fixture = makeFixture("cancel-lock", { maxConcurrent: 2 });
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.projects.self.mode = "workspace-write";
  config.projects.self.allowedModes = ["workspace-write"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const first = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "first"], {
    env: { FAKE_CODEX_SLEEP_MS: "60000", FAKE_CODEX_WRITE_FILE: "first.txt" }
  });
  const firstId = parseTaskId(first.stdout);
  await waitForTask(fixture, firstId, (task) => task.status === "running", "first running");
  runBridge(["cancel", "--config", fixture.configPath, firstId]);
  await waitForTask(fixture, firstId, (task) => task.status === "cancelled", "first cancelled");

  const second = runBridge(["run", "--config", fixture.configPath, "--project", "self", "--user", "tester", "second"], {
    env: { FAKE_CODEX_SLEEP_MS: "10", FAKE_CODEX_WRITE_FILE: "second.txt" }
  });
  const secondId = parseTaskId(second.stdout);
  await waitForTask(fixture, secondId, (task) => task.status === "done", "second done", 6000);
}

async function testReferenceTaskContextIsInjected() {
  const fixture = makeFixture("reference");
  const refId = "task_20260523_120000_ref001";
  const refDir = path.join(fixture.stateDir, "tasks", refId);
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(refDir, "task.json"), `${JSON.stringify({
    version: 1,
    task_id: refId,
    status: "done",
    user: "tester",
    project: "self",
    project_path: fixture.project,
    mode: "readonly",
    prompt: "summarize phase one",
    dry_run: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    deadline_at: null,
    timeout_seconds: 60,
    pid: null,
    pgid: null,
    child_pid: null,
    exit_code: 0,
    result_file: path.join(refDir, "result.md"),
    safe_result_file: path.join(refDir, "result.safe.md"),
    stdout_file: path.join(refDir, "stdout.jsonl"),
    stderr_file: path.join(refDir, "stderr.log"),
    safe_logs_file: path.join(refDir, "logs.safe.txt"),
    bridge_log_file: path.join(refDir, "bridge.log")
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(refDir, "result.md"), `raw ${fixture.project} token ${OPENAI_KEY_FIXTURE}\n`);
  fs.writeFileSync(path.join(refDir, "result.safe.md"), "prior safe result\n");

  const captureFile = path.join(fixture.root, "captured-prompt.txt");
  const run = runBridge([
    "run",
    "--config",
    fixture.configPath,
    "--project",
    "self",
    "--user",
    "tester",
    "--reference-task-id",
    refId,
    "continue from previous"
  ], {
    env: {
      FAKE_CODEX_SLEEP_MS: "10",
      FAKE_CODEX_CAPTURE_PROMPT_FILE: captureFile
    }
  });
  const id = parseTaskId(run.stdout);
  const done = await waitForTask(fixture, id, (task) => task.status === "done", "done");
  const captured = fs.readFileSync(captureFile, "utf8");

  assert.strictEqual(done.reference_task_id, refId);
  assert(captured.includes(`Reference task id: ${refId}`), captured);
  assert(captured.includes("prior safe result"), captured);
  assert(captured.includes("Current user request:"), captured);
  assert(captured.includes("continue from previous"), captured);
  assert(!captured.includes(OPENAI_KEY_FIXTURE), captured);
}

function writeFinishedTask(fixture, id, updatedAt) {
  const dir = path.join(fixture.stateDir, "tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), `${JSON.stringify({
    version: 1,
    task_id: id,
    status: "done",
    user: "tester",
    project: "self",
    project_path: fixture.project,
    mode: "readonly",
    prompt: "cleanup candidate",
    dry_run: false,
    created_at: updatedAt,
    updated_at: updatedAt,
    started_at: updatedAt,
    ended_at: updatedAt,
    finished_at: updatedAt,
    deadline_at: null,
    timeout_seconds: 60,
    pid: null,
    pgid: null,
    child_pid: null,
    exit_code: 0,
    result_file: path.join(dir, "result.md"),
    stdout_file: path.join(dir, "stdout.jsonl"),
    stderr_file: path.join(dir, "stderr.log"),
    bridge_log_file: path.join(dir, "bridge.log")
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "result.md"), "done\n");
}

function testCleanupDryRunDoesNotDeleteTasks() {
  const fixture = makeFixture("cleanup");
  writeFinishedTask(fixture, "task_20200101_000000_old001", "2020-01-01T00:00:00.000Z");
  writeFinishedTask(fixture, "task_20260523_120000_new001", "2026-05-23T12:00:00.000Z");

  const result = runBridge([
    "cleanup",
    "--config",
    fixture.configPath,
    "--dry-run",
    "--older-than-days",
    "1000",
    "--keep-last",
    "10"
  ]);

  assert(result.stdout.includes("cleanup dry-run only"));
  assert(result.stdout.includes("task_20200101_000000_old001"));
  assert(fs.existsSync(taskFile(fixture, "task_20200101_000000_old001")));
  assert(fs.existsSync(taskFile(fixture, "task_20260523_120000_new001")));
}

async function main() {
  await testRunningTaskCanBeCancelled();
  await testTimeoutTerminatesTask();
  await testWorkspaceWriteTimeoutWinsAgainstChildExit();
  await testFinalizingOwnerAlivePreventsStaleReconcile();
  await testDoneTaskCannotBeCancelled();
  await testStaleTaskReconciles();
  await testAdapterMetadataAndIdempotency();
  await testWorkspaceWriteModeUsesWorkspaceSandbox();
  await testWorkspaceWriteGeneratesAudit();
  await testWorkspaceWriteUsesIsolatedGitWorktree();
  await testProtectedPathViolationIsDetected();
  await testProtectedPathGuardStopsGitWorkspaceWriteEarly();
  await testWorkspaceWriteLockSerializesSameWorkspace();
  await testNestedWorkspaceWriteLockSerializes();
  await testCancelReleasesWorkspaceWriteLock();
  await testReferenceTaskContextIsInjected();
  testCleanupDryRunDoesNotDeleteTasks();
  console.log("lifecycle tests OK");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
