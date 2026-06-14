"use strict";

const crypto = require("crypto");
const { createControlPanelStatusBar } = require("./controlPanelStatusBar");

function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

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
  let controlPanel;
  let panelOperationState = emptyPanelOperationState();
  const statusBar = createControlPanelStatusBar({
    vscode,
    statusRefreshMs,
    getKnownProjectRoot,
    isGuardPaused,
    getTimerStatus
  });

  async function openControlPanel() {
    if (controlPanel) {
      controlPanel.reveal(vscode.ViewColumn.One);
      await updateControlPanel();
      return;
    }

    controlPanel = vscode.window.createWebviewPanel(
      "codexWatchdogControl",
      "Codex Watchdog",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    controlPanel.onDidDispose(() => {
      controlPanel = undefined;
    });
    controlPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        await getControlPanelMessageHandler()(message);
      } catch (error) {
        const text = error && error.message ? error.message : String(error);
        vscode.window.showErrorMessage(`Codex Watchdog: ${text}`);
        output.appendLine(`[control-panel error] ${text}`);
        await updateControlPanel();
      }
    });

    await updateControlPanel();
  }

  async function updateControlPanel() {
    if (!controlPanel) {
      await updateStatusBar();
      return;
    }
    controlPanel.webview.html = getControlPanelStateHelpers().renderControlPanel(
      await getControlPanelStateHelpers().getControlPanelState(panelOperationState),
      createNonce()
    );
    await updateStatusBar();
  }

  async function setPanelOperationState(data) {
    panelOperationState = nextPanelOperationState(panelOperationState, data);
    await updateControlPanel();
  }

  async function clearPanelOperationState() {
    panelOperationState = emptyPanelOperationState();
    await updateControlPanel();
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
    openControlPanel,
    updateControlPanel,
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
