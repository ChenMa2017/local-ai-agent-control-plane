"use strict";

const { createControlPanelActionRegistry } = require("./controlPanelActionRegistry");

function createControlPanelActionHandler({
  vscode,
  getProjectRoot,
  selectProjectRoot,
  rememberProjectRoot,
  showProjectRootSelected,
  browseExistingProjectRoot,
  normalizeProjectRootInput,
  clearRememberedProjectRoot,
  updateProjectSetting,
  readWatcherUnitDrift,
  effectiveWatchdogSettings,
  updateControlPanel,
  openLoginTerminal,
  prepareProjectCommand,
  generateBootstrapConversationCommand,
  getBootstrapWorkflowHelpers,
  getProjectSetupHelpers,
  archiveAndResetBootstrapConversation,
  getGuardCommands,
  openMorningBriefCommand,
  refreshGeneratedFilesCommand
}) {
  const actionRegistry = createControlPanelActionRegistry({
    vscode,
    getProjectRoot,
    selectProjectRoot,
    rememberProjectRoot,
    showProjectRootSelected,
    browseExistingProjectRoot,
    normalizeProjectRootInput,
    clearRememberedProjectRoot,
    updateProjectSetting,
    readWatcherUnitDrift,
    effectiveWatchdogSettings,
    openLoginTerminal,
    prepareProjectCommand,
    generateBootstrapConversationCommand,
    getBootstrapWorkflowHelpers,
    getProjectSetupHelpers,
    archiveAndResetBootstrapConversation,
    getGuardCommands,
    openMorningBriefCommand,
    refreshGeneratedFilesCommand
  });

  return async function handleControlPanelMessage(message) {
    const command = message && message.command;
    const action = actionRegistry[command];
    if (!action) {
      return;
    }
    await action(message || {});
    await updateControlPanel();
  };
}

module.exports = {
  createControlPanelActionHandler
};
