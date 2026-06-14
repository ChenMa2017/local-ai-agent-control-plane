"use strict";

const { createRuntimeConfigTomlHelpers } = require("./runtimeConfigToml");
const { createRuntimeConfigPathHelpers } = require("./runtimeConfigPathHelpers");
const { createRuntimeConfigValueParsers } = require("./runtimeConfigValueParsers");

function createRuntimeConfigHelpers({
  fs,
  path,
  os,
  output,
  defaultWatchdogRole,
  defaultServicePrefix,
  extensionSetting,
  extensionSettingWithSource,
  projectSetting,
  projectSettingWithSource,
  expandHome
}) {
  const pathHelpers = createRuntimeConfigPathHelpers({
    fs,
    path,
    os,
    output,
    defaultServicePrefix,
    extensionSetting,
    extensionSettingWithSource,
    projectSetting,
    projectSettingWithSource,
    expandHome
  });
  const valueParsers = createRuntimeConfigValueParsers({
    output,
    defaultWatchdogRole,
    extensionSetting,
    projectSetting,
    workspaceWritePolicyAllowed: pathHelpers.workspaceWritePolicyAllowed
  });
  const tomlHelpers = createRuntimeConfigTomlHelpers({
    fs,
    path,
    os
  });

  return {
    positiveNumberSetting: valueParsers.positiveNumberSetting,
    booleanSetting: valueParsers.booleanSetting,
    sandboxModeSetting: valueParsers.sandboxModeSetting,
    watchdogRoleSetting: valueParsers.watchdogRoleSetting,
    codexHomeSetting: pathHelpers.codexHomeSetting,
    codexHomePlan: pathHelpers.codexHomePlan,
    servicePrefixSetting: pathHelpers.servicePrefixSetting,
    validateUnitName: pathHelpers.validateUnitName,
    parseTomlBasicString: tomlHelpers.parseTomlBasicString,
    hasTomlAssignment: tomlHelpers.hasTomlAssignment,
    watcherProfileModelDefaults: tomlHelpers.watcherProfileModelDefaults,
    mergeWatcherConfigText: tomlHelpers.mergeWatcherConfigText
  };
}

module.exports = {
  createRuntimeConfigHelpers
};
