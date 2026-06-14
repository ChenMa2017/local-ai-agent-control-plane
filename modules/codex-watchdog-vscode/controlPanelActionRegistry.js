"use strict";

const { createControlPanelRootActions } = require("./controlPanelRootActions");
const { createControlPanelBootstrapActions } = require("./controlPanelBootstrapActions");
const { createControlPanelGuardActions } = require("./controlPanelGuardActions");

function createControlPanelActionRegistry({
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
}) {
  async function withProjectRoot(run) {
    const root = await getProjectRoot();
    if (root) {
      await run(root);
    }
  }

  return {
    ...createControlPanelRootActions({
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
      openLoginTerminal
    }),
    ...createControlPanelBootstrapActions({
      vscode,
      withProjectRoot,
      prepareProjectCommand,
      generateBootstrapConversationCommand,
      getBootstrapWorkflowHelpers,
      getProjectSetupHelpers,
      archiveAndResetBootstrapConversation
    }),
    ...createControlPanelGuardActions({
      getGuardCommands,
      openMorningBriefCommand,
      refreshGeneratedFilesCommand
    })
  };
}

module.exports = {
  createControlPanelActionRegistry
};
