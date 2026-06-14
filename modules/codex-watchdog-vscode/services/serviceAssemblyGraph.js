"use strict";

const packageMetadata = require("../package.json");
const { createProjectRootManager } = require("../project/projectRootManager");
const { createRuntimeConfigHelpers } = require("../runtime/runtimeConfig");
const { createRuntimeHelpers } = require("../runtime/runtimeHelpers");
const { createProjectCommands } = require("../project/projectCommands");
const { createProjectSetupHelpers } = require("../project/projectSetup");
const { createBootstrapWorkflowHelpers } = require("../bootstrap/bootstrapWorkflow");
const { createGeneratedFilesHelpers } = require("../project/generatedFiles");
const { createBootstrapScaffoldingHelpers } = require("../bootstrap/bootstrapScaffolding");
const { createGuardLifecycle } = require("../guard/guardLifecycle");
const { createControlPanelStateHelpers } = require("../controlPanel/controlPanelState");
const { createControlPanelActionHandler } = require("../controlPanel/controlPanelActions");
const { createControlPanelController } = require("../controlPanel/controlPanelController");
const { createServiceAssemblyBridges } = require("./serviceBridges");
const { createServiceControlPanelFactory } = require("./serviceControlPanelFactory");
const { createServiceRuntimeFactory } = require("./serviceRuntimeFactory");
const { createServiceProjectFactory } = require("./serviceProjectFactory");
const {
  buildRuntimeServicesArgs,
  buildProjectServicesArgs,
  buildControlPanelServicesArgs
} = require("./serviceAssemblyGraphArgBuilders");
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
} = require("../bootstrap/bootstrapConversation");

function buildServiceAssemblyGraph({
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

  function getProjectSetupHelpers() {
    return projectServices.getProjectSetupHelpers();
  }

  function getBootstrapScaffoldingHelpers() {
    return projectServices.getBootstrapScaffoldingHelpers();
  }

  function getControlPanelController() {
    return controlPanelServices.getControlPanelController();
  }

  const runtimeServices = createServiceRuntimeFactory(buildRuntimeServicesArgs({
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
  }));
  const getProjectRootManager = runtimeServices.getProjectRootManager;
  const getRuntimeConfigHelpers = runtimeServices.getRuntimeConfigHelpers;
  const getRuntimeHelpers = runtimeServices.getRuntimeHelpers;

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

  projectServices = createServiceProjectFactory(buildProjectServicesArgs({
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
  }));

  controlPanelServices = createServiceControlPanelFactory(buildControlPanelServicesArgs({
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
  }));

  return {
    bridges,
    runtimeServices,
    projectServices,
    controlPanelServices,
    getProjectRootManager,
    getRuntimeConfigHelpers,
    getRuntimeHelpers
  };
}

module.exports = {
  buildServiceAssemblyGraph
};
