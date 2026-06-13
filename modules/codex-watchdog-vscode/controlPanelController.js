"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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
  let statusBarItem;
  let statusBarRefresh;
  let panelOperationState = emptyPanelOperationState();

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
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = "codexWatchdog.openControlPanel";
    statusBarItem.name = "Codex Watchdog";
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    statusBarRefresh = setInterval(() => {
      updateStatusBar();
    }, statusRefreshMs);
    context.subscriptions.push(new vscode.Disposable(() => {
      if (statusBarRefresh) {
        clearInterval(statusBarRefresh);
        statusBarRefresh = undefined;
      }
    }));

    updateStatusBar();
  }

  async function updateStatusBar() {
    if (!statusBarItem) {
      return;
    }

    const root = getKnownProjectRoot();
    if (!root) {
      statusBarItem.text = "$(circle-slash) Watchdog: No Project";
      statusBarItem.tooltip = "Codex Watchdog: select a project root";
      statusBarItem.backgroundColor = undefined;
      return;
    }

    if (!fs.existsSync(root)) {
      statusBarItem.text = "$(warning) Watchdog: Missing";
      statusBarItem.tooltip = `Codex Watchdog project root is missing:\n${root}`;
      statusBarItem.backgroundColor = undefined;
      return;
    }

    if (isGuardPaused(root)) {
      statusBarItem.text = "$(debug-pause) Watchdog: Paused";
      statusBarItem.tooltip = `Codex Watchdog is paused for:\n${root}`;
      statusBarItem.backgroundColor = undefined;
      return;
    }

    statusBarItem.text = "$(sync~spin) Watchdog: Checking";
    statusBarItem.tooltip = `Checking Codex Watchdog timer for:\n${root}`;

    try {
      const timer = await getTimerStatus(root);
      const projectName = path.basename(root) || root;
      if (timer.isActive) {
        statusBarItem.text = "$(watch) Watchdog: On";
      } else if (timer.isEnabled) {
        statusBarItem.text = "$(debug-pause) Watchdog: Enabled";
      } else {
        statusBarItem.text = "$(debug-stop) Watchdog: Off";
      }
      statusBarItem.tooltip = [
        `Project: ${projectName}`,
        root,
        "",
        timer.text
      ].join("\n");
      statusBarItem.backgroundColor = undefined;
    } catch (error) {
      statusBarItem.text = "$(warning) Watchdog: Unknown";
      statusBarItem.tooltip = `Could not read Codex Watchdog status:\n${error.message || String(error)}`;
      statusBarItem.backgroundColor = undefined;
    }
  }

  function deactivate() {
    if (statusBarRefresh) {
      clearInterval(statusBarRefresh);
      statusBarRefresh = undefined;
    }
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
