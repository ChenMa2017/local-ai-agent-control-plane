"use strict";

const vscode = require("vscode");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");
const { createServiceAssembly } = require("./serviceAssembly");
const { createExtensionHostUtils } = require("./extensionHostUtils");
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
let hostUtils;

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

function getHostUtils() {
  if (!hostUtils) {
    hostUtils = createExtensionHostUtils({
      vscode,
      fs,
      fsp,
      path,
      os,
      crypto,
      cp,
      getOutput: () => output,
      getRuntimeConfigHelpers
    });
  }
  return hostUtils;
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
  return getHostUtils().isWatchdogInitialized(root);
}

async function isEffectivelyEmptyDir(root) {
  return getHostUtils().isEffectivelyEmptyDir(root);
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

function extensionSetting(key, fallback) {
  return getHostUtils().extensionSetting(key, fallback);
}

function extensionSettingWithSource(key, fallback) {
  return getHostUtils().extensionSettingWithSource(key, fallback);
}

function unitNames(root) {
  return getHostUtils().unitNames(root);
}

async function resolveCodexBin(root) {
  return getHostUtils().resolveCodexBin(root);
}

function projectSetting(root, key, fallback) {
  return getHostUtils().projectSetting(root, key, fallback);
}

function projectSettingWithSource(root, key, fallback) {
  return getHostUtils().projectSettingWithSource(root, key, fallback);
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

function isExistingDirectory(value) { return getHostUtils().isExistingDirectory(value); }
function requireExistingDirectory(value, label) { return getHostUtils().requireExistingDirectory(value, label); }
function isSafeProjectRootPath(value) { return getHostUtils().isSafeProjectRootPath(value); }
function validateProjectRootPath(value) { return getHostUtils().validateProjectRootPath(value); }
async function updateProjectSetting(root, key, value) { return getHostUtils().updateProjectSetting(root, key, value); }

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

async function runLogged(command, args, options = {}) { return getHostUtils().runLogged(command, args, options); }
async function runLoggedWithInput(command, args, input, options = {}) { return getHostUtils().runLoggedWithInput(command, args, input, options); }
function run(command, args, options = {}) { return getHostUtils().run(command, args, options); }
async function ensureDir(dir) { return getHostUtils().ensureDir(dir); }
async function openDocument(file, preview) { return getHostUtils().openDocument(file, preview); }
function readFilePrefix(file, maxBytes) { return getHostUtils().readFilePrefix(file, maxBytes); }
function expandHome(value) { return getHostUtils().expandHome(value); }
function shellQuote(value) { return getHostUtils().shellQuote(value); }
function systemdQuote(value) { return getHostUtils().systemdQuote(value); }
function systemdPathValue(value) { return getHostUtils().systemdPathValue(value); }
function systemdEnvValue(value) { return getHostUtils().systemdEnvValue(value); }


module.exports = {
  activate,
  deactivate
};
