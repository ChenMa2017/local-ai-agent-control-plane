#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");
const { createCommandRuntime } = require("../lib/command-runtime");
const { createProcessRuntime } = require("../lib/process-runtime");
const { createTaskOutputRuntime } = require("../lib/task-output-runtime");
const { createTaskRunnerRuntime } = require("../lib/task-runner-runtime");
const { createTaskStateRuntime } = require("../lib/task-state-runtime");
const { createWorkspaceWriteRuntime } = require("../lib/workspace-write-runtime");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CONFIG_NAME = "codex-bridge.config.json";
const DEFAULT_TASK_LIMIT = 20;
const DEFAULT_MAX_LOG_CHARS = 20000;
const DEFAULT_MAX_RESULT_CHARS = 80000;
const DEFAULT_REFERENCE_CONTEXT_CHARS = 12000;
const FINAL_STATUSES = new Set(["done", "failed", "cancelled", "timeout", "stale", "policy_violation"]);
const CANCELLABLE_STATUSES = new Set(["queued", "running", "cancelling", "cancel_requested"]);
const BOOLEAN_OPTIONS = new Set(["dry-run", "dry_run", "help", "raw", "json", "json-output"]);
const SUPPORTED_MODES = new Set(["readonly", "workspace-write"]);
const PROTECTED_PATH_PATTERNS = [
  { label: ".env", test: (file) => file === ".env" || file.endsWith("/.env") },
  { label: "secrets.env", test: (file) => file === "secrets.env" || file.endsWith("/secrets.env") },
  { label: "*.pem", test: (file) => file.endsWith(".pem") },
  { label: "*.key", test: (file) => file.endsWith(".key") },
  { label: ".git/", test: (file) => file === ".git" || file.startsWith(".git/") || file.includes("/.git/") },
  { label: ".codex-bridge/tasks/", test: (file) => file === ".codex-bridge/tasks" || file.startsWith(".codex-bridge/tasks/") || file.includes("/.codex-bridge/tasks/") },
  { label: "state/task_threads.json", test: (file) => file === "state/task_threads.json" || file.endsWith("/state/task_threads.json") },
  { label: "node_modules/", test: (file) => file === "node_modules" || file.startsWith("node_modules/") || file.includes("/node_modules/") },
  { label: ".venv/", test: (file) => file === ".venv" || file.startsWith(".venv/") || file.includes("/.venv/") },
  { label: "__pycache__/", test: (file) => file === "__pycache__" || file.startsWith("__pycache__/") || file.includes("/__pycache__/") }
];
const SNAPSHOT_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);

function nowIso() {
  return new Date().toISOString();
}

function safeUsername() {
  try {
    return os.userInfo().username || "local";
  } catch (_error) {
    return process.env.USER || "local";
  }
}

function defaultConfig() {
  return {
    version: 1,
    users: [safeUsername()],
    projects: {
      self: {
        path: ".",
        mode: "readonly"
      }
    },
    stateDir: ".codex-bridge",
    codexBin: "codex",
    maxConcurrent: 1,
    timeoutSeconds: 900,
    cancelGraceMs: 5000,
    watchdogIntervalMs: 1000,
    dryRunStepMs: 450,
    protectedPathWatchIntervalMs: 250,
    redaction: {
      enabled: true,
      redactHomePath: true,
      redactProjectPaths: true,
      redactTokens: true,
      maxLogChars: DEFAULT_MAX_LOG_CHARS,
      maxResultChars: DEFAULT_MAX_RESULT_CHARS
    }
  };
}

const taskStateRuntime = createTaskStateRuntime({
  fsp,
  path,
  crypto,
  nowIso,
  ensureDir,
  sleep,
  reconcileTask
});

const {
  readJson,
  writeJson,
  taskId,
  tasksDir,
  taskDir,
  taskFile,
  locksDir,
  workspaceLockFile,
  safeResultFile,
  safeLogsFile,
  assertTaskId,
  optionalTaskId,
  readTask,
  writeTask,
  patchTask,
  appendTaskLog,
  listTasks
} = taskStateRuntime;

function printHelp() {
  console.log(`Codex-Bridge Core prototype

Usage:
  node scripts/codex-bridge.js run --project self [--mode readonly|workspace-write] [--user USER] [--source web] [--idempotency-key KEY] [--reference-task-id task_id] [--dry-run] [--dry-run-step-ms 1000] "prompt"
  node scripts/codex-bridge.js status [task_id]
  node scripts/codex-bridge.js logs task_id [--tail 80] [--raw] [--json-output]
  node scripts/codex-bridge.js result task_id [--raw] [--json-output]
  node scripts/codex-bridge.js cancel task_id
  node scripts/codex-bridge.js reconcile
  node scripts/codex-bridge.js cleanup --dry-run [--older-than-days 30] [--keep-last 200]
  node scripts/codex-bridge.js message --user USER "/codex run project=self dry_run=true prompt"

Safe defaults:
  - project names are resolved only through the project whitelist
  - Codex runs use --ask-for-approval never and the sandbox configured by the whitelisted project mode
  - CUDA_VISIBLE_DEVICES is cleared for child processes
  - cancel terminates the task process group and records the result

Config:
  Default config path: ${DEFAULT_CONFIG_NAME}
  Override with: --config /path/to/config.json or CODEX_BRIDGE_CONFIG=/path/to/config.json
`);
}

function parseArgv(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_OPTIONS.has(body)) {
      opts[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      opts[body] = true;
      continue;
    }
    opts[body] = next;
    i += 1;
  }
  return opts;
}

function resolveConfigPath(opts) {
  if (opts.config) {
    return path.resolve(String(opts.config));
  }
  if (process.env.CODEX_BRIDGE_CONFIG) {
    return path.resolve(process.env.CODEX_BRIDGE_CONFIG);
  }
  const cwdConfig = path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);
  if (fs.existsSync(cwdConfig)) {
    return cwdConfig;
  }
  const repoConfig = path.resolve(REPO_ROOT, DEFAULT_CONFIG_NAME);
  if (fs.existsSync(repoConfig)) {
    return repoConfig;
  }
  return null;
}

async function loadConfig(opts = {}) {
  const configPath = resolveConfigPath(opts);
  const base = configPath ? path.dirname(configPath) : REPO_ROOT;
  const config = defaultConfig();
  if (configPath) {
    const loaded = await readJson(configPath);
    Object.assign(config, loaded);
    config.projects = loaded.projects || config.projects;
    config.users = loaded.users || loaded.allowedUsers || config.users;
  }
  if (process.env.CODEX_BRIDGE_STATE_DIR) {
    config.stateDir = process.env.CODEX_BRIDGE_STATE_DIR;
  }
  if (opts["state-dir"]) {
    config.stateDir = String(opts["state-dir"]);
  }
  config.__configPath = configPath;
  config.__baseDir = base;
  config.__stateDir = resolveMaybeRelative(config.stateDir, base);
  config.codexBin = await resolveCodexBin(config.codexBin || "codex");
  config.maxConcurrent = Math.max(1, Number(config.maxConcurrent || 1));
  config.timeoutSeconds = Math.max(1, Number(config.timeoutSeconds || 900));
  config.cancelGraceMs = Math.max(100, Number(config.cancelGraceMs || 5000));
  config.watchdogIntervalMs = Math.max(100, Number(config.watchdogIntervalMs || 1000));
  config.dryRunStepMs = Math.max(50, Number(config.dryRunStepMs || 450));
  config.protectedPathWatchIntervalMs = Math.max(50, Number(config.protectedPathWatchIntervalMs || 250));
  config.redaction = Object.assign({}, defaultConfig().redaction, config.redaction || {});
  config.redaction.maxLogChars = Math.max(1000, Number(config.redaction.maxLogChars || DEFAULT_MAX_LOG_CHARS));
  config.redaction.maxResultChars = Math.max(1000, Number(config.redaction.maxResultChars || DEFAULT_MAX_RESULT_CHARS));
  return config;
}

async function resolveCodexBin(configured) {
  const raw = String(configured || "codex");
  if (raw !== "codex") {
    const resolved = resolveMaybeRelative(raw, REPO_ROOT);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (stat && stat.isFile()) {
      return resolved;
    }
    return raw;
  }

  const fromPath = await findExecutableOnPath("codex");
  if (fromPath) {
    return fromPath;
  }

  const candidates = [
    path.join(os.homedir(), ".local/bin/codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex"
  ];
  const vscodeExtRoot = path.join(os.homedir(), ".vscode-server/extensions");
  const extensionDirs = await fsp.readdir(vscodeExtRoot).catch(() => []);
  for (const dir of extensionDirs.filter((name) => name.startsWith("openai.chatgpt-")).sort().reverse()) {
    const binRoot = path.join(vscodeExtRoot, dir, "bin");
    const platformDirs = await fsp.readdir(binRoot).catch(() => []);
    for (const platformDir of platformDirs.sort().reverse()) {
      candidates.push(path.join(binRoot, platformDir, "codex"));
    }
  }

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

async function findExecutableOnPath(name) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isExecutableFile(file) {
  try {
    await fsp.access(file, fs.constants.X_OK);
    const stat = await fsp.stat(file);
    return stat.isFile();
  } catch (_error) {
    return false;
  }
}

function resolveMaybeRelative(value, base) {
  const raw = String(value || "");
  if (!raw) {
    throw new Error("Empty path is not allowed.");
  }
  if (raw.startsWith("~/")) {
    return path.resolve(os.homedir(), raw.slice(2));
  }
  return path.resolve(base, raw);
}

function validateUser(config, user) {
  const allowed = Array.isArray(config.users) ? config.users : [];
  if (!allowed.includes(user)) {
    throw new Error(`User "${user}" is not allowed. Add it to config.users first.`);
  }
}

function safeOptionalString(value, maxLength = 256) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value).slice(0, maxLength);
}

function safeSource(value) {
  const source = String(value || "cli").trim() || "cli";
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(source)) {
    throw new Error("source must be 1-32 safe characters.");
  }
  return source;
}

function safeIdempotencyKey(value) {
  if (!value) {
    return null;
  }
  const key = String(value).trim();
  if (!/^[A-Za-z0-9_.:@/-]{1,160}$/.test(key)) {
    throw new Error("idempotency_key contains unsafe characters.");
  }
  return key;
}

function parseAdapterMetadata(value) {
  if (value === null || value === undefined || value === "") {
    return {};
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata must be a JSON object.");
  }
  return parsed;
}

function normalizeProjectModes(project) {
  const defaultMode = String(project.mode || project.default_mode || "readonly");
  const rawAllowed = project.allowedModes || project.allowed_modes || [defaultMode];
  const allowedModes = Array.isArray(rawAllowed) ? rawAllowed.map(String).filter(Boolean) : [defaultMode];
  for (const mode of [defaultMode, ...allowedModes]) {
    if (!SUPPORTED_MODES.has(mode)) {
      throw new Error(`Unsupported project mode: ${mode}.`);
    }
  }
  if (!allowedModes.includes(defaultMode)) {
    throw new Error(`Project default mode "${defaultMode}" must be in allowed modes.`);
  }
  return { defaultMode, allowedModes };
}

function sandboxForMode(mode) {
  if (mode === "readonly") {
    return "read-only";
  }
  if (mode === "workspace-write") {
    return "workspace-write";
  }
  throw new Error(`Unsupported project mode: ${mode}.`);
}

async function resolveProject(config, projectName, requestedMode = "") {
  if (!/^[A-Za-z0-9_.-]+$/.test(projectName || "")) {
    throw new Error("Project names may contain only letters, numbers, dot, underscore, and dash.");
  }
  const entry = config.projects && config.projects[projectName];
  if (!entry) {
    throw new Error(`Project "${projectName}" is not in the whitelist.`);
  }
  const project = typeof entry === "string" ? { path: entry } : entry;
  const modes = normalizeProjectModes(project);
  const mode = String(requestedMode || modes.defaultMode || "readonly");
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`Unsupported project mode: ${mode}.`);
  }
  if (!modes.allowedModes.includes(mode)) {
    throw new Error(`Project "${projectName}" does not allow mode "${mode}".`);
  }
  const projectPath = await realDirectory(resolveMaybeRelative(project.path, config.__baseDir));
  return {
    name: projectName,
    path: projectPath,
    mode
  };
}

async function realDirectory(dir) {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${dir}`);
  }
  return fsp.realpath(dir);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function isoAfterSeconds(seconds) {
  return new Date(Date.now() + Math.max(1, Number(seconds || 1)) * 1000).toISOString();
}

const processRuntime = createProcessRuntime({
  fsp,
  sleep,
  readTask,
  appendTaskLog,
  selfPid: process.pid
});

const taskOutputRuntime = createTaskOutputRuntime({
  fsp,
  defaultConfig,
  DEFAULT_REFERENCE_CONTEXT_CHARS,
  FINAL_STATUSES,
  resolveMaybeRelative,
  safeResultFile,
  safeLogsFile,
  patchTask,
  readTask
});

const workspaceWriteRuntime = createWorkspaceWriteRuntime({
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
  ensureSafeResult: taskOutputRuntime.ensureSafeResult,
  sanitizeOutput: taskOutputRuntime.sanitizeOutput,
  terminateTaskProcessGroup: processRuntime.terminateTaskProcessGroup,
  taskWorkerLooksAlive: processRuntime.taskWorkerLooksAlive
});

const taskRunnerRuntime = createTaskRunnerRuntime({
  fs,
  fsp,
  cp,
  entryScript: __filename,
  repoRoot: REPO_ROOT,
  loadConfig,
  assertTaskId,
  readTask,
  patchTask,
  appendTaskLog,
  activeTaskCount,
  sleep,
  nowIso,
  isoAfterSeconds,
  sandboxForMode,
  workspaceWriteRuntime,
  taskOutputRuntime,
  FINAL_STATUSES,
  taskWorkerLooksAlive: processRuntime.taskWorkerLooksAlive,
  reconcileTask,
  terminateTaskProcessGroup: processRuntime.terminateTaskProcessGroup,
  writeResultIfEmpty
});

const commandRuntime = createCommandRuntime({
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
  appendTaskLog,
  terminateTaskProcessGroup: processRuntime.terminateTaskProcessGroup,
  writeResultIfEmpty,
  workspaceWriteRuntime,
  reconcileAllTasks,
  path,
  validateUser
});

function deadlineExpired(task) {
  if (!task.deadline_at) {
    return false;
  }
  const deadline = new Date(task.deadline_at).getTime();
  return Number.isFinite(deadline) && Date.now() > deadline;
}

async function reconcileAllTasks(config) {
  const dir = tasksDir(config);
  const names = await fsp.readdir(dir).catch(() => []);
  let count = 0;
  for (const name of names) {
    if (!name.startsWith("task_")) {
      continue;
    }
    try {
      await reconcileTask(config, await readTask(config, name));
      count += 1;
    } catch (_error) {
      // Ignore malformed task directories while reconciling the task registry.
    }
  }
  await workspaceWriteRuntime.reconcileWorkspaceWriteLocks(config);
  return count;
}

async function reconcileTask(config, task) {
  if (!task || FINAL_STATUSES.has(task.status)) {
    return task;
  }
  if (task.status === "running" && deadlineExpired(task)) {
    return taskRunnerRuntime.timeoutTask(config, task);
  }
  if (!["running", "cancelling", "cancel_requested"].includes(task.status)) {
    return task;
  }
  const workerAlive = await processRuntime.taskWorkerLooksAlive(task);
  if (workerAlive) {
    return task;
  }
  if (task.status === "cancelling" || task.status === "cancel_requested") {
    const cancelled = await patchTask(config, task.task_id, {
      status: "cancelled",
      ended_at: nowIso(),
      finished_at: nowIso(),
      termination_reason: "cancelled"
    });
    await writeResultIfEmpty(cancelled, `Task ${task.task_id} was cancelled.\n`);
    await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled);
    await appendTaskLog(config, cancelled, `reconciled ${task.status} task to cancelled`);
    return cancelled;
  }
  const reconciled = await patchTask(config, task.task_id, {
    status: "stale",
    ended_at: nowIso(),
    finished_at: nowIso(),
    termination_reason: "stale",
    error: "Bridge worker is no longer running."
  });
  await writeResultIfEmpty(reconciled, `Task ${task.task_id} became stale because its worker process is gone.\n`);
  await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, reconciled);
  await appendTaskLog(config, reconciled, `reconciled stale ${task.status} task to stale`);
  return reconciled;
}

async function activeTaskCount(config, currentTaskId) {
  const tasks = await listTasks(config);
  return tasks.filter((task) => {
    if (task.task_id === currentTaskId) {
      return false;
    }
    return task.status === "running" || task.status === "cancelling" || task.status === "cancel_requested";
  }).length;
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function pathsOverlap(a, b) {
  const left = path.resolve(String(a || ""));
  const right = path.resolve(String(b || ""));
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

async function withLockIndex(config, fn) {
  const dir = locksDir(config);
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

async function readWorkspaceWriteLocks(config) {
  const dir = locksDir(config);
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

async function releaseWorkspaceWriteLock(config, task, reason = "released") {
  if (!task || task.mode !== "workspace-write" || !task.write_lock_file) {
    return null;
  }
  const file = task.write_lock_file;
  const lock = await readJson(file).catch(() => null);
  if (!lock || lock.released_at) {
    return lock;
  }
  const released = Object.assign({}, lock, {
    released_at: nowIso(),
    release_reason: reason,
    release_status: task.status || null
  });
  await writeJson(file, released);
  await patchTask(config, task.task_id, {
    write_lock_released_at: released.released_at
  }).catch(() => {});
  await appendTaskLog(config, task, `released workspace-write lock reason=${reason}`).catch(() => {});
  return released;
}

async function findIdempotentTask(config, user, source, idempotencyKey) {
  if (!idempotencyKey) {
    return null;
  }
  const dir = tasksDir(config);
  const names = await fsp.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith("task_")) {
      continue;
    }
    try {
      const task = await readTask(config, name);
      if (
        task.user === user &&
        task.source === source &&
        task.idempotency_key === idempotencyKey
      ) {
        task.__idempotent_replay = true;
        return task;
      }
    } catch (_error) {
      // Ignore malformed tasks while checking idempotency.
    }
  }
  return null;
}

async function createTask(config, options) {
  const user = String(options.user || safeUsername());
  validateUser(config, user);
  const project = await resolveProject(config, String(options.project || ""), String(options.mode || ""));
  const prompt = String(options.prompt || "").trim();
  if (!prompt) {
    throw new Error("A prompt is required.");
  }
  const source = safeSource(options.source);
  const idempotencyKey = safeIdempotencyKey(options.idempotencyKey || options.idempotency_key);
  const existing = await findIdempotentTask(config, user, source, idempotencyKey);
  if (existing) {
    return existing;
  }
  const adapterMetadata = parseAdapterMetadata(options.metadata || options.adapterMetadata || {});
  const referenceTaskId = optionalTaskId(options.referenceTaskId || options.reference_task_id);
  if (referenceTaskId) {
    const referenceTask = await readTask(config, referenceTaskId).catch(() => null);
    if (!referenceTask) {
      throw new Error(`Reference task not found: ${referenceTaskId}`);
    }
    if (referenceTask.user !== user) {
      throw new Error(`Reference task ${referenceTaskId} is not owned by ${user}.`);
    }
    if (referenceTask.project && !config.projects[referenceTask.project]) {
      throw new Error(`Reference task project is not allowlisted: ${referenceTask.project}.`);
    }
  }

  const id = taskId();
  const dir = taskDir(config, id);
  await ensureDir(dir);

  const task = {
    version: 1,
    task_id: id,
    status: "queued",
    user,
    project: project.name,
    project_path: project.path,
    mode: project.mode,
    prompt,
    dry_run: Boolean(options.dryRun),
    source,
    source_user_id: safeOptionalString(options.sourceUserId || options.source_user_id),
    source_channel_id: safeOptionalString(options.sourceChannelId || options.source_channel_id),
    source_message_id: safeOptionalString(options.sourceMessageId || options.source_message_id),
    idempotency_key: idempotencyKey,
    reference_task_id: referenceTaskId,
    adapter_metadata: adapterMetadata,
    received_text: options.receivedText || null,
    dry_run_step_ms: options.dryRunStepMs || null,
    created_at: nowIso(),
    updated_at: nowIso(),
    started_at: null,
    ended_at: null,
    finished_at: null,
    deadline_at: null,
    timeout_seconds: config.timeoutSeconds,
    cancel_requested_at: null,
    termination_reason: null,
    pid: null,
    pgid: null,
    child_pid: null,
    exit_code: null,
    result_file: path.join(dir, "result.md"),
    safe_result_file: path.join(dir, "result.safe.md"),
    stdout_file: path.join(dir, "stdout.jsonl"),
    stderr_file: path.join(dir, "stderr.log"),
    safe_logs_file: path.join(dir, "logs.safe.txt"),
    bridge_log_file: path.join(dir, "bridge.log")
  };

  await writeTask(config, task);
  await appendTaskLog(config, task, `queued project=${project.name} user=${user} dry_run=${task.dry_run}`);
  const worker = taskRunnerRuntime.spawnWorker(config, id);
  const queued = await patchTask(config, id, {
    pid: worker.pid || null,
    pgid: worker.pid || null
  });
  taskRunnerRuntime.spawnTaskWatchdog(config, id);
  return queued;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeResultIfEmpty(task, text) {
  const existing = await fsp.readFile(task.result_file, "utf8").catch(() => "");
  if (!existing.trim()) {
    await fsp.writeFile(task.result_file, text, "utf8").catch(() => {});
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (commandRuntime.isUserCommand(command)) {
    await commandRuntime.dispatchUserCommand(command, rest);
    return;
  }
  if (command === "__worker") {
    const opts = parseArgv(rest.slice(1));
    await taskRunnerRuntime.workerMain(rest[0], opts);
    return;
  }
  if (command === "__watchdog") {
    const opts = parseArgv(rest.slice(1));
    await taskRunnerRuntime.lifecycleWatchdogMain(rest[0], opts);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`codex-bridge: ${error.message || String(error)}`);
  process.exitCode = 1;
});
