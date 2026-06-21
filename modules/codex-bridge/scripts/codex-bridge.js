#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");
const { createTaskOutputRuntime } = require("../lib/task-output-runtime");
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

function taskId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return `task_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
}

function isoAfterSeconds(seconds) {
  return new Date(Date.now() + Math.max(1, Number(seconds || 1)) * 1000).toISOString();
}

function tasksDir(config) {
  return path.join(config.__stateDir, "tasks");
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

function assertTaskId(id) {
  if (!/^task_[A-Za-z0-9_.-]+$/.test(String(id || ""))) {
    throw new Error(`Invalid task id: ${id}`);
  }
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

function pidLooksAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) {
    return false;
  }
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function processGroupLooksAlive(pgid) {
  const value = Number(pgid);
  if (!Number.isInteger(value) || value <= 0) {
    return false;
  }
  try {
    process.kill(-value, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

async function procCmdline(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) {
    return "";
  }
  return fsp.readFile(`/proc/${value}/cmdline`, "utf8").then((text) => text.replace(/\0/g, " ")).catch(() => "");
}

async function taskWorkerLooksAlive(task) {
  if (!pidLooksAlive(task.pid)) {
    return false;
  }
  const cmdline = await procCmdline(task.pid);
  return cmdline.includes("__worker") && cmdline.includes(task.task_id);
}

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
  terminateTaskProcessGroup,
  taskWorkerLooksAlive
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
    return timeoutTask(config, task);
  }
  if (!["running", "cancelling", "cancel_requested"].includes(task.status)) {
    return task;
  }
  const workerAlive = await taskWorkerLooksAlive(task);
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
  const worker = spawnWorker(config, id);
  const queued = await patchTask(config, id, {
    pid: worker.pid || null,
    pgid: worker.pid || null
  });
  spawnTaskWatchdog(config, id);
  return queued;
}

function spawnWorker(config, id) {
  const args = [__filename, "__worker", id];
  if (config.__configPath) {
    args.push("--config", config.__configPath);
  }
  if (process.env.CODEX_BRIDGE_STATE_DIR) {
    args.push("--state-dir", config.__stateDir);
  }
  const child = cp.spawn(process.execPath, args, {
    cwd: REPO_ROOT,
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
  const args = [__filename, "__watchdog", id];
  if (config.__configPath) {
    args.push("--config", config.__configPath);
  }
  if (process.env.CODEX_BRIDGE_STATE_DIR) {
    args.push("--state-dir", config.__stateDir);
  }
  const child = cp.spawn(process.execPath, args, {
    cwd: REPO_ROOT,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const failedTask = await patchTask(config, task.task_id, {
      status: "failed",
      ended_at: nowIso(),
      finished_at: nowIso(),
      error: message
    }).catch(() => {});
    if (failedTask) {
      await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, failedTask, "worker_failed").catch(() => {});
    }
    await appendTaskLog(config, task, `worker failed: ${message.split("\n")[0]}`).catch(() => {});
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
      const cancelled = await patchTask(config, task.task_id, {
        status: "cancelled",
        ended_at: nowIso(),
        finished_at: nowIso(),
        termination_reason: "cancelled"
      });
      await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancelled_before_start");
      await appendTaskLog(config, cancelled, "cancelled before start");
      return;
    }

    if (task.mode === "workspace-write") {
      const locked = await workspaceWriteRuntime.acquireWorkspaceWriteLock(config, task);
      if (!locked) {
        const cancelled = await patchTask(config, task.task_id, {
          status: "cancelled",
          ended_at: nowIso(),
          finished_at: nowIso(),
          termination_reason: "cancelled"
        });
        await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancelled_before_lock");
        await appendTaskLog(config, cancelled, "cancelled before acquiring workspace-write lock");
        return;
      }
      const isolated = await workspaceWriteRuntime.prepareWorkspaceWriteExecution(config, locked);
      task = await workspaceWriteRuntime.beginWriteAudit(config, isolated);
    }

    const started = await patchTask(config, task.task_id, {
      status: "running",
      pid: process.pid,
      pgid: process.pid,
      started_at: nowIso(),
      deadline_at: isoAfterSeconds(config.timeoutSeconds),
      timeout_seconds: config.timeoutSeconds
    });
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
      const cancelled = await patchTask(config, task.task_id, {
        status: "cancelled",
        ended_at: nowIso(),
        finished_at: nowIso(),
        termination_reason: "cancelled"
      });
      await taskOutputRuntime.ensureSafeResult(config, cancelled);
      await appendTaskLog(config, task, "cancelled during dry-run");
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
  const done = await patchTask(config, task.task_id, {
    status: "done",
    ended_at: nowIso(),
    finished_at: nowIso(),
    exit_code: 0
  });
  await taskOutputRuntime.ensureSafeResult(config, done);
  await appendTaskLog(config, task, "done dry-run");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function jsonOutputRequested(opts) {
  return Boolean(opts.json || opts["json-output"]);
}

async function writeResultIfEmpty(task, text) {
  const existing = await fsp.readFile(task.result_file, "utf8").catch(() => "");
  if (!existing.trim()) {
    await fsp.writeFile(task.result_file, text, "utf8").catch(() => {});
  }
}

function signalProcessGroup(pgid, signal) {
  const value = Number(pgid);
  if (!Number.isInteger(value) || value <= 0) {
    return false;
  }
  if (value === process.pid) {
    throw new Error("Refusing to signal the current process group.");
  }
  try {
    process.kill(-value, signal);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") {
      return false;
    }
    if (error && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function terminateTaskProcessGroup(config, task, reason) {
  const fresh = await readTask(config, task.task_id).catch(() => task);
  const pgid = Number(fresh.pgid || fresh.pid);
  const workerAlive = await taskWorkerLooksAlive(fresh);
  if (!workerAlive || !processGroupLooksAlive(pgid)) {
    await appendTaskLog(config, fresh, `${reason}: task process group is already gone`);
    return { signalled: false, signal: null };
  }

  await appendTaskLog(config, fresh, `${reason}: sending SIGTERM to pgid=${pgid}`);
  signalProcessGroup(pgid, "SIGTERM");
  const deadline = Date.now() + config.cancelGraceMs;
  while (Date.now() < deadline) {
    if (!processGroupLooksAlive(pgid)) {
      return { signalled: true, signal: "SIGTERM" };
    }
    await sleep(100);
  }

  if (processGroupLooksAlive(pgid)) {
    await appendTaskLog(config, fresh, `${reason}: sending SIGKILL to pgid=${pgid}`);
    signalProcessGroup(pgid, "SIGKILL");
    await sleep(200);
    return { signalled: true, signal: "SIGKILL" };
  }

  return { signalled: true, signal: "SIGTERM" };
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
  const timedOut = await patchTask(config, fresh.task_id, {
    status: "timeout",
    timeout_at: now,
    ended_at: now,
    finished_at: now,
    termination_reason: "timeout"
  });
  await appendTaskLog(config, timedOut, `timeout reached deadline_at=${fresh.deadline_at || "-"}`);
  const termination = await terminateTaskProcessGroup(config, timedOut, "timeout");
  const finalTask = await patchTask(config, fresh.task_id, {
    status: "timeout",
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
      const updated = await patchTask(config, task.task_id, patch);
      if (FINAL_STATUSES.has(updated.status)) {
        await taskOutputRuntime.ensureSafeResult(config, updated).catch(() => {});
      }
      await appendTaskLog(config, task, logLine);
      resolve();
    }

    child.once("error", async (error) => {
      await fsp.writeFile(task.result_file, `Codex runner failed: ${error.message}\n`, "utf8").catch(() => {});
      await finish({
        status: "failed",
        ended_at: nowIso(),
        finished_at: nowIso(),
        error: error.message
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
        status: cancelled ? "cancelled" : code === 0 && !signal ? "done" : "failed",
        ended_at: nowIso(),
        finished_at: nowIso(),
        exit_code: code,
        exit_signal: signal || null,
        termination_reason: cancelled ? "cancelled" : signal ? "signal" : null
      }, `codex exited code=${code} signal=${signal || ""}`);
    });

    await patchTask(config, task.task_id, {
      child_pid: child.pid || null
    });
    await appendTaskLog(config, task, `codex child pid=${child.pid || "unknown"}`);
  });
}

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

async function commandLogs(argv) {
  const opts = parseArgv(argv);
  const config = await loadConfig(opts);
  const id = opts._[0];
  if (!id) {
    throw new Error("logs requires a task_id.");
  }
  const task = await reconcileTask(config, await readTask(config, id));
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
    const cancelled = await patchTask(config, id, {
      status: "cancelled",
      cancel_requested_at: requestedAt,
      ended_at: requestedAt,
      finished_at: requestedAt,
      termination_reason: "cancelled"
    });
    await appendTaskLog(config, cancelled, "cancelled while queued");
    await terminateTaskProcessGroup(config, cancelled, "cancel");
    await writeResultIfEmpty(cancelled, `Task ${task.task_id} was cancelled before it started.\n`);
    await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancel_queued");
    console.log(`${task.task_id} cancelled.`);
    return;
  }

  const cancelling = await patchTask(config, id, {
    status: "cancelling",
    cancel_requested_at: task.cancel_requested_at || requestedAt,
    termination_reason: "cancelled"
  });
  await appendTaskLog(config, cancelling, "cancelling by bridge user");
  const termination = await terminateTaskProcessGroup(config, cancelling, "cancel");
  const finishedAt = nowIso();
  const cancelled = await patchTask(config, id, {
    status: "cancelled",
    ended_at: finishedAt,
    finished_at: finishedAt,
    termination_reason: "cancelled",
    exit_signal: termination.signal
  });
  await writeResultIfEmpty(cancelled, `Task ${task.task_id} was cancelled.\n`);
  await workspaceWriteRuntime.finalizeWorkspaceWriteTask(config, cancelled, "cancel");
  await appendTaskLog(config, cancelled, "cancel completed");
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "run") {
    await commandRun(rest);
    return;
  }
  if (command === "status") {
    await commandStatus(rest);
    return;
  }
  if (command === "logs") {
    await commandLogs(rest);
    return;
  }
  if (command === "result") {
    await commandResult(rest);
    return;
  }
  if (command === "cancel") {
    await commandCancel(rest);
    return;
  }
  if (command === "reconcile") {
    await commandReconcile(rest);
    return;
  }
  if (command === "cleanup") {
    await commandCleanup(rest);
    return;
  }
  if (command === "message") {
    await commandMessage(rest);
    return;
  }
  if (command === "__worker") {
    const opts = parseArgv(rest.slice(1));
    await workerMain(rest[0], opts);
    return;
  }
  if (command === "__watchdog") {
    const opts = parseArgv(rest.slice(1));
    await lifecycleWatchdogMain(rest[0], opts);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`codex-bridge: ${error.message || String(error)}`);
  process.exitCode = 1;
});
