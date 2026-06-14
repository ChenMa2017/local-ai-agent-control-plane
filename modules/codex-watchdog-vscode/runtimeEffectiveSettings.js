"use strict";

function createRuntimeEffectiveSettingsResolver({
  resolveCodexBin,
  codexHomeSetting,
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
  defaultSupervisorAuditEveryRunnerRuns
}) {
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
    effectiveWatchdogSettings
  };
}

module.exports = {
  createRuntimeEffectiveSettingsResolver
};
