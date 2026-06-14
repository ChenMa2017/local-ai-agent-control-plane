"use strict";

function createBaseControlPanelState({
  root,
  rootExists,
  initialized,
  taskReady,
  paused
}) {
  return {
    root: root || "",
    rootExists: Boolean(rootExists),
    initialized: Boolean(initialized),
    taskReady: Boolean(taskReady),
    paused: Boolean(paused),
    codexHome: "",
    codexHomeNotice: "",
    codexBin: "",
    sandboxMode: "",
    timeoutMinutes: "",
    intervalMinutes: "",
    compactEveryRuns: "",
    login: { ok: false, text: "Select a project root first.", bootstrapText: "", canSeedFromMainAuth: false },
    timer: { text: "Unavailable", isActive: false, isEnabled: false, activeText: "unknown", enabledText: "unknown", needsReinstall: false, warningText: "" },
    runtime: { queueText: "", signals: [] },
    latestReport: "",
    latestSummary: "",
    bootstrap: {
      messages: [],
      openQuestions: [],
      readyForStartGuard: false,
      draftText: "",
      isRunning: false,
      runtimeDetail: "",
      runtimeStartedAt: "",
      statusText: "Prepare the project, then describe the watchdog objective here."
    },
    operation: {
      isRunning: false,
      title: "",
      detail: "",
      startedAt: ""
    },
    nextStep: "Select a project root, then start the guard."
  };
}

function applyResolvedRuntimeState(state, {
  codexHome,
  codexHomeNotice,
  codexBin,
  sandboxMode,
  timeoutMinutes,
  intervalMinutes,
  compactEveryRuns,
  login,
  timer,
  runtime,
  timerNeedsReinstall,
  timerWarningText
}) {
  state.codexHome = codexHome;
  state.codexHomeNotice = codexHomeNotice || "";
  state.codexBin = codexBin;
  state.sandboxMode = sandboxMode;
  state.timeoutMinutes = String(timeoutMinutes);
  state.intervalMinutes = String(intervalMinutes);
  state.compactEveryRuns = String(compactEveryRuns);
  state.login = login;
  state.timer = timer;
  state.runtime = runtime;
  state.timer.needsReinstall = Boolean(timerNeedsReinstall);
  state.timer.warningText = timerWarningText || "";
  return state;
}

function applyConfigurationErrorState(state, message) {
  state.login = {
    ok: false,
    text: `Configuration error:\n${message}`,
    bootstrapText: "",
    canSeedFromMainAuth: false
  };
  state.timer = {
    text: "Unavailable until configuration is fixed.",
    isActive: false,
    isEnabled: false,
    activeText: "unknown",
    enabledText: "unknown",
    needsReinstall: false,
    warningText: ""
  };
  state.nextStep = "Fix the project-local watchdog configuration, then refresh status.";
  return state;
}

function createOperationState(panelOperationState) {
  return {
    isRunning: panelOperationState && panelOperationState.status === "running",
    title: String(panelOperationState && panelOperationState.title || ""),
    detail: String(panelOperationState && panelOperationState.detail || ""),
    startedAt: String(panelOperationState && panelOperationState.startedAt || "")
  };
}

function applyLatestReportState(state, { latestReport, latestSummary }) {
  state.latestReport = latestReport || "";
  state.latestSummary = latestSummary || "";
  return state;
}

module.exports = {
  createBaseControlPanelState,
  applyResolvedRuntimeState,
  applyConfigurationErrorState,
  createOperationState,
  applyLatestReportState
};
