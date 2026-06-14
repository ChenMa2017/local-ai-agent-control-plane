"use strict";

const vscode = require("vscode");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");
const { createServiceAssembly } = require("./serviceAssembly");
const { templates } = require("./templates");
const {
  emptyPanelOperationState: emptyControlPanelOperationState,
  nextPanelOperationState
} = require("./controlPanelState");
const {
  bootstrapArchiveDir,
  bootstrapChangePreviewPath,
  bootstrapConversationJsonPath,
  bootstrapConversationMarkdownPath,
  bootstrapConversationPromptText,
  bootstrapConversationTurnSchemaPath,
  bootstrapLastResultPath,
  bootstrapResultSchemaPath,
  bootstrapRuntimeStatePath,
  bootstrapInstantiationPromptText,
  emptyBootstrapConversation,
  emptyBootstrapRuntimeState,
  getBootstrapConversationState,
  readBootstrapConversation,
  readBootstrapRuntimeState,
  renderBootstrapConversationMarkdown,
  writeBootstrapConversation,
  writeBootstrapRuntimeState,
  writeBootstrapChangePreview,
  clearBootstrapDraftArtifacts,
  collectBootstrapDraftChanges,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
} = require("./bootstrapConversation");

let output;
let extensionContext;
let serviceAssembly;

const PROJECT_ROOT_KEY = "projectRoot";
const STATUS_REFRESH_MS = 60000;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_TIMEOUT_MINUTES = 25;
const DEFAULT_COMPACT_EVERY_RUNS = 6;
const DEFAULT_PHASE_OFFSET_MINUTES = 10;
const DEFAULT_WATCHDOG_ROLE = "runner";
const DEFAULT_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS = 4;
const DEFAULT_SUPERVISOR_LIGHT_FOLLOWUP = true;
const DEFAULT_SERVICE_PREFIX = "codex-watchdog";
const LOGIN_READY_RE = /(?:logged\s+in|authenticated)/i;

function emptyPanelOperationState() {
  return emptyControlPanelOperationState();
}

function getServiceAssembly() {
  if (!serviceAssembly) {
    serviceAssembly = createServiceAssembly({
      vscode,
      fs,
      fsp,
      path,
      os,
      crypto,
      getOutput: () => output,
      getExtensionContext: () => extensionContext,
      projectRootKey: PROJECT_ROOT_KEY,
      statusRefreshMs: STATUS_REFRESH_MS,
      defaultIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
      defaultTimeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      defaultCompactEveryRuns: DEFAULT_COMPACT_EVERY_RUNS,
      defaultPhaseOffsetMinutes: DEFAULT_PHASE_OFFSET_MINUTES,
      defaultWatchdogRole: DEFAULT_WATCHDOG_ROLE,
      defaultSupervisorAuditEveryRunnerRuns: DEFAULT_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS,
      defaultSupervisorLightFollowup: DEFAULT_SUPERVISOR_LIGHT_FOLLOWUP,
      defaultServicePrefix: DEFAULT_SERVICE_PREFIX,
      loginReadyRe: LOGIN_READY_RE,
      emptyPanelOperationState,
      nextPanelOperationState,
      templates,
      ensureDir,
      openDocument,
      extensionSetting,
      extensionSettingWithSource,
      projectSetting,
      projectSettingWithSource,
      expandHome,
      isExistingDirectory,
      isSafeProjectRootPath,
      validateProjectRootPath,
      requireExistingDirectory,
      resolveCodexBin,
      runLogged,
      runLoggedWithInput,
      createNonce,
      updateProjectSetting,
      run,
      unitNames,
      systemdQuote,
      systemdPathValue,
      systemdEnvValue,
      shellQuote,
      readFilePrefix,
      isWatchdogInitialized,
      isEffectivelyEmptyDir
    });
  }
  return serviceAssembly;
}

function getProjectSetupHelpers() {
  return getServiceAssembly().getProjectSetupHelpers();
}

function getProjectRootManager() {
  return getServiceAssembly().getProjectRootManager();
}

function taskLooksInstantiated(root) {
  return getServiceAssembly().taskLooksInstantiated(root);
}

function getBootstrapWorkflowHelpers() {
  return getServiceAssembly().getBootstrapWorkflowHelpers();
}

function getGeneratedFilesHelpers() {
  return getServiceAssembly().getGeneratedFilesHelpers();
}

function getBootstrapScaffoldingHelpers() {
  return getServiceAssembly().getBootstrapScaffoldingHelpers();
}

function getRuntimeConfigHelpers() {
  return getServiceAssembly().getRuntimeConfigHelpers();
}

function getRuntimeHelpers() {
  return getServiceAssembly().getRuntimeHelpers();
}

function getProjectCommands() {
  return getServiceAssembly().getProjectCommands();
}

async function ensureGeneratedDirs(root) {
  return getGeneratedFilesHelpers().ensureGeneratedDirs(root);
}

async function refreshGeneratedWatcherFiles(root) {
  return getGeneratedFilesHelpers().refreshGeneratedWatcherFiles(root);
}

function getGuardCommands() {
  return getServiceAssembly().getGuardCommands();
}

function getControlPanelStateHelpers() {
  return getServiceAssembly().getControlPanelStateHelpers();
}

function getControlPanelMessageHandler() {
  return getServiceAssembly().getControlPanelMessageHandler();
}

function getControlPanelController() {
  return getServiceAssembly().getControlPanelController();
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel("Codex Watchdog");
  context.subscriptions.push(output);
  getServiceAssembly().activate(context);
}

function deactivate() {
  getServiceAssembly().deactivate();
}

async function updateStatusBar() {
  await getServiceAssembly().updateStatusBar();
}

async function openControlPanelCommand() {
  await getServiceAssembly().openControlPanelCommand();
}

async function updateControlPanel() {
  await getServiceAssembly().updateControlPanel();
}

async function setPanelOperationState(data) {
  await getServiceAssembly().setPanelOperationState(data);
}

async function clearPanelOperationState() {
  await getServiceAssembly().clearPanelOperationState();
}

function getKnownProjectRoot() {
  return getServiceAssembly().getKnownProjectRoot();
}

function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

async function effectiveWatchdogSettings(root) {
  return getRuntimeHelpers().effectiveWatchdogSettings(root);
}

async function renderWatchdogEnv(root) {
  return getRuntimeHelpers().renderWatchdogEnv(root);
}

async function bootstrapProject(root) {
  return getBootstrapScaffoldingHelpers().bootstrapProject(root);
}

async function ensureWatchdogReadme(root) {
  return getBootstrapScaffoldingHelpers().ensureWatchdogReadme(root);
}

async function createDemoProjectTemplate(root) {
  return getBootstrapScaffoldingHelpers().createDemoProjectTemplate(root);
}

async function writeSystemdUnits(root, units) {
  return getRuntimeHelpers().writeSystemdUnits(root, units);
}

async function ensureCodexHome(root) {
  return getRuntimeHelpers().ensureCodexHome(root);
}

function inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome = path.join(os.homedir(), ".codex")) {
  return getRuntimeHelpers().inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome);
}

function inspectWatcherHomeBootstrap(root) {
  return getRuntimeHelpers().inspectWatcherHomeBootstrap(root);
}

async function seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome = path.join(os.homedir(), ".codex")) {
  return getRuntimeHelpers().seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome);
}

async function seedWatcherHomeAuthFromMainProfile(root) {
  return getRuntimeHelpers().seedWatcherHomeAuthFromMainProfile(root);
}

async function getCodexLoginStatus(root) {
  return getRuntimeHelpers().getCodexLoginStatus(root);
}

async function confirmLoginIfNeeded(root) {
  return getRuntimeHelpers().confirmLoginIfNeeded(root);
}

async function openLoginTerminal(rootArg) {
  return getRuntimeHelpers().openLoginTerminal(rootArg);
}

async function getTimerStatus(root) {
  return getRuntimeHelpers().getTimerStatus(root);
}

function showBootstrapResult(result) {
  getBootstrapScaffoldingHelpers().showBootstrapResult(result);
}

function isWatchdogInitialized(root) {
  return fs.existsSync(path.join(root, "agent", "PLAN.md"))
    && fs.existsSync(path.join(root, "agent", "SAFETY.md"))
    && fs.existsSync(path.join(root, "agent", "bin", "run_watchdog.sh"));
}

async function isEffectivelyEmptyDir(root) {
  try {
    const entries = await fsp.readdir(root);
    return entries.filter((entry) => ![".git", ".DS_Store"].includes(entry)).length === 0;
  } catch (_error) {
    return false;
  }
}

function getWorkspaceRoot() {
  return getServiceAssembly().getWorkspaceRoot();
}

async function selectProjectRoot(title) {
  return getServiceAssembly().selectProjectRoot(title);
}

async function browseExistingProjectRoot(title, raw) {
  return getServiceAssembly().browseExistingProjectRoot(title, raw);
}

async function normalizeProjectRootInput(raw, label, options = {}) {
  return getServiceAssembly().normalizeProjectRootInput(raw, label, options);
}

async function getProjectRoot() {
  return getServiceAssembly().getProjectRoot();
}

async function rememberProjectRoot(root) {
  await getServiceAssembly().rememberProjectRoot(root);
}

async function clearRememberedProjectRoot() {
  await getServiceAssembly().clearRememberedProjectRoot();
}

function config() {
  return vscode.workspace.getConfiguration("codexWatchdog");
}

function extensionSetting(key, fallback) {
  return extensionSettingWithSource(key, fallback).value;
}

function extensionSettingWithSource(key, fallback) {
  const inspected = config().inspect(key);
  if (!inspected) {
    return { value: fallback, source: "fallback" };
  }
  if (inspected.globalValue !== undefined) {
    return { value: inspected.globalValue, source: "global" };
  }
  if (inspected.defaultValue !== undefined) {
    return { value: inspected.defaultValue, source: "default" };
  }
  return { value: fallback, source: "fallback" };
}

function unitNames(root) {
  const prefix = servicePrefixSetting(root);
  const slug = projectSlug(root);
  const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
  const units = {
    service: `${prefix}-${slug}-${hash}.service`,
    timer: `${prefix}-${slug}-${hash}.timer`
  };
  validateUnitName(units.service, ".service");
  validateUnitName(units.timer, ".timer");
  return units;
}

function projectSlug(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

async function resolveCodexBin(root) {
  const setting = projectSettingWithSource(root, "codexWatchdog.codexBin", extensionSettingWithSource("codexBin", "codex"));
  const configured = String(setting.value || "codex");
  if (configured && configured !== "codex") {
    const expanded = expandHome(configured);
    validateConfiguredCodexBin(expanded);
    return expanded;
  }
  try {
    const result = await run("bash", ["-lc", "command -v codex"], { cwd: os.homedir() });
    const found = result.stdout.trim();
    if (found) {
      return found;
    }
  } catch (_error) {
    // Fall through to the VSCode OpenAI extension binary search below.
  }
  const extensionCodex = findOpenAICodexExtensionBinary();
  return extensionCodex || "codex";
}

function findOpenAICodexExtensionBinary() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode", "extensions")
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const extensionDir of fs.readdirSync(root)) {
      if (!/^openai\.chatgpt-/.test(extensionDir)) {
        continue;
      }
      const binRoot = path.join(root, extensionDir, "bin");
      if (!fs.existsSync(binRoot)) {
        continue;
      }
      for (const platformDir of fs.readdirSync(binRoot)) {
        if (!/^linux-/.test(platformDir)) {
          continue;
        }
        const candidate = path.join(binRoot, platformDir, "codex");
        if (!fs.existsSync(candidate)) {
          continue;
        }
        try {
          validateConfiguredCodexBin(candidate);
          candidates.push(candidate);
        } catch (_error) {
          // Ignore non-executable or non-allowlisted candidates.
        }
      }
    }
  }
  return candidates.sort().at(-1) || "";
}

function validateConfiguredCodexBin(value) {
  if (!path.isAbsolute(value)) {
    throw new Error(`codexWatchdog.codexBin must be "codex" or an allowed absolute path: ${value}`);
  }
  if (path.basename(value) !== "codex") {
    throw new Error(`codexWatchdog.codexBin must point to an executable named codex: ${value}`);
  }

  const normalized = path.normalize(value);
  const home = os.homedir();
  const exactAllowed = [
    path.join(home, ".local", "bin", "codex"),
    "/usr/bin/codex",
    "/usr/local/bin/codex",
    "/bin/codex"
  ];
  if (exactAllowed.includes(normalized) || isOpenAICodexExtensionPath(normalized, path.join(home, ".vscode-server", "extensions")) || isOpenAICodexExtensionPath(normalized, path.join(home, ".vscode", "extensions"))) {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) {
      throw new Error(`codexWatchdog.codexBin is not a file: ${value}`);
    }
    if ((stat.mode & 0o111) === 0) {
      throw new Error(`codexWatchdog.codexBin is not executable: ${value}`);
    }
    return;
  }

  throw new Error(`Refusing codexWatchdog.codexBin outside allowed locations: ${value}`);
}

function isOpenAICodexExtensionPath(value, extensionRoot) {
  const relative = path.relative(path.resolve(extensionRoot), path.resolve(value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(path.sep);
  return parts.length === 4
    && /^openai\.chatgpt-/.test(parts[0])
    && parts[1] === "bin"
    && /^linux-/.test(parts[2])
    && parts[3] === "codex";
}

function projectSetting(root, key, fallback) {
  return projectSettingWithSource(root, key, fallback).value;
}

function projectSettingWithSource(root, key, fallback) {
  const projectSettings = readProjectSettings(root);
  if (Object.prototype.hasOwnProperty.call(projectSettings, key)) {
    return { value: projectSettings[key], source: "project" };
  }
  if (fallback && typeof fallback === "object" && Object.prototype.hasOwnProperty.call(fallback, "value")) {
    return fallback;
  }
  return { value: fallback, source: "extension" };
}

function positiveNumberSetting(root, key, fallback, min, hardFallback) {
  return getRuntimeConfigHelpers().positiveNumberSetting(root, key, fallback, min, hardFallback);
}

function booleanSetting(root, key, fallback, hardFallback) {
  return getRuntimeConfigHelpers().booleanSetting(root, key, fallback, hardFallback);
}

function sandboxModeSetting(root) {
  return getRuntimeConfigHelpers().sandboxModeSetting(root);
}

function watchdogRoleSetting(root) {
  return getRuntimeConfigHelpers().watchdogRoleSetting(root);
}

function codexHomeSetting(root) {
  return getRuntimeConfigHelpers().codexHomeSetting(root);
}

function codexHomePlan(root) {
  return getRuntimeConfigHelpers().codexHomePlan(root);
}

function servicePrefixSetting(root) {
  return getRuntimeConfigHelpers().servicePrefixSetting(root);
}

function validateUnitName(name, suffix) {
  return getRuntimeConfigHelpers().validateUnitName(name, suffix);
}

function isExistingDirectory(value) {
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory();
  } catch (_error) {
    return false;
  }
}

function requireExistingDirectory(value, label) {
  const expanded = expandHome(String(value || ""));
  validateProjectRootPath(expanded);
  if (!fs.existsSync(expanded)) {
    throw new Error(`${label} does not exist: ${expanded}`);
  }
  if (!fs.statSync(expanded).isDirectory()) {
    throw new Error(`${label} is not a directory: ${expanded}`);
  }
  return expanded;
}

function isSafeProjectRootPath(value) {
  try {
    validateProjectRootPath(value);
    return true;
  } catch (_error) {
    return false;
  }
}

function validateProjectRootPath(value) {
  if (!path.isAbsolute(value)) {
    throw new Error(`Project root must be an absolute Linux path: ${value}`);
  }
  if (/[\x00-\x1F\x7F%]/.test(value)) {
    throw new Error(`Project root contains characters unsafe for generated systemd units: ${value}`);
  }
}

function readProjectSettings(root) {
  const settingsPath = path.join(root, ".vscode", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(fs.readFileSync(settingsPath, "utf8")));
  } catch (error) {
    output.appendLine(`[warning] Could not parse ${settingsPath} as JSON/JSONC: ${error.message}`);
    return {};
  }
}

async function updateProjectSetting(root, key, value) {
  const settingsDir = path.join(root, ".vscode");
  const settingsPath = path.join(settingsDir, "settings.json");
  await ensureDir(settingsDir);
  const settings = readProjectSettings(root);
  settings[key] = value;
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  output.appendLine(`Updated ${path.relative(root, settingsPath)}: ${key}=${JSON.stringify(value)}`);
}

function parseTomlBasicString(text, key) {
  return getRuntimeConfigHelpers().parseTomlBasicString(text, key);
}

function hasTomlAssignment(text, key) {
  return getRuntimeConfigHelpers().hasTomlAssignment(text, key);
}

function watcherProfileModelDefaults() {
  return getRuntimeConfigHelpers().watcherProfileModelDefaults();
}

function mergeWatcherConfigText(existingText, profileDefaults = watcherProfileModelDefaults()) {
  return getRuntimeConfigHelpers().mergeWatcherConfigText(existingText, profileDefaults);
}

function readWatcherUnitDrift(root, settings, unitDir) {
  return getRuntimeHelpers().readWatcherUnitDrift(root, settings, unitDir);
}

function inspectProjectRuntimeClarity(root) {
  return getRuntimeHelpers().inspectProjectRuntimeClarity(root);
}

function stripJsonCommentsAndTrailingCommas(text) {
  let outputText = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        outputText += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        outputText += char;
      }
      continue;
    }

    if (inString) {
      outputText += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      outputText += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    outputText += char;
  }

  return removeTrailingCommas(outputText);
}

function removeTrailingCommas(text) {
  let outputText = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      outputText += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      outputText += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        continue;
      }
    }

    outputText += char;
  }

  return outputText;
}

async function runLogged(command, args, options = {}) {
  output.show(true);
  output.appendLine(`$ ${[command, ...args].join(" ")}`);
  const result = await run(command, args, options);
  if (result.stdout.trim()) {
    output.appendLine(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    output.appendLine(result.stderr.trimEnd());
  }
  return result;
}

async function runLoggedWithInput(command, args, input, options = {}) {
  output.show(true);
  output.appendLine(`$ ${[command, ...args].join(" ")} <stdin>`);
  const result = await runWithInput(command, args, input, options);
  if (result.stdout.trim()) {
    output.appendLine(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    output.appendLine(result.stderr.trimEnd());
  }
  return result;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, {
      cwd: options.cwd || os.homedir(),
      env: { ...process.env, ...(options.env || {}) },
      timeout: options.timeout,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error && !options.allowFailure) {
        error.message = `${error.message}\n${stderr || ""}`.trim();
        reject(error);
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "", error });
    });
  });
}

function runWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: options.cwd || os.homedir(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId;

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (error && !options.allowFailure) {
        error.message = `${error.message}\n${stderr || ""}`.trim();
        reject(error);
        return;
      }
      resolve(result);
    };

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        const error = new Error(`Command timed out after ${options.timeout} ms`);
        error.code = "ETIMEDOUT";
        finish(error, { stdout, stderr, error });
      }, options.timeout);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
        child.kill("SIGTERM");
        const error = new Error("stdout/stderr maxBuffer exceeded");
        finish(error, { stdout, stderr, error });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
        child.kill("SIGTERM");
        const error = new Error("stdout/stderr maxBuffer exceeded");
        finish(error, { stdout, stderr, error });
      }
    });
    child.on("error", (error) => {
      finish(error, { stdout, stderr, error });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if ((code && code !== 0) || signal) {
        const error = new Error(signal ? `Command terminated by ${signal}` : `Command exited with status ${code}`);
        error.code = code;
        finish(error, { stdout, stderr, error });
        return;
      }
      finish(null, { stdout, stderr, error: null });
    });

    child.stdin.end(String(input || ""));
  });
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function openDocument(file, preview) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview });
}

function readFilePrefix(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function expandHome(value) {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function systemdPathValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\s/g, "\\x20");
}

function systemdEnvValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\s/g, "\\x20");
}


module.exports = {
  activate,
  deactivate
};
