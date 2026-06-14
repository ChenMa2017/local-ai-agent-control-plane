"use strict";

const {
  buildControlPanelStateHelpersArgs,
  buildControlPanelMessageHandlerArgs,
  buildControlPanelControllerArgs
} = require("./serviceControlPanelArgBuilders");

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
      controlPanelStateHelpers = createControlPanelStateHelpers(buildControlPanelStateHelpersArgs({
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
      }));
    }
    return controlPanelStateHelpers;
  }

  function getControlPanelMessageHandler() {
    if (!controlPanelMessageHandler) {
      controlPanelMessageHandler = createControlPanelActionHandler(buildControlPanelMessageHandlerArgs({
        vscode,
        getProjectCommands,
        bridges,
        getBootstrapWorkflowHelpers,
        getProjectSetupHelpers,
        getGuardCommands
      }));
    }
    return controlPanelMessageHandler;
  }

  function getControlPanelController() {
    if (!controlPanelController) {
      controlPanelController = createControlPanelController(buildControlPanelControllerArgs({
        vscode,
        getOutput,
        statusRefreshMs,
        emptyPanelOperationState,
        nextPanelOperationState,
        bridges,
        getProjectCommands,
        getControlPanelStateHelpers,
        getControlPanelMessageHandler
      }));
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
