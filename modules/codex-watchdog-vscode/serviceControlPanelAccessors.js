"use strict";

function createServiceControlPanelAccessors({
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
  getProjectSetupHelpers,
  getProjectCommands,
  getRuntimeConfigHelpers,
  getBootstrapWorkflowHelpers,
  getGuardCommands,
  bridges,
  getBootstrapConversationState,
  readFilePrefix
}) {
  let controlPanelStateHelpers;
  let controlPanelMessageHandler;
  let controlPanelController;

  function getControlPanelStateHelpers() {
    if (!controlPanelStateHelpers) {
      const runtimeConfig = getRuntimeConfigHelpers();
      const commands = getProjectCommands();
      controlPanelStateHelpers = createControlPanelStateHelpers({
        getKnownProjectRoot: bridges.getKnownProjectRoot,
        isWatchdogInitialized,
        getProjectSetupHelpers,
        isGuardPaused: commands.isGuardPaused,
        codexHomePlan: runtimeConfig.codexHomePlan,
        resolveCodexBin: bridges.resolveCodexBin,
        sandboxModeSetting: runtimeConfig.sandboxModeSetting,
        positiveNumberSetting: runtimeConfig.positiveNumberSetting,
        extensionSetting,
        DEFAULT_TIMEOUT_MINUTES: defaultTimeoutMinutes,
        DEFAULT_INTERVAL_MINUTES: defaultIntervalMinutes,
        DEFAULT_COMPACT_EVERY_RUNS: defaultCompactEveryRuns,
        getCodexLoginStatus: bridges.getCodexLoginStatus,
        getTimerStatus: bridges.getTimerStatus,
        inspectProjectRuntimeClarity: bridges.inspectProjectRuntimeClarity,
        effectiveWatchdogSettings: bridges.effectiveWatchdogSettings,
        readWatcherUnitDrift: bridges.readWatcherUnitDrift,
        getBootstrapConversationState,
        readFilePrefix
      });
    }
    return controlPanelStateHelpers;
  }

  function getControlPanelMessageHandler() {
    if (!controlPanelMessageHandler) {
      const commands = getProjectCommands();
      controlPanelMessageHandler = createControlPanelActionHandler({
        vscode,
        getProjectRoot: bridges.getProjectRoot,
        selectProjectRoot: bridges.selectProjectRoot,
        rememberProjectRoot: bridges.rememberProjectRoot,
        showProjectRootSelected: commands.showProjectRootSelected,
        browseExistingProjectRoot: bridges.browseExistingProjectRoot,
        normalizeProjectRootInput: bridges.normalizeProjectRootInput,
        clearRememberedProjectRoot: bridges.clearRememberedProjectRoot,
        updateProjectSetting: bridges.updateProjectSetting,
        readWatcherUnitDrift: bridges.readWatcherUnitDrift,
        effectiveWatchdogSettings: bridges.effectiveWatchdogSettings,
        updateControlPanel: bridges.updateControlPanel,
        openLoginTerminal: bridges.openLoginTerminal,
        prepareProjectCommand: commands.prepareProjectCommand,
        generateBootstrapConversationCommand: commands.generateBootstrapConversationCommand,
        getBootstrapWorkflowHelpers,
        getProjectSetupHelpers,
        archiveAndResetBootstrapConversation: bridges.archiveAndResetBootstrapConversation,
        getGuardCommands,
        openMorningBriefCommand: commands.openMorningBriefCommand,
        refreshGeneratedFilesCommand: commands.refreshGeneratedFilesCommand
      });
    }
    return controlPanelMessageHandler;
  }

  function getControlPanelController() {
    if (!controlPanelController) {
      const commands = getProjectCommands();
      controlPanelController = createControlPanelController({
        vscode,
        output: getOutput(),
        statusRefreshMs,
        emptyPanelOperationState,
        nextPanelOperationState,
        getKnownProjectRoot: bridges.getKnownProjectRoot,
        isGuardPaused: commands.isGuardPaused,
        getTimerStatus: bridges.getTimerStatus,
        getControlPanelStateHelpers,
        getControlPanelMessageHandler
      });
    }
    return controlPanelController;
  }

  function deactivate() {
    if (controlPanelController) {
      controlPanelController.deactivate();
    }
  }

  return {
    getControlPanelStateHelpers,
    getControlPanelMessageHandler,
    getControlPanelController,
    deactivate
  };
}

module.exports = {
  createServiceControlPanelAccessors
};
