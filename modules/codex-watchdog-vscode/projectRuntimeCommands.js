"use strict";

function createProjectRuntimeCommands({
  vscode,
  fs,
  fsp,
  path,
  getProjectRoot,
  openDocument,
  effectiveWatchdogSettings,
  positiveNumberSetting,
  extensionSetting,
  defaultTimeoutMinutes
}) {
  async function openMorningBriefCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const files = [
      path.join(root, "agent", "MORNING_BRIEF.md"),
      path.join(root, "agent", "reports", "latest.md"),
      path.join(root, "agent", "RUNTIME_STATE.md")
    ].filter((file) => fs.existsSync(file));

    if (files.length === 0) {
      vscode.window.showWarningMessage("No morning brief or watchdog reports exist yet. Run Codex Watchdog once first.");
      return;
    }

    for (const file of files) {
      await openDocument(file, false);
    }
  }

  async function acceptStateUpdateCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const proposed = path.join(root, "agent", "STATE.proposed.md");
    const state = path.join(root, "agent", "STATE.md");
    if (!fs.existsSync(proposed)) {
      vscode.window.showWarningMessage("No proposed state update exists.");
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      "Replace agent/STATE.md with agent/STATE.proposed.md?",
      { modal: true },
      "Accept"
    );
    if (answer !== "Accept") {
      return;
    }
    const data = await fsp.readFile(proposed);
    await fsp.writeFile(state, data);
    vscode.window.showInformationMessage("Accepted proposed Codex Watchdog state update.");
  }

  function isGuardPaused(root) {
    return fs.existsSync(path.join(root, "agent", "control", "PAUSE"));
  }

  async function watchdogCommandEnv(root) {
    const settings = await effectiveWatchdogSettings(root);
    return {
      CODEX_BIN: settings.codexBin,
      CODEX_HOME: settings.codexHome,
      CODEX_SANDBOX_MODE: settings.sandboxMode,
      WATCHDOG_INTERVAL_MINUTES: String(settings.intervalMinutes),
      WATCHDOG_TIMEOUT_MINUTES: String(settings.timeoutMinutes),
      WATCHDOG_COMPACT_EVERY_RUNS: String(settings.compactEveryRuns),
      WATCHDOG_ROLE: settings.role,
      WATCHDOG_PHASE_OFFSET_MINUTES: String(settings.phaseOffsetMinutes),
      WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP: settings.supervisorLightFollowup ? "1" : "0",
      WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS: String(settings.supervisorAuditEveryRunnerRuns),
      WATCHDOG_SERVICE_PREFIX: settings.servicePrefix,
      CUDA_VISIBLE_DEVICES: ""
    };
  }

  function watchdogCommandTimeoutMs(root) {
    const timeout = positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", defaultTimeoutMinutes), 1, defaultTimeoutMinutes);
    return (timeout + 5) * 60 * 1000;
  }

  return {
    openMorningBriefCommand,
    acceptStateUpdateCommand,
    isGuardPaused,
    watchdogCommandEnv,
    watchdogCommandTimeoutMs
  };
}

module.exports = {
  createProjectRuntimeCommands
};
