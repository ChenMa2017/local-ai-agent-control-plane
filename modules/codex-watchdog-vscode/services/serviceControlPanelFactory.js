"use strict";

const { createServiceControlPanelAccessors } = require("./serviceControlPanelAccessors");

function createServiceControlPanelFactory({
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
  return createServiceControlPanelAccessors({
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
  });
}

module.exports = {
  createServiceControlPanelFactory
};
