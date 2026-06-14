"use strict";

const fs = require("fs");
const path = require("path");

function createControlPanelStatusBar({
  vscode,
  statusRefreshMs,
  getKnownProjectRoot,
  isGuardPaused,
  getTimerStatus
}) {
  let statusBarItem;
  let statusBarRefresh;

  function initialize(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = "codexWatchdog.openControlPanel";
    statusBarItem.name = "Codex Watchdog";
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    statusBarRefresh = setInterval(() => {
      update();
    }, statusRefreshMs);
    context.subscriptions.push(new vscode.Disposable(() => {
      if (statusBarRefresh) {
        clearInterval(statusBarRefresh);
        statusBarRefresh = undefined;
      }
    }));

    update();
  }

  async function update() {
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
    initialize,
    update,
    deactivate
  };
}

module.exports = {
  createControlPanelStatusBar
};
