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
const { createExtensionServiceDelegates } = require("./extensionServiceDelegates");
const { createExtensionHostDelegates } = require("./extensionHostDelegates");
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

const serviceDelegates = createExtensionServiceDelegates({
  getServiceAssembly,
  getGeneratedFilesHelpers,
  getBootstrapScaffoldingHelpers,
  getRuntimeConfigHelpers,
  getRuntimeHelpers,
  crypto,
  path,
  os
});

const hostDelegates = createExtensionHostDelegates({
  getHostUtils,
  getRuntimeConfigHelpers
});
const ensureGeneratedDirs = serviceDelegates.ensureGeneratedDirs;
const refreshGeneratedWatcherFiles = serviceDelegates.refreshGeneratedWatcherFiles;
const taskLooksInstantiated = serviceDelegates.taskLooksInstantiated;
const codexHomePlan = hostDelegates.codexHomePlan;
const ensureCodexHome = serviceDelegates.ensureCodexHome;
const mergeWatcherConfigText = hostDelegates.mergeWatcherConfigText;
const inspectWatcherHomeBootstrapState = serviceDelegates.inspectWatcherHomeBootstrapState;
const seedWatcherHomeBootstrapFromProfilePaths = serviceDelegates.seedWatcherHomeBootstrapFromProfilePaths;
const inspectProjectRuntimeClarity = serviceDelegates.inspectProjectRuntimeClarity;
const readWatcherUnitDrift = serviceDelegates.readWatcherUnitDrift;
const systemdEnvValue = hostDelegates.systemdEnvValue;
const unitNames = hostDelegates.unitNames;

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
      ensureDir: hostDelegates.ensureDir,
      openDocument: hostDelegates.openDocument,
      extensionSetting: hostDelegates.extensionSetting,
      extensionSettingWithSource: hostDelegates.extensionSettingWithSource,
      projectSetting: hostDelegates.projectSetting,
      projectSettingWithSource: hostDelegates.projectSettingWithSource,
      expandHome: hostDelegates.expandHome,
      isExistingDirectory: hostDelegates.isExistingDirectory,
      isSafeProjectRootPath: hostDelegates.isSafeProjectRootPath,
      validateProjectRootPath: hostDelegates.validateProjectRootPath,
      requireExistingDirectory: hostDelegates.requireExistingDirectory,
      resolveCodexBin: hostDelegates.resolveCodexBin,
      runLogged: hostDelegates.runLogged,
      runLoggedWithInput: hostDelegates.runLoggedWithInput,
      createNonce: serviceDelegates.createNonce,
      updateProjectSetting: hostDelegates.updateProjectSetting,
      run: hostDelegates.run,
      unitNames: hostDelegates.unitNames,
      systemdQuote: hostDelegates.systemdQuote,
      systemdPathValue: hostDelegates.systemdPathValue,
      systemdEnvValue: hostDelegates.systemdEnvValue,
      shellQuote: hostDelegates.shellQuote,
      readFilePrefix: hostDelegates.readFilePrefix,
      isWatchdogInitialized: hostDelegates.isWatchdogInitialized,
      isEffectivelyEmptyDir: hostDelegates.isEffectivelyEmptyDir
    });
  }
  return serviceAssembly;
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


module.exports = {
  activate,
  deactivate
};
