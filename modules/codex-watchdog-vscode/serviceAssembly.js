"use strict";

const packageMetadata = require("./package.json");
const { createProjectRootManager } = require("./projectRootManager");
const { createRuntimeConfigHelpers } = require("./runtimeConfig");
const { createRuntimeHelpers } = require("./runtimeHelpers");
const { createProjectCommands } = require("./projectCommands");
const { createProjectSetupHelpers } = require("./projectSetup");
const { createBootstrapWorkflowHelpers } = require("./bootstrapWorkflow");
const { createGeneratedFilesHelpers } = require("./generatedFiles");
const { createBootstrapScaffoldingHelpers } = require("./bootstrapScaffolding");
const { createGuardLifecycle } = require("./guardLifecycle");
const { createControlPanelStateHelpers } = require("./controlPanelState");
const { createControlPanelActionHandler } = require("./controlPanelActions");
const { createControlPanelController } = require("./controlPanelController");
const { activateWatchdogServices, registerWatchdogCommand } = require("./serviceActivation");
const { createServiceAssemblyBridges } = require("./serviceBridges");
const { createServiceControlPanelFactory } = require("./serviceControlPanelFactory");
const { createServiceRuntimeFactory } = require("./serviceRuntimeFactory");
const { createServiceProjectFactory } = require("./serviceProjectFactory");
const {
  bootstrapChangePreviewPath,
  bootstrapConversationMarkdownPath,
  bootstrapConversationPromptText,
  bootstrapConversationTurnSchemaPath,
  bootstrapLastResultPath,
  bootstrapResultSchemaPath,
  bootstrapInstantiationPromptText,
  emptyBootstrapRuntimeState,
  getBootstrapConversationState,
  readBootstrapConversation,
  writeBootstrapConversation,
  writeBootstrapRuntimeState,
  clearBootstrapDraftArtifacts,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
} = require("./bootstrapConversation");

function createServiceAssembly({
  vscode,
  fs,
  fsp,
  path,
  os,
  crypto,
  getOutput,
  getExtensionContext,
  projectRootKey,
  statusRefreshMs,
  defaultIntervalMinutes,
  defaultTimeoutMinutes,
  defaultCompactEveryRuns,
  defaultPhaseOffsetMinutes,
  defaultWatchdogRole,
  defaultSupervisorAuditEveryRunnerRuns,
  defaultSupervisorLightFollowup,
  defaultServicePrefix,
  loginReadyRe,
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
}) {
  let controlPanelServices;
  let projectServices;
  const runtimeServices = createServiceRuntimeFactory({
    createProjectRootManager,
    createRuntimeConfigHelpers,
    createRuntimeHelpers,
    vscode,
    fs,
    fsp,
    path,
    os,
    getOutput,
    getExtensionContext,
    projectRootKey,
    extensionSetting,
    extensionSettingWithSource,
    projectSetting,
    projectSettingWithSource,
    expandHome,
    isExistingDirectory,
    isSafeProjectRootPath,
    validateProjectRootPath,
    ensureDir,
    requireExistingDirectory,
    defaultWatchdogRole,
    defaultServicePrefix,
    loginReadyRe,
    resolveCodexBin,
    updateProjectSetting,
    defaultTimeoutMinutes,
    defaultIntervalMinutes,
    defaultCompactEveryRuns,
    defaultPhaseOffsetMinutes,
    defaultSupervisorLightFollowup,
    defaultSupervisorAuditEveryRunnerRuns,
    run,
    unitNames,
    systemdQuote,
    systemdPathValue,
    systemdEnvValue,
    shellQuote,
    readFilePrefix,
    updateStatusBar: () => controlPanelServices
      ? controlPanelServices.getControlPanelController().updateStatusBar()
      : Promise.resolve()
  });
  const getProjectRootManager = runtimeServices.getProjectRootManager;
  const getRuntimeConfigHelpers = runtimeServices.getRuntimeConfigHelpers;
  const getRuntimeHelpers = runtimeServices.getRuntimeHelpers;
  const getProjectSetupHelpers = () => projectServices.getProjectSetupHelpers();
  const getBootstrapScaffoldingHelpers = () => projectServices.getBootstrapScaffoldingHelpers();
  const bridges = createServiceAssemblyBridges({
    getProjectRootManager,
    getRuntimeHelpers,
    getBootstrapScaffoldingHelpers,
    getControlPanelController,
    getProjectSetupHelpers,
    resolveCodexBin,
    updateProjectSetting,
    archiveAndResetBootstrapConversation
  });
  projectServices = createServiceProjectFactory({
    createProjectSetupHelpers,
    createBootstrapWorkflowHelpers,
    createGeneratedFilesHelpers,
    createBootstrapScaffoldingHelpers,
    createProjectCommands,
    createGuardLifecycle,
    vscode,
    fs,
    fsp,
    path,
    crypto,
    packageVersion: packageMetadata.version,
    templates,
    ensureDir,
    getOutput,
    openDocument,
    getRuntimeConfigHelpers,
    bridges,
    bootstrapConversationTurnSchemaPath,
    bootstrapResultSchemaPath,
    bootstrapLastResultPath,
    bootstrapConversationPromptText,
    bootstrapInstantiationPromptText,
    bootstrapConversationMarkdownPath,
    bootstrapChangePreviewPath,
    readBootstrapConversation,
    writeBootstrapConversation,
    clearBootstrapDraftArtifacts,
    runLoggedWithInput,
    createNonce,
    stageBootstrapDraftFiles,
    applyBootstrapDraftFiles,
    writeBootstrapRuntimeState,
    emptyBootstrapRuntimeState,
    extensionSetting,
    defaultTimeoutMinutes,
    isWatchdogInitialized,
    isEffectivelyEmptyDir,
    runLogged,
    unitNames,
    getControlPanelController: () => controlPanelServices.getControlPanelController()
  });
  controlPanelServices = createServiceControlPanelFactory({
    createControlPanelStateHelpers,
    createControlPanelActionHandler,
    createControlPanelController,
    vscode,
    getOutput,
    statusRefreshMs,
    emptyPanelOperationState,
    nextPanelOperationState,
    defaultTimeoutMinutes,
    defaultIntervalMinutes,
    defaultCompactEveryRuns,
    extensionSetting,
    isWatchdogInitialized,
    getProjectSetupHelpers: projectServices.getProjectSetupHelpers,
    getProjectCommands: projectServices.getProjectCommands,
    getRuntimeConfigHelpers,
    getBootstrapWorkflowHelpers: projectServices.getBootstrapWorkflowHelpers,
    getGuardCommands: projectServices.getGuardCommands,
    bridges,
    getBootstrapConversationState,
    readFilePrefix
  });

  function getControlPanelStateHelpers() {
    return controlPanelServices.getControlPanelStateHelpers();
  }

  function getControlPanelMessageHandler() {
    return controlPanelServices.getControlPanelMessageHandler();
  }

  function getControlPanelController() {
    return controlPanelServices.getControlPanelController();
  }

  function activate(context) {
    projectServices.getProjectSetupHelpers();
    projectServices.getBootstrapWorkflowHelpers();
    projectServices.getProjectCommands();
    projectServices.getGuardCommands();
    projectServices.getBootstrapScaffoldingHelpers();
    getControlPanelStateHelpers();
    getControlPanelMessageHandler();
    getControlPanelController();

    activateWatchdogServices({
      registerCommand: (command, handler) => registerWatchdogCommand({
        context,
        vscode,
        output: getOutput(),
        updateStatusBar: () => bridges.updateStatusBar()
      }, command, handler),
      initializeStatusBar: () => bridges.initializeStatusBar(context),
      openControlPanelCommand: bridges.openControlPanelCommand,
      projectCommands: projectServices.getProjectCommands(),
      guardCommands: projectServices.getGuardCommands()
    });
  }

  function deactivate() {
    controlPanelServices.deactivate();
  }

  return {
    activate,
    deactivate,
    ...bridges,
    getProjectSetupHelpers: projectServices.getProjectSetupHelpers,
    getProjectRootManager,
    getBootstrapWorkflowHelpers: projectServices.getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers: projectServices.getGeneratedFilesHelpers,
    getBootstrapScaffoldingHelpers: projectServices.getBootstrapScaffoldingHelpers,
    getRuntimeConfigHelpers,
    getRuntimeHelpers,
    getProjectCommands: projectServices.getProjectCommands,
    getGuardCommands: projectServices.getGuardCommands,
    getControlPanelStateHelpers,
    getControlPanelMessageHandler,
    getControlPanelController
  };
}

module.exports = {
  createServiceAssembly
};
