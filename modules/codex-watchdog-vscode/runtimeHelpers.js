"use strict";

const { createRuntimeWatcherHomeHelpers } = require("./runtimeWatcherHome");
const { createRuntimeSystemdHelpers } = require("./runtimeSystemd");

function createRuntimeHelpers({
  vscode,
  fs,
  fsp,
  path,
  os,
  output,
  loginReadyRe,
  resolveCodexBin,
  codexHomeSetting,
  codexHomePlan,
  sandboxModeSetting,
  positiveNumberSetting,
  extensionSetting,
  watchdogRoleSetting,
  booleanSetting,
  servicePrefixSetting,
  defaultTimeoutMinutes,
  defaultIntervalMinutes,
  defaultCompactEveryRuns,
  defaultPhaseOffsetMinutes,
  defaultSupervisorLightFollowup,
  defaultSupervisorAuditEveryRunnerRuns,
  updateProjectSetting,
  watcherProfileModelDefaults,
  mergeWatcherConfigText,
  hasTomlAssignment,
  parseTomlBasicString,
  run,
  ensureDir,
  unitNames,
  systemdQuote,
  systemdPathValue,
  systemdEnvValue,
  shellQuote,
  getProjectRoot,
  readFilePrefix
}) {
  const watcherHomeHelpers = createRuntimeWatcherHomeHelpers({
    vscode,
    fs,
    fsp,
    path,
    os,
    output,
    loginReadyRe,
    resolveCodexBin,
    codexHomeSetting,
    codexHomePlan,
    updateProjectSetting,
    watcherProfileModelDefaults,
    mergeWatcherConfigText,
    hasTomlAssignment,
    parseTomlBasicString,
    run,
    ensureDir,
    getProjectRoot,
    shellQuote
  });
  const systemdHelpers = createRuntimeSystemdHelpers({
    fs,
    fsp,
    path,
    os,
    output,
    effectiveWatchdogSettings,
    run,
    ensureDir,
    unitNames,
    systemdQuote,
    systemdPathValue,
    systemdEnvValue,
    shellQuote
  });

  async function effectiveWatchdogSettings(root) {
    return {
      codexBin: await resolveCodexBin(root),
      codexHome: codexHomeSetting(root),
      sandboxMode: sandboxModeSetting(root),
      intervalMinutes: positiveNumberSetting(root, "codexWatchdog.intervalMinutes", extensionSetting("intervalMinutes", defaultIntervalMinutes), 5, defaultIntervalMinutes),
      timeoutMinutes: positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", defaultTimeoutMinutes), 1, defaultTimeoutMinutes),
      compactEveryRuns: positiveNumberSetting(root, "codexWatchdog.compactEveryRuns", extensionSetting("compactEveryRuns", defaultCompactEveryRuns), 0, defaultCompactEveryRuns),
      role: watchdogRoleSetting(root),
      phaseOffsetMinutes: positiveNumberSetting(root, "codexWatchdog.phaseOffsetMinutes", extensionSetting("phaseOffsetMinutes", defaultPhaseOffsetMinutes), 0, defaultPhaseOffsetMinutes),
      supervisorLightFollowup: booleanSetting(root, "codexWatchdog.supervisorLightFollowup", extensionSetting("supervisorLightFollowup", defaultSupervisorLightFollowup), defaultSupervisorLightFollowup),
      supervisorAuditEveryRunnerRuns: positiveNumberSetting(root, "codexWatchdog.supervisorAuditEveryRunnerRuns", extensionSetting("supervisorAuditEveryRunnerRuns", defaultSupervisorAuditEveryRunnerRuns), 1, defaultSupervisorAuditEveryRunnerRuns),
      servicePrefix: servicePrefixSetting(root)
    };
  }

  function readJsonFileIfExists(file, fallback = null) {
    if (!fs.existsSync(file)) {
      return fallback;
    }
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_error) {
      return fallback;
    }
  }

  function countVisibleEntries(dir) {
    try {
      return fs.readdirSync(dir).filter((name) => name && !name.startsWith(".")).length;
    } catch (_error) {
      return 0;
    }
  }

  function markdownFieldValue(text, label) {
    const match = String(text || "").match(new RegExp(`^\\s*[-*]?\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im"));
    return match ? match[1].trim() : "";
  }

  function isTruthyMarkdownValue(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return ["true", "yes", "1", "on"].includes(normalized);
  }

  function inspectProjectRuntimeClarity(root) {
    const signals = [];
    const pauseFile = path.join(root, "agent", "control", "PAUSE");
    if (fs.existsSync(pauseFile)) {
      const pauseText = readFilePrefix(pauseFile, 2048).trim();
      signals.push({
        level: "warn",
        text: [
          "The guard is paused by agent/control/PAUSE.",
          pauseText || "Open Resume Guard when you want timer wakeups to call Codex again."
        ].join("\n")
      });
    }

    const runState = readJsonFileIfExists(path.join(root, "agent", "RUN_STATE.json"), {});
    if (runState && runState.blocker_type === "stale_state") {
      signals.push({
        level: "warn",
        text: "RUN_STATE.json currently reports blocker_type=stale_state. Treat old failed/preflight records as historical until BLOCKERS.md or the latest report says they are still active."
      });
    }

    const reviewPendingPath = path.join(root, "agent", "REVIEW_PENDING.md");
    if (fs.existsSync(reviewPendingPath)) {
      const reviewText = fs.readFileSync(reviewPendingPath, "utf8");
      const state = markdownFieldValue(reviewText, "state");
      const pendingSend = isTruthyMarkdownValue(markdownFieldValue(reviewText, "pending_send"));
      const requiresHuman = isTruthyMarkdownValue(markdownFieldValue(reviewText, "requires_human_review"));
      if (state === "pending_send" || pendingSend || requiresHuman) {
        signals.push({
          level: "warn",
          text: `Review pending is active (${state || "review_required"}). This is a review/handoff wait inside the project, not a Codex login/runtime bootstrap failure.`
        });
      }
    }

    const queueCounts = {
      queued: countVisibleEntries(path.join(root, "agent", "queue", "queued")) + countVisibleEntries(path.join(root, "gpu_queue")) + countVisibleEntries(path.join(root, "cpu_queue")),
      running: countVisibleEntries(path.join(root, "agent", "queue", "running")) + countVisibleEntries(path.join(root, "gpu_running")) + countVisibleEntries(path.join(root, "cpu_running")),
      done: countVisibleEntries(path.join(root, "agent", "queue", "done")) + countVisibleEntries(path.join(root, "gpu_done")) + countVisibleEntries(path.join(root, "cpu_done")),
      failed: countVisibleEntries(path.join(root, "agent", "queue", "failed")) + countVisibleEntries(path.join(root, "gpu_failed")) + countVisibleEntries(path.join(root, "cpu_failed"))
    };
    const queueText = `Queue snapshot: queued=${queueCounts.queued}, running=${queueCounts.running}, done=${queueCounts.done}, failed=${queueCounts.failed}`;
    if (queueCounts.running > 0 && queueCounts.failed > 0) {
      signals.push({
        level: "warn",
        text: `Running and failed queue records coexist (${queueCounts.running} running, ${queueCounts.failed} failed). Treat failed entries as historical until the newest report or queue runner refresh says they are still live blockers.`
      });
    }

    const reconciliation = readJsonFileIfExists(path.join(root, "agent", "status", "SUPERVISOR_STALE_STATE_RECONCILIATION.json"), {});
    if (reconciliation && reconciliation.timestamp_utc) {
      const changed = reconciliation.reconciliation && reconciliation.reconciliation.changed === true;
      signals.push({
        level: changed ? "ok" : "muted",
        text: `Supervisor stale-state reconciliation last ran at ${reconciliation.timestamp_utc}${changed ? " and reported changed=true." : "."}`
      });
    }

    return { queueText, signals };
  }

  return {
    effectiveWatchdogSettings,
    renderWatchdogEnv: systemdHelpers.renderWatchdogEnv,
    writeSystemdUnits: systemdHelpers.writeSystemdUnits,
    ensureCodexHome: watcherHomeHelpers.ensureCodexHome,
    inspectWatcherHomeBootstrapState: watcherHomeHelpers.inspectWatcherHomeBootstrapState,
    inspectWatcherHomeBootstrap: watcherHomeHelpers.inspectWatcherHomeBootstrap,
    seedWatcherHomeBootstrapFromProfilePaths: watcherHomeHelpers.seedWatcherHomeBootstrapFromProfilePaths,
    seedWatcherHomeAuthFromMainProfile: watcherHomeHelpers.seedWatcherHomeAuthFromMainProfile,
    getCodexLoginStatus: watcherHomeHelpers.getCodexLoginStatus,
    confirmLoginIfNeeded: watcherHomeHelpers.confirmLoginIfNeeded,
    openLoginTerminal: watcherHomeHelpers.openLoginTerminal,
    getTimerStatus: systemdHelpers.getTimerStatus,
    readWatcherUnitDrift: systemdHelpers.readWatcherUnitDrift,
    inspectProjectRuntimeClarity
  };
}

module.exports = {
  createRuntimeHelpers
};
