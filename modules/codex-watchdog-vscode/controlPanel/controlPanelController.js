"use strict";

const { createControlPanelStatusBar } = require("./controlPanelStatusBar");
const { createControlPanelWebview } = require("./controlPanelWebview");

function createControlPanelController({
  vscode,
  output,
  statusRefreshMs,
  emptyPanelOperationState,
  nextPanelOperationState,
  getKnownProjectRoot,
  isGuardPaused,
  getTimerStatus,
  getControlPanelStateHelpers,
  getControlPanelMessageHandler
}) {
  let panelOperationState = emptyPanelOperationState();
  const statusBar = createControlPanelStatusBar({
    vscode,
    statusRefreshMs,
    getKnownProjectRoot,
    isGuardPaused,
    getTimerStatus
  });
  const webview = createControlPanelWebview({
    vscode,
    output,
    getControlPanelStateHelpers,
    getControlPanelMessageHandler,
    updateStatusBar,
    getPanelOperationState: () => panelOperationState
  });

  async function setPanelOperationState(data) {
    panelOperationState = nextPanelOperationState(panelOperationState, data);
    await webview.updateControlPanel();
  }

  async function clearPanelOperationState() {
    panelOperationState = emptyPanelOperationState();
    await webview.updateControlPanel();
  }

  function initializeStatusBar(context) {
    statusBar.initialize(context);
  }

  async function updateStatusBar() {
    await statusBar.update();
  }

  function deactivate() {
    statusBar.deactivate();
  }

  return {
    openControlPanel: webview.openControlPanel,
    updateControlPanel: webview.updateControlPanel,
    setPanelOperationState,
    clearPanelOperationState,
    initializeStatusBar,
    updateStatusBar,
    deactivate
  };
}

module.exports = {
  createControlPanelController
};
