"use strict";

const { createProjectCommandFlows } = require("./projectCommandFlows");
const { createProjectBootstrapCommands } = require("./projectBootstrapCommands");
const { createProjectFlowCommands } = require("./projectFlowCommands");
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
  const projectFlowCommands = createProjectFlowCommands({
    getProjectRoot,
    projectCommandFlows
  });

  return {
    selectProjectRootCommand: projectBootstrapCommands.selectProjectRootCommand,
    bootstrapProjectCommand: projectBootstrapCommands.bootstrapProjectCommand,
    createDemoProjectTemplateCommand: projectBootstrapCommands.createDemoProjectTemplateCommand,
    prepareProjectCommand: projectFlowCommands.prepareProjectCommand,
    generateBootstrapConversationCommand: projectFlowCommands.generateBootstrapConversationCommand,
    refreshGeneratedFilesCommand: projectFlowCommands.refreshGeneratedFilesCommand,
    prepareEveningHandoffCommand: projectFlowCommands.prepareEveningHandoffCommand,
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
