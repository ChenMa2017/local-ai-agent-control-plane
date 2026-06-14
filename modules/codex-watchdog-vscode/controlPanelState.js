"use strict";

const fs = require("fs");
const path = require("path");
const { renderControlPanel } = require("./controlPanelRenderer");

function emptyPanelOperationState() {
  return {
    status: "idle",
    title: "",
    detail: "",
    startedAt: ""
  };
}

function nextPanelOperationState(previousState, data) {
  const previous = previousState || emptyPanelOperationState();
  return {
    status: "running",
    title: String(data && data.title || ""),
    detail: String(data && data.detail || ""),
    startedAt: String(data && data.startedAt || previous.startedAt || new Date().toISOString())
  };
}

function createControlPanelStateHelpers({
  getKnownProjectRoot,
  isWatchdogInitialized,
  getProjectSetupHelpers,
  isGuardPaused,
  codexHomePlan,
  resolveCodexBin,
  sandboxModeSetting,
  positiveNumberSetting,
  extensionSetting,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_COMPACT_EVERY_RUNS,
  getCodexLoginStatus,
  getTimerStatus,
  inspectProjectRuntimeClarity,
  effectiveWatchdogSettings,
  readWatcherUnitDrift,
  getBootstrapConversationState,
  readFilePrefix
}) {
  async function getControlPanelState(panelOperationState) {
    const root = getKnownProjectRoot();
    const projectSetupHelpers = getProjectSetupHelpers();
    const state = {
      root: root || "",
      rootExists: Boolean(root && fs.existsSync(root)),
      initialized: Boolean(root && fs.existsSync(root) && isWatchdogInitialized(root)),
      taskReady: Boolean(root && fs.existsSync(root) && isWatchdogInitialized(root) && projectSetupHelpers.taskLooksInstantiated(root)),
      paused: Boolean(root && fs.existsSync(root) && isGuardPaused(root)),
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

    if (!root || !fs.existsSync(root)) {
      state.nextStep = getControlPanelNextStep(state);
      return state;
    }

    try {
      const codexHome = codexHomePlan(root);
      state.codexHome = codexHome.effectivePath;
      state.codexHomeNotice = codexHome.migrationReason || "";
      state.codexBin = await resolveCodexBin(root);
      state.sandboxMode = sandboxModeSetting(root);
      state.timeoutMinutes = String(positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", DEFAULT_TIMEOUT_MINUTES), 1, DEFAULT_TIMEOUT_MINUTES));
      state.intervalMinutes = String(positiveNumberSetting(root, "codexWatchdog.intervalMinutes", extensionSetting("intervalMinutes", DEFAULT_INTERVAL_MINUTES), 5, DEFAULT_INTERVAL_MINUTES));
      state.compactEveryRuns = String(positiveNumberSetting(root, "codexWatchdog.compactEveryRuns", extensionSetting("compactEveryRuns", DEFAULT_COMPACT_EVERY_RUNS), 0, DEFAULT_COMPACT_EVERY_RUNS));
      state.login = await getCodexLoginStatus(root);
      state.timer = await getTimerStatus(root);
      state.runtime = inspectProjectRuntimeClarity(root);
      const settings = await effectiveWatchdogSettings(root);
      const timerDrift = readWatcherUnitDrift(root, settings);
      state.timer.needsReinstall = timerDrift.needsReinstall;
      state.timer.warningText = timerDrift.text;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      state.login = { ok: false, text: `Configuration error:\n${message}`, bootstrapText: "", canSeedFromMainAuth: false };
      state.timer = { text: "Unavailable until configuration is fixed.", isActive: false, isEnabled: false, activeText: "unknown", enabledText: "unknown", needsReinstall: false, warningText: "" };
      state.nextStep = "Fix the project-local watchdog configuration, then refresh status.";
      return state;
    }

    state.nextStep = getControlPanelNextStep(state);
    state.bootstrap = await getBootstrapConversationState(root);
    state.operation = {
      isRunning: panelOperationState && panelOperationState.status === "running",
      title: String(panelOperationState && panelOperationState.title || ""),
      detail: String(panelOperationState && panelOperationState.detail || ""),
      startedAt: String(panelOperationState && panelOperationState.startedAt || "")
    };

    const latest = path.join(root, "agent", "reports", "latest.md");
    if (fs.existsSync(latest)) {
      state.latestReport = latest;
      state.latestSummary = readFilePrefix(latest, 64 * 1024).split(/\r?\n/).slice(0, 10).join("\n");
    }

    return state;
  }

  function getControlPanelNextStep(state) {
    if (!state.root) {
      return "Select the Linux folder that Codex Watchdog should control.";
    }
    if (!state.rootExists) {
      return "Create or browse to an existing Linux project folder.";
    }
    if (state.paused) {
      return "Watchdog is paused. Resume Guard when you want the next timer wakeup to run.";
    }
    if (!state.initialized) {
      return "Project folder is selected. Click Prepare Project, then use the Bootstrap Conversation section to instantiate the watchdog task from your plain-language requirement.";
    }
    if (!state.taskReady) {
      return "Use the Bootstrap Conversation section to talk through the setup, preview the candidate files, then click Instantiate Project before Start Guard.";
    }
    if (!state.login.ok) {
      return "Open the login terminal, complete OpenAI login, then click Start Guard again.";
    }
    if (state.timer && state.timer.needsReinstall) {
      return "Watchdog settings changed. Click Start Guard or run ./agent/bin/watchdog timer-install to reinstall the timer with the current CODEX_HOME and schedule.";
    }
    if (state.timer.isActive) {
      return "Watchdog is running. Use Open Latest Report or Open Morning Brief to inspect its work.";
    }
    return "After Codex has instantiated PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF, click Start Guard.";
  }

  return {
    getControlPanelState,
    getControlPanelNextStep,
    renderControlPanel
  };
}

module.exports = {
  emptyPanelOperationState,
  nextPanelOperationState,
  createControlPanelStateHelpers
};
