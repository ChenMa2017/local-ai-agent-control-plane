"use strict";

const { createRuntimeClarityHelpers } = require("./runtimeClarity");
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
  const clarityHelpers = createRuntimeClarityHelpers({
    fs,
    path,
    readFilePrefix
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
    inspectProjectRuntimeClarity: clarityHelpers.inspectProjectRuntimeClarity
  };
}

module.exports = {
  createRuntimeHelpers
};
