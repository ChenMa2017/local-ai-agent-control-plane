"use strict";

function createServiceProjectCommandAccessors({
  createProjectCommands,
  createGuardLifecycle,
  vscode,
  fs,
  fsp,
  path,
  ensureDir,
  getOutput,
  openDocument,
  getRuntimeConfigHelpers,
  bridges,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  extensionSetting,
  defaultTimeoutMinutes,
  runLogged,
  unitNames,
  getControlPanelController,
  getProjectSetupHelpers,
  getBootstrapWorkflowHelpers,
  getGeneratedFilesHelpers,
  getBootstrapScaffoldingHelpers
}) {
  let projectCommands;
  let guardCommands;

  function getProjectCommands() {
    if (!projectCommands) {
      const runtimeConfig = getRuntimeConfigHelpers();
      projectCommands = createProjectCommands({
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
      });
    }
    return projectCommands;
  }

  function getGuardCommands() {
    if (!guardCommands) {
      const commands = getProjectCommands();
      guardCommands = createGuardLifecycle({
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
      });
    }
    return guardCommands;
  }

  return {
    getProjectCommands,
    getGuardCommands
  };
}

module.exports = {
  createServiceProjectCommandAccessors
};
