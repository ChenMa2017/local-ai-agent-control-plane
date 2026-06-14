"use strict";

const fs = require("fs");
const path = require("path");
const { renderControlPanel } = require("./controlPanelRenderer");
const {
  createBaseControlPanelState,
  applyResolvedRuntimeState,
  applyConfigurationErrorState,
  createOperationState,
  applyLatestReportState
} = require("./controlPanelStateModel");

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
    const rootExists = Boolean(root && fs.existsSync(root));
    const initialized = Boolean(rootExists && isWatchdogInitialized(root));
    const state = createBaseControlPanelState({
      root,
      rootExists,
      initialized,
      taskReady: Boolean(initialized && projectSetupHelpers.taskLooksInstantiated(root)),
      paused: Boolean(rootExists && isGuardPaused(root))
    });

    if (!root || !rootExists) {
      state.nextStep = getControlPanelNextStep(state);
      return state;
    }

    try {
      const codexHome = codexHomePlan(root);
      const login = await getCodexLoginStatus(root);
      const timer = await getTimerStatus(root);
      const runtime = inspectProjectRuntimeClarity(root);
      const settings = await effectiveWatchdogSettings(root);
      const timerDrift = readWatcherUnitDrift(root, settings);
      applyResolvedRuntimeState(state, {
        codexHome: codexHome.effectivePath,
        codexHomeNotice: codexHome.migrationReason || "",
        codexBin: await resolveCodexBin(root),
        sandboxMode: sandboxModeSetting(root),
        timeoutMinutes: positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", DEFAULT_TIMEOUT_MINUTES), 1, DEFAULT_TIMEOUT_MINUTES),
        intervalMinutes: positiveNumberSetting(root, "codexWatchdog.intervalMinutes", extensionSetting("intervalMinutes", DEFAULT_INTERVAL_MINUTES), 5, DEFAULT_INTERVAL_MINUTES),
        compactEveryRuns: positiveNumberSetting(root, "codexWatchdog.compactEveryRuns", extensionSetting("compactEveryRuns", DEFAULT_COMPACT_EVERY_RUNS), 0, DEFAULT_COMPACT_EVERY_RUNS),
        login,
        timer,
        runtime,
        timerNeedsReinstall: timerDrift.needsReinstall,
        timerWarningText: timerDrift.text
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      applyConfigurationErrorState(state, message);
      return state;
    }

    state.nextStep = getControlPanelNextStep(state);
    state.bootstrap = await getBootstrapConversationState(root);
    state.operation = createOperationState(panelOperationState);

    const latest = path.join(root, "agent", "reports", "latest.md");
    if (fs.existsSync(latest)) {
      applyLatestReportState(state, {
        latestReport: latest,
        latestSummary: readFilePrefix(latest, 64 * 1024).split(/\r?\n/).slice(0, 10).join("\n")
      });
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
