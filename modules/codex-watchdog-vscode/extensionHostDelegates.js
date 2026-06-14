"use strict";

function createExtensionHostDelegates({
  getHostUtils,
  getRuntimeConfigHelpers
}) {
  function isWatchdogInitialized(root) { return getHostUtils().isWatchdogInitialized(root); }
  async function isEffectivelyEmptyDir(root) { return getHostUtils().isEffectivelyEmptyDir(root); }
  function extensionSetting(key, fallback) { return getHostUtils().extensionSetting(key, fallback); }
  function extensionSettingWithSource(key, fallback) { return getHostUtils().extensionSettingWithSource(key, fallback); }
  function unitNames(root) { return getHostUtils().unitNames(root); }
  async function resolveCodexBin(root) { return getHostUtils().resolveCodexBin(root); }
  function projectSetting(root, key, fallback) { return getHostUtils().projectSetting(root, key, fallback); }
  function projectSettingWithSource(root, key, fallback) { return getHostUtils().projectSettingWithSource(root, key, fallback); }
  function positiveNumberSetting(root, key, fallback, min, hardFallback) {
    return getRuntimeConfigHelpers().positiveNumberSetting(root, key, fallback, min, hardFallback);
  }
  function booleanSetting(root, key, fallback, hardFallback) {
    return getRuntimeConfigHelpers().booleanSetting(root, key, fallback, hardFallback);
  }
  function sandboxModeSetting(root) { return getRuntimeConfigHelpers().sandboxModeSetting(root); }
  function watchdogRoleSetting(root) { return getRuntimeConfigHelpers().watchdogRoleSetting(root); }
  function codexHomeSetting(root) { return getRuntimeConfigHelpers().codexHomeSetting(root); }
  function codexHomePlan(root) { return getRuntimeConfigHelpers().codexHomePlan(root); }
  function servicePrefixSetting(root) { return getRuntimeConfigHelpers().servicePrefixSetting(root); }
  function validateUnitName(name, suffix) { return getRuntimeConfigHelpers().validateUnitName(name, suffix); }
  function isExistingDirectory(value) { return getHostUtils().isExistingDirectory(value); }
  function requireExistingDirectory(value, label) { return getHostUtils().requireExistingDirectory(value, label); }
  function isSafeProjectRootPath(value) { return getHostUtils().isSafeProjectRootPath(value); }
  function validateProjectRootPath(value) { return getHostUtils().validateProjectRootPath(value); }
  async function updateProjectSetting(root, key, value) { return getHostUtils().updateProjectSetting(root, key, value); }
  function parseTomlBasicString(text, key) { return getRuntimeConfigHelpers().parseTomlBasicString(text, key); }
  function hasTomlAssignment(text, key) { return getRuntimeConfigHelpers().hasTomlAssignment(text, key); }
  function watcherProfileModelDefaults() { return getRuntimeConfigHelpers().watcherProfileModelDefaults(); }
  function mergeWatcherConfigText(existingText, profileDefaults = watcherProfileModelDefaults()) {
    return getRuntimeConfigHelpers().mergeWatcherConfigText(existingText, profileDefaults);
  }
  async function runLogged(command, args, options = {}) { return getHostUtils().runLogged(command, args, options); }
  async function runLoggedWithInput(command, args, input, options = {}) { return getHostUtils().runLoggedWithInput(command, args, input, options); }
  function run(command, args, options = {}) { return getHostUtils().run(command, args, options); }
  async function ensureDir(dir) { return getHostUtils().ensureDir(dir); }
  async function openDocument(file, preview) { return getHostUtils().openDocument(file, preview); }
  function readFilePrefix(file, maxBytes) { return getHostUtils().readFilePrefix(file, maxBytes); }
  function expandHome(value) { return getHostUtils().expandHome(value); }
  function shellQuote(value) { return getHostUtils().shellQuote(value); }
  function systemdQuote(value) { return getHostUtils().systemdQuote(value); }
  function systemdPathValue(value) { return getHostUtils().systemdPathValue(value); }
  function systemdEnvValue(value) { return getHostUtils().systemdEnvValue(value); }

  return {
    isWatchdogInitialized,
    isEffectivelyEmptyDir,
    extensionSetting,
    extensionSettingWithSource,
    unitNames,
    resolveCodexBin,
    projectSetting,
    projectSettingWithSource,
    positiveNumberSetting,
    booleanSetting,
    sandboxModeSetting,
    watchdogRoleSetting,
    codexHomeSetting,
    codexHomePlan,
    servicePrefixSetting,
    validateUnitName,
    isExistingDirectory,
    requireExistingDirectory,
    isSafeProjectRootPath,
    validateProjectRootPath,
    updateProjectSetting,
    parseTomlBasicString,
    hasTomlAssignment,
    watcherProfileModelDefaults,
    mergeWatcherConfigText,
    runLogged,
    runLoggedWithInput,
    run,
    ensureDir,
    openDocument,
    readFilePrefix,
    expandHome,
    shellQuote,
    systemdQuote,
    systemdPathValue,
    systemdEnvValue
  };
}

module.exports = {
  createExtensionHostDelegates
};
