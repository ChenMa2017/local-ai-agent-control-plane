"use strict";

function buildControlPanelStateHelpersArgs({
  getRuntimeConfigHelpers,
  getProjectCommands,
  bridges,
  isWatchdogInitialized,
  getProjectSetupHelpers,
  extensionSetting,
  defaultTimeoutMinutes,
  defaultIntervalMinutes,
  defaultCompactEveryRuns,
  getBootstrapConversationState,
  readFilePrefix
}) {
  const runtimeConfig = getRuntimeConfigHelpers();
  const commands = getProjectCommands();
  return {
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
  };
}

function buildControlPanelMessageHandlerArgs({
  vscode,
  getProjectCommands,
  bridges,
  getBootstrapWorkflowHelpers,
  getProjectSetupHelpers,
  getGuardCommands
}) {
  const commands = getProjectCommands();
  return {
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
  };
}

function buildControlPanelControllerArgs({
  vscode,
  getOutput,
  statusRefreshMs,
  emptyPanelOperationState,
  nextPanelOperationState,
  bridges,
  getProjectCommands,
  getControlPanelStateHelpers,
  getControlPanelMessageHandler
}) {
  const commands = getProjectCommands();
  return {
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
  };
}

module.exports = {
  buildControlPanelStateHelpersArgs,
  buildControlPanelMessageHandlerArgs,
  buildControlPanelControllerArgs
};
