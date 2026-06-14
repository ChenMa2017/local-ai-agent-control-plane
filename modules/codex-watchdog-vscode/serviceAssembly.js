"use strict";

const { activateWatchdogServices, registerWatchdogCommand } = require("./serviceActivation");
const { createServiceAssemblyControlPanelAccessors } = require("./serviceAssemblyControlPanelAccessors");
const { activateServiceAssembly } = require("./serviceAssemblyActivation");
const { buildServiceAssemblyGraph } = require("./serviceAssemblyGraph");

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
  const {
    bridges,
    runtimeServices,
    projectServices,
    controlPanelServices,
    getProjectRootManager,
    getRuntimeConfigHelpers,
    getRuntimeHelpers
  } = buildServiceAssemblyGraph({
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
  });
  const controlPanelAccessors = createServiceAssemblyControlPanelAccessors({
    getControlPanelServices: () => controlPanelServices
  });

  function getControlPanelStateHelpers() {
    return controlPanelAccessors.getControlPanelStateHelpers();
  }

  function getControlPanelMessageHandler() {
    return controlPanelAccessors.getControlPanelMessageHandler();
  }

  function getControlPanelController() {
    return controlPanelAccessors.getControlPanelController();
  }

  function activate(context) {
    activateServiceAssembly({
      context,
      projectServices,
      controlPanelAccessors,
      activateWatchdogServices,
      registerWatchdogCommand,
      vscode,
      getOutput,
      bridges
    });
  }

  function deactivate() {
    controlPanelAccessors.deactivate();
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
