"use strict";

const { createHostCommandRunner } = require("./hostCommandRunner");
const { createHostCodexResolver } = require("./hostCodexResolver");
const { createHostPathUtils } = require("./hostPathUtils");
const { createHostProjectSettings } = require("./hostProjectSettings");
const { createHostSystemdUtils } = require("./hostSystemdUtils");
const { createHostFileUtils } = require("./hostFileUtils");

function createExtensionHostUtils({
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
  function getSafeOutput() {
    const value = typeof getOutput === "function" ? getOutput() : undefined;
    return value && typeof value.appendLine === "function" ? value : undefined;
  }

  const pathUtils = createHostPathUtils({
    fs,
    path,
    os
  });
  const expandHome = pathUtils.expandHome;
  const isExistingDirectory = pathUtils.isExistingDirectory;
  const validateProjectRootPath = pathUtils.validateProjectRootPath;
  const isSafeProjectRootPath = pathUtils.isSafeProjectRootPath;
  const requireExistingDirectory = pathUtils.requireExistingDirectory;

  const projectSettings = createHostProjectSettings({
    vscode,
    fs,
    fsp,
    path,
    getSafeOutput
  });
  const extensionSetting = projectSettings.extensionSetting;
  const extensionSettingWithSource = projectSettings.extensionSettingWithSource;
  const projectSetting = projectSettings.projectSetting;
  const projectSettingWithSource = projectSettings.projectSettingWithSource;
  const readProjectSettings = projectSettings.readProjectSettings;
  const updateProjectSetting = projectSettings.updateProjectSetting;

  const commandRunner = createHostCommandRunner({
    cp,
    os,
    getSafeOutput
  });
  const run = commandRunner.run;
  const runLogged = commandRunner.runLogged;
  const runLoggedWithInput = commandRunner.runLoggedWithInput;
  const codexResolver = createHostCodexResolver({
    fs,
    path,
    os,
    expandHome,
    projectSettingWithSource,
    extensionSettingWithSource,
    run
  });
  const resolveCodexBin = codexResolver.resolveCodexBin;
  const systemdUtils = createHostSystemdUtils({
    path,
    crypto,
    getRuntimeConfigHelpers
  });
  const unitNames = systemdUtils.unitNames;
  const shellQuote = systemdUtils.shellQuote;
  const systemdQuote = systemdUtils.systemdQuote;
  const systemdPathValue = systemdUtils.systemdPathValue;
  const systemdEnvValue = systemdUtils.systemdEnvValue;

  const fileUtils = createHostFileUtils({
    vscode,
    fs,
    fsp,
    path
  });
  const ensureDir = fileUtils.ensureDir;
  const openDocument = fileUtils.openDocument;
  const readFilePrefix = fileUtils.readFilePrefix;
  const isWatchdogInitialized = fileUtils.isWatchdogInitialized;
  const isEffectivelyEmptyDir = fileUtils.isEffectivelyEmptyDir;

  return {
    extensionSetting,
    extensionSettingWithSource,
    expandHome,
    isExistingDirectory,
    isSafeProjectRootPath,
    validateProjectRootPath,
    requireExistingDirectory,
    resolveCodexBin,
    projectSetting,
    projectSettingWithSource,
    unitNames,
    readProjectSettings,
    updateProjectSetting,
    runLogged,
    runLoggedWithInput,
    run,
    ensureDir,
    openDocument,
    readFilePrefix,
    shellQuote,
    systemdQuote,
    systemdPathValue,
    systemdEnvValue,
    isWatchdogInitialized,
    isEffectivelyEmptyDir
  };
}

module.exports = {
  createExtensionHostUtils
};
