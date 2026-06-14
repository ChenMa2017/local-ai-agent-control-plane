"use strict";

const { createRuntimeClarityHelpers } = require("./runtimeClarity");
const { createRuntimeEffectiveSettingsResolver } = require("./runtimeEffectiveSettings");
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
  const effectiveSettingsResolver = createRuntimeEffectiveSettingsResolver({
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
  });
  const effectiveWatchdogSettings = effectiveSettingsResolver.effectiveWatchdogSettings;
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
