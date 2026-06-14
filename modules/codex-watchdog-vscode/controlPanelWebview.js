"use strict";

const crypto = require("crypto");

function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

function createControlPanelWebview({
  vscode,
  output,
  getControlPanelStateHelpers,
  getControlPanelMessageHandler,
  updateStatusBar,
  getPanelOperationState
}) {
  let controlPanel;

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
    const stateHelpers = getControlPanelStateHelpers();
    controlPanel.webview.html = stateHelpers.renderControlPanel(
      await stateHelpers.getControlPanelState(getPanelOperationState()),
      createNonce()
    );
    await updateStatusBar();
  }

  return {
    openControlPanel,
    updateControlPanel
  };
}

module.exports = {
  createControlPanelWebview
};
