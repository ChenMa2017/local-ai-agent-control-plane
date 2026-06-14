"use strict";

const fs = require("fs");
const path = require("path");
const { createGuardStartFlow } = require("./guardStartFlow");
const { createGuardControlFlow } = require("./guardControlFlow");

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
  const guardControlFlow = createGuardControlFlow({
    fs,
    fsp: fs.promises,
    path,
    vscode,
    output,
    ensureDir,
    runLogged,
    watchdogCommandEnv,
    updateStatusBar,
    unitNames,
    getTimerStatus,
    openDocument
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
    await guardControlFlow.pauseGuard(root);
  }

  async function resumeGuardCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await guardControlFlow.resumeGuard(root);
  }

  async function stopGuardCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await guardControlFlow.stopGuard(root);
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
    await guardControlFlow.stopTimer(root);
  }

  async function showTimerStatusCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await guardControlFlow.showTimerStatus(root);
  }

  async function openLatestReportCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await guardControlFlow.openLatestReport(root);
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
