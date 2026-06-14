"use strict";

function createServiceRuntimeFactory({
  createProjectRootManager,
  createRuntimeConfigHelpers,
  createRuntimeHelpers,
  vscode,
  fs,
  fsp,
  path,
  os,
  getOutput,
  getExtensionContext,
  projectRootKey,
  extensionSetting,
  extensionSettingWithSource,
  projectSetting,
  projectSettingWithSource,
  expandHome,
  isExistingDirectory,
  isSafeProjectRootPath,
  validateProjectRootPath,
  ensureDir,
  requireExistingDirectory,
  defaultWatchdogRole,
  defaultServicePrefix,
  loginReadyRe,
  resolveCodexBin,
  updateProjectSetting,
  defaultTimeoutMinutes,
  defaultIntervalMinutes,
  defaultCompactEveryRuns,
  defaultPhaseOffsetMinutes,
  defaultSupervisorLightFollowup,
  defaultSupervisorAuditEveryRunnerRuns,
  run,
  unitNames,
  systemdQuote,
  systemdPathValue,
  systemdEnvValue,
  shellQuote,
  readFilePrefix,
  updateStatusBar
}) {
  let projectRootManager;
  let runtimeConfigHelpers;
  let runtimeHelpers;

  function getProjectRootManager() {
    if (!projectRootManager) {
      projectRootManager = createProjectRootManager({
        vscode,
        fs,
        path,
        os,
        projectRootKey,
        getExtensionContext,
        output: getOutput(),
        updateStatusBar,
        extensionSetting,
        expandHome,
        isExistingDirectory,
        isSafeProjectRootPath,
        validateProjectRootPath,
        ensureDir,
        requireExistingDirectory
      });
    }
    return projectRootManager;
  }

  function getRuntimeConfigHelpers() {
    if (!runtimeConfigHelpers) {
      runtimeConfigHelpers = createRuntimeConfigHelpers({
        fs,
        path,
        os,
        output: getOutput(),
        defaultWatchdogRole,
        defaultServicePrefix,
        extensionSetting,
        extensionSettingWithSource,
        projectSetting,
        projectSettingWithSource,
        expandHome
      });
    }
    return runtimeConfigHelpers;
  }

  function getRuntimeHelpers() {
    if (!runtimeHelpers) {
      const runtimeConfig = getRuntimeConfigHelpers();
      runtimeHelpers = createRuntimeHelpers({
        vscode,
        fs,
        fsp,
        path,
        os,
        output: getOutput(),
        loginReadyRe,
        resolveCodexBin,
        codexHomeSetting: runtimeConfig.codexHomeSetting,
        codexHomePlan: runtimeConfig.codexHomePlan,
        sandboxModeSetting: runtimeConfig.sandboxModeSetting,
        positiveNumberSetting: runtimeConfig.positiveNumberSetting,
        extensionSetting,
        watchdogRoleSetting: runtimeConfig.watchdogRoleSetting,
        booleanSetting: runtimeConfig.booleanSetting,
        servicePrefixSetting: runtimeConfig.servicePrefixSetting,
        defaultTimeoutMinutes,
        defaultIntervalMinutes,
        defaultCompactEveryRuns,
        defaultPhaseOffsetMinutes,
        defaultSupervisorLightFollowup,
        defaultSupervisorAuditEveryRunnerRuns,
        updateProjectSetting,
        watcherProfileModelDefaults: runtimeConfig.watcherProfileModelDefaults,
        mergeWatcherConfigText: runtimeConfig.mergeWatcherConfigText,
        hasTomlAssignment: runtimeConfig.hasTomlAssignment,
        parseTomlBasicString: runtimeConfig.parseTomlBasicString,
        run,
        ensureDir,
        unitNames,
        systemdQuote,
        systemdPathValue,
        systemdEnvValue,
        shellQuote,
        getProjectRoot: async () => getProjectRootManager().getProjectRoot(),
        readFilePrefix
      });
    }
    return runtimeHelpers;
  }

  return {
    getProjectRootManager,
    getRuntimeConfigHelpers,
    getRuntimeHelpers
  };
}

module.exports = {
  createServiceRuntimeFactory
};
