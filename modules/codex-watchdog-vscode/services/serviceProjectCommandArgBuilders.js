"use strict";

function buildProjectCommandsArgs({
  vscode,
  fs,
  fsp,
  path,
  bridges,
  runtimeConfig,
  extensionSetting,
  defaultTimeoutMinutes,
  getBootstrapScaffoldingHelpers,
  getGeneratedFilesHelpers,
  getProjectSetupHelpers,
  getBootstrapWorkflowHelpers,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  openDocument
}) {
  return {
    vscode,
    fs,
    fsp,
    path,
    getProjectRoot: bridges.getProjectRoot,
    selectProjectRoot: bridges.selectProjectRoot,
    rememberProjectRoot: bridges.rememberProjectRoot,
    ensureCodexHome: bridges.ensureCodexHome,
    confirmLoginIfNeeded: bridges.confirmLoginIfNeeded,
    effectiveWatchdogSettings: bridges.effectiveWatchdogSettings,
    positiveNumberSetting: runtimeConfig.positiveNumberSetting,
    extensionSetting,
    defaultTimeoutMinutes,
    getBootstrapScaffoldingHelpers,
    getGeneratedFilesHelpers,
    getProjectSetupHelpers,
    getBootstrapWorkflowHelpers,
    writeBootstrapRuntimeState,
    emptyBootstrapRuntimeState,
    setPanelOperationState: bridges.setPanelOperationState,
    clearPanelOperationState: bridges.clearPanelOperationState,
    updateControlPanel: bridges.updateControlPanel,
    openDocument
  };
}

function buildGuardLifecycleArgs({
  createGuardLifecycle,
  vscode,
  getOutput,
  bridges,
  ensureDir,
  getProjectSetupHelpers,
  runLogged,
  commands,
  getControlPanelController,
  unitNames,
  openDocument
}) {
  return {
    createGuardLifecycle,
    args: {
      vscode,
      output: getOutput(),
      getProjectRoot: bridges.getProjectRoot,
      ensureDir,
      prepareProjectForGuard: getProjectSetupHelpers().prepareProjectForGuard,
      confirmTaskInstantiatedIfNeeded: getProjectSetupHelpers().confirmTaskInstantiatedIfNeeded,
      ensureCodexHome: bridges.ensureCodexHome,
      confirmLoginIfNeeded: bridges.confirmLoginIfNeeded,
      runLogged,
      watchdogCommandEnv: commands.watchdogCommandEnv,
      watchdogCommandTimeoutMs: commands.watchdogCommandTimeoutMs,
      setPanelOperationState: (data) => getControlPanelController().setPanelOperationState(data),
      clearPanelOperationState: () => getControlPanelController().clearPanelOperationState(),
      updateStatusBar: () => bridges.updateStatusBar(),
      unitNames,
      getTimerStatus: bridges.getTimerStatus,
      openDocument
    }
  };
}

module.exports = {
  buildProjectCommandsArgs,
  buildGuardLifecycleArgs
};
