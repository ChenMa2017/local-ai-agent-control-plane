#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const bridgeScript = path.join(repoRoot, "scripts", "codex-bridge.js");

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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-safe-output-"));
  const project = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const taskId = "task_20260523_120000_safe01";
  const taskDir = path.join(stateDir, "tasks", taskId);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });

  const config = {
    version: 1,
    users: ["tester"],
    projects: {
      self: {
        path: project,
        mode: "readonly"
      }
    },
    stateDir,
    codexBin: "codex",
    maxConcurrent: 1,
    timeoutSeconds: 30,
    redaction: {
      enabled: true,
      redactHomePath: true,
      redactProjectPaths: true,
      redactTokens: true,
      maxLogChars: 20000,
      maxResultChars: 80000
    }
  };
  const configPath = path.join(root, "config.json");
  const task = {
    version: 1,
    task_id: taskId,
    status: "done",
    user: "tester",
    project: "self",
    project_path: project,
    mode: "readonly",
    prompt: "safe output test",
    dry_run: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    deadline_at: null,
    timeout_seconds: 30,
    pid: null,
    pgid: null,
    child_pid: null,
    exit_code: 0,
    result_file: path.join(taskDir, "result.md"),
    safe_result_file: path.join(taskDir, "result.safe.md"),
    stdout_file: path.join(taskDir, "stdout.jsonl"),
    stderr_file: path.join(taskDir, "stderr.log"),
    safe_logs_file: path.join(taskDir, "logs.safe.txt"),
    bridge_log_file: path.join(taskDir, "bridge.log")
  };

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
  fs.writeFileSync(task.result_file, [
    "# Result",
    `Project path: ${project}/README.md`,
    `Home path: ${os.homedir()}/.config/example`,
    "Authorization: Bearer abc.def.secret-token",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "GitHub: ghp_abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "secret-key-material",
    "-----END OPENSSH PRIVATE KEY-----"
  ].join("\n"));
  fs.writeFileSync(task.bridge_log_file, [
    `[time] reading ${project}/README.md`,
    "[time] Authorization: Bearer abc.def.secret-token",
    `[time] ${"x".repeat(400)} sk-abcdefghijklmnopqrstuvwxyz123456`
  ].join("\n"));
  fs.writeFileSync(task.stdout_file, `{"message":"${project}/package.json"}\n`);
  fs.writeFileSync(task.stderr_file, "PASSWORD=super-secret-value\n");

  return { root, project, stateDir, configPath, taskId, taskDir };
}

function testSafeResultDefaultAndRawOverride() {
  const fixture = makeFixture();
  const safe = runBridge(["result", "--config", fixture.configPath, fixture.taskId]).stdout;
  assert(safe.includes("[workspace:self]/README.md"));
  assert(!safe.includes(fixture.project));
  assert(!safe.includes(os.homedir()));
  assert(!safe.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"));
  assert(!safe.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"));
  assert(!safe.includes("secret-key-material"));
  assert(safe.includes("[REDACTED_PRIVATE_KEY]"));
  assert(fs.existsSync(path.join(fixture.taskDir, "result.safe.md")));

  const raw = runBridge(["result", "--config", fixture.configPath, fixture.taskId, "--raw"]).stdout;
  assert(raw.includes(fixture.project));
  assert(raw.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"));
}

function testSafeResultJsonMetadata() {
  const fixture = makeFixture();
  const result = runBridge(["result", "--config", fixture.configPath, fixture.taskId, "--json-output"]).stdout;
  const data = JSON.parse(result);
  assert.strictEqual(data.raw, false);
  assert.strictEqual(data.redacted, true);
  assert.strictEqual(data.truncated, false);
  assert(data.text.includes("[workspace:self]"));
}

function testSafeLogsTailAndTruncation() {
  const fixture = makeFixture();
  const result = runBridge([
    "logs",
    "--config",
    fixture.configPath,
    fixture.taskId,
    "--json-output",
    "--tail",
    "20",
    "--max-chars",
    "180"
  ]).stdout;
  const data = JSON.parse(result);
  assert.strictEqual(data.raw, false);
  assert.strictEqual(data.redacted, true);
  assert.strictEqual(data.truncated, true);
  assert(data.lines_returned > 0);
  assert(!data.text.includes(fixture.project));
  assert(!data.text.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  assert(fs.existsSync(path.join(fixture.taskDir, "logs.safe.txt")));
}

function main() {
  testSafeResultDefaultAndRawOverride();
  testSafeResultJsonMetadata();
  testSafeLogsTailAndTruncation();
  console.log("safe output tests OK");
}

main();
