"use strict";

const { createProjectCommandFlows } = require("./projectCommandFlows");
const { createProjectBootstrapCommands } = require("./projectBootstrapCommands");
const { createProjectRuntimeCommands } = require("./projectRuntimeCommands");

function createProjectCommands({
  vscode,
  fs,
  fsp,
  path,
  getProjectRoot,
  selectProjectRoot,
  rememberProjectRoot,
  ensureCodexHome,
  confirmLoginIfNeeded,
  effectiveWatchdogSettings,
  positiveNumberSetting,
  extensionSetting,
  defaultTimeoutMinutes,
  getBootstrapScaffoldingHelpers,
  getGeneratedFilesHelpers,
  getProjectSetupHelpers,
  getBootstrapWorkflowHelpers,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  setPanelOperationState,
  clearPanelOperationState,
  updateControlPanel,
  openDocument
}) {
  const projectCommandFlows = createProjectCommandFlows({
    vscode,
    ensureCodexHome,
    confirmLoginIfNeeded,
    getBootstrapScaffoldingHelpers,
    getGeneratedFilesHelpers,
    getProjectSetupHelpers,
    getBootstrapWorkflowHelpers,
    writeBootstrapRuntimeState,
    emptyBootstrapRuntimeState,
    setPanelOperationState,
    clearPanelOperationState,
    updateControlPanel,
    openDocument,
    path
  });
  const projectBootstrapCommands = createProjectBootstrapCommands({
    vscode,
    selectProjectRoot,
    rememberProjectRoot,
    getBootstrapScaffoldingHelpers
  });
  const projectRuntimeCommands = createProjectRuntimeCommands({
    vscode,
    fs,
    fsp,
    path,
    getProjectRoot,
    openDocument,
    effectiveWatchdogSettings,
    positiveNumberSetting,
    extensionSetting,
    defaultTimeoutMinutes
  });

  async function withProjectRoot(run) {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await run(root);
  }

  async function prepareProjectCommand() {
    await withProjectRoot((root) => projectCommandFlows.prepareProject(root));
  }

  async function generateBootstrapConversationCommand(rawText) {
    await withProjectRoot((root) => projectCommandFlows.generateBootstrapConversation(root, rawText));
  }

  async function refreshGeneratedFilesCommand() {
    await withProjectRoot((root) => projectCommandFlows.refreshGeneratedFiles(root));
  }

  async function prepareEveningHandoffCommand() {
    await withProjectRoot((root) => projectCommandFlows.prepareEveningHandoff(root));
  }

  return {
    selectProjectRootCommand: projectBootstrapCommands.selectProjectRootCommand,
    bootstrapProjectCommand: projectBootstrapCommands.bootstrapProjectCommand,
    createDemoProjectTemplateCommand: projectBootstrapCommands.createDemoProjectTemplateCommand,
    prepareProjectCommand,
    generateBootstrapConversationCommand,
    refreshGeneratedFilesCommand,
    prepareEveningHandoffCommand,
    openMorningBriefCommand: projectRuntimeCommands.openMorningBriefCommand,
    acceptStateUpdateCommand: projectRuntimeCommands.acceptStateUpdateCommand,
    showProjectRootSelected: projectBootstrapCommands.showProjectRootSelected,
    offerProjectInitialization: projectBootstrapCommands.offerProjectInitialization,
    isGuardPaused: projectRuntimeCommands.isGuardPaused,
    watchdogCommandEnv: projectRuntimeCommands.watchdogCommandEnv,
    watchdogCommandTimeoutMs: projectRuntimeCommands.watchdogCommandTimeoutMs
  };
}

module.exports = {
  createProjectCommands
};
