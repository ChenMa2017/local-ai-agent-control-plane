"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { createGuardStartFlow } = require("./guardStartFlow");

function createGuardLifecycle({
  vscode,
  output,
  getProjectRoot,
  ensureDir,
  prepareProjectForGuard,
  confirmTaskInstantiatedIfNeeded,
  ensureCodexHome,
  confirmLoginIfNeeded,
  runLogged,
  watchdogCommandEnv,
  watchdogCommandTimeoutMs,
  setPanelOperationState,
  clearPanelOperationState,
  updateStatusBar,
  unitNames,
  getTimerStatus,
  openDocument
}) {
  const guardStartFlow = createGuardStartFlow({
    vscode,
    output,
    prepareProjectForGuard,
    confirmTaskInstantiatedIfNeeded,
    ensureCodexHome,
    confirmLoginIfNeeded,
    runLogged,
    watchdogCommandEnv,
    watchdogCommandTimeoutMs,
    setPanelOperationState,
    clearPanelOperationState,
    updateStatusBar,
    path
  });

  async function startGuardCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await guardStartFlow.runGuardStartFlow({
      root,
      progressTitle: "Starting Codex Watchdog guard",
      prepareMessage: "Preparing generated files",
      prepareDetail: "Refreshing generated watchdog files and checking project readiness...",
      codexHomeMessage: "Preparing Codex home",
      codexHomeDetail: "Checking CODEX_HOME and login state before unattended mode starts...",
      startMessage: "Running one wakeup, then starting timer",
      startDetail: "Running one immediate watchdog wakeup, then enabling the repeating timer...",
      logHeading: "Start Guard",
      successMessage: "Codex Watchdog guard started. Future operations can use ./agent/bin/watchdog."
    });
  }

  async function pauseGuardCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await ensureDir(path.join(root, "agent", "control"));
    const pauseFile = path.join(root, "agent", "control", "PAUSE");
    await fsp.writeFile(pauseFile, [
      `Paused at: ${new Date().toISOString()}`,
      "Reason: paused from VSCode control panel",
      ""
    ].join("\n"));
    vscode.window.showInformationMessage("Codex Watchdog guard paused. Timer may still fire, but run_watchdog.sh will not call Codex while PAUSE exists.");
    await updateStatusBar();
  }

  async function resumeGuardCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const pauseFile = path.join(root, "agent", "control", "PAUSE");
    if (fs.existsSync(pauseFile)) {
      await fsp.unlink(pauseFile);
    }
    vscode.window.showInformationMessage("Codex Watchdog guard resumed.");
    await updateStatusBar();
  }

  async function stopGuardCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }

    const cli = path.join(root, "agent", "bin", "watchdog");
    if (fs.existsSync(cli)) {
      output.show(true);
      output.appendLine(`\n# ${new Date().toISOString()} Stop Guard`);
      output.appendLine(`Project root: ${root}`);
      const result = await runLogged(cli, ["stop"], {
        cwd: root,
        env: await watchdogCommandEnv(root),
        allowFailure: true,
        timeout: 60000
      });
      await showStopOutcome(root, result, "guard");
      await updateStatusBar();
      return;
    }

    await stopTimerCommand();
  }

  async function runOnceCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await prepareProjectForGuard(root);
    const taskReady = await confirmTaskInstantiatedIfNeeded(root);
    if (!taskReady) {
      return;
    }
    await ensureCodexHome(root);
    const canContinue = await confirmLoginIfNeeded(root);
    if (!canContinue) {
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: "Codex Watchdog",
      cwd: root,
      env: await watchdogCommandEnv(root)
    });
    terminal.show();
    terminal.sendText("./agent/bin/watchdog run-once");
  }

  async function startTimerCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await guardStartFlow.runGuardStartFlow({
      root,
      progressTitle: "Running Codex Watchdog once, then starting timer",
      prepareMessage: "Refreshing project state",
      prepareDetail: "Refreshing the project, checking login, then launching one wakeup before the timer starts...",
      codexHomeMessage: "Preparing Codex home",
      codexHomeDetail: "Checking CODEX_HOME and login state before the timer starts unattended runs...",
      startMessage: "Executing immediate wakeup",
      startDetail: "Executing one immediate watchdog cycle and enabling the repeating timer...",
      logHeading: "Run Once And Start Timer",
      successMessage: "Codex Watchdog immediate wakeup succeeded and timer started."
    });
  }

  async function stopTimerCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const units = unitNames(root);
    const result = await runLogged("systemctl", ["--user", "disable", "--now", units.timer], { allowFailure: true });
    await showStopOutcome(root, result, "timer");
    await updateStatusBar();
  }

  async function showStopOutcome(root, result, label) {
    const timer = await getTimerStatus(root);
    if (result && result.error) {
      vscode.window.showWarningMessage(`Codex Watchdog ${label} stop command reported an error. Check the Codex Watchdog output channel.`);
      return;
    }
    if (timer.isActive || timer.isEnabled) {
      vscode.window.showWarningMessage(`Codex Watchdog ${label} may still be active or enabled. Check timer status in the output channel.`);
      output.show(true);
      output.appendLine(timer.text);
      return;
    }
    vscode.window.showInformationMessage(`Codex Watchdog ${label} stopped.`);
  }

  async function showTimerStatusCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const units = unitNames(root);
    output.show(true);
    output.appendLine(`\n# ${new Date().toISOString()} ${units.timer}`);
    await runLogged("systemctl", ["--user", "status", units.timer, "--no-pager"], { allowFailure: true });
    await runLogged("systemctl", ["--user", "list-timers", units.timer, "--no-pager"], { allowFailure: true });
  }

  async function openLatestReportCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const latest = path.join(root, "agent", "reports", "latest.md");
    if (!fs.existsSync(latest)) {
      vscode.window.showWarningMessage("No latest report exists yet. Run Codex Watchdog once first.");
      return;
    }
    await openDocument(latest, false);
  }

  return {
    startGuardCommand,
    pauseGuardCommand,
    resumeGuardCommand,
    stopGuardCommand,
    runOnceCommand,
    startTimerCommand,
    stopTimerCommand,
    showTimerStatusCommand,
    openLatestReportCommand
  };
}

module.exports = {
  createGuardLifecycle
};
