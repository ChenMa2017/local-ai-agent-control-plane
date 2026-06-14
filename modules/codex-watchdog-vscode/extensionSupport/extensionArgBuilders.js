"use strict";

function buildHostUtilsArgs({
  vscode,
  fs,
  fsp,
  path,
  os,
  crypto,
  cp,
  getOutput,
  getRuntimeConfigHelpers
}) {
  return {
    vscode,
    fs,
    fsp,
    path,
    os,
    crypto,
    cp,
    getOutput,
    getRuntimeConfigHelpers
  };
}

function buildServiceAssemblyArgs({
  vscode,
  fs,
  fsp,
  path,
  os,
  crypto,
  getOutput,
  getExtensionContext,
  projectRootKey,
  statusRefreshMs,
  defaultIntervalMinutes,
  defaultTimeoutMinutes,
  defaultCompactEveryRuns,
  defaultPhaseOffsetMinutes,
  defaultWatchdogRole,
  defaultSupervisorAuditEveryRunnerRuns,
  defaultSupervisorLightFollowup,
  defaultServicePrefix,
  loginReadyRe,
  emptyPanelOperationState,
  nextPanelOperationState,
  templates,
  hostDelegates,
  serviceDelegates
}) {
  return {
    vscode,
    fs,
    fsp,
    path,
    os,
    crypto,
    getOutput,
    getExtensionContext,
    projectRootKey,
    statusRefreshMs,
    defaultIntervalMinutes,
    defaultTimeoutMinutes,
    defaultCompactEveryRuns,
    defaultPhaseOffsetMinutes,
    defaultWatchdogRole,
    defaultSupervisorAuditEveryRunnerRuns,
    defaultSupervisorLightFollowup,
    defaultServicePrefix,
    loginReadyRe,
    emptyPanelOperationState,
    nextPanelOperationState,
    templates,
    ensureDir: hostDelegates.ensureDir,
    openDocument: hostDelegates.openDocument,
    extensionSetting: hostDelegates.extensionSetting,
    extensionSettingWithSource: hostDelegates.extensionSettingWithSource,
    projectSetting: hostDelegates.projectSetting,
    projectSettingWithSource: hostDelegates.projectSettingWithSource,
    expandHome: hostDelegates.expandHome,
    isExistingDirectory: hostDelegates.isExistingDirectory,
    isSafeProjectRootPath: hostDelegates.isSafeProjectRootPath,
    validateProjectRootPath: hostDelegates.validateProjectRootPath,
    requireExistingDirectory: hostDelegates.requireExistingDirectory,
    resolveCodexBin: hostDelegates.resolveCodexBin,
    runLogged: hostDelegates.runLogged,
    runLoggedWithInput: hostDelegates.runLoggedWithInput,
    createNonce: serviceDelegates.createNonce,
    updateProjectSetting: hostDelegates.updateProjectSetting,
    run: hostDelegates.run,
    unitNames: hostDelegates.unitNames,
    systemdQuote: hostDelegates.systemdQuote,
    systemdPathValue: hostDelegates.systemdPathValue,
    systemdEnvValue: hostDelegates.systemdEnvValue,
    shellQuote: hostDelegates.shellQuote,
    readFilePrefix: hostDelegates.readFilePrefix,
    isWatchdogInitialized: hostDelegates.isWatchdogInitialized,
    isEffectivelyEmptyDir: hostDelegates.isEffectivelyEmptyDir
  };
}

module.exports = {
  buildHostUtilsArgs,
  buildServiceAssemblyArgs
};
