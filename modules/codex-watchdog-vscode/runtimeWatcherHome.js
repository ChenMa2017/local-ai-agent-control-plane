"use strict";

const { createRuntimeWatcherHomeBootstrapHelpers } = require("./runtimeWatcherHomeBootstrap");
const { createRuntimeWatcherHomeLoginHelpers } = require("./runtimeWatcherHomeLogin");

function createRuntimeWatcherHomeHelpers({
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
}) {
  const bootstrapHelpers = createRuntimeWatcherHomeBootstrapHelpers({
    vscode,
    fs,
    fsp,
    path,
    os,
    output,
    codexHomeSetting,
    codexHomePlan,
    updateProjectSetting,
    watcherProfileModelDefaults,
    mergeWatcherConfigText,
    hasTomlAssignment,
    parseTomlBasicString,
    ensureDir
  });
  const loginHelpers = createRuntimeWatcherHomeLoginHelpers({
    vscode,
    fs,
    path,
    output,
    loginReadyRe,
    resolveCodexBin,
    codexHomeSetting,
    run,
    getProjectRoot,
    shellQuote,
    ensureCodexHome: bootstrapHelpers.ensureCodexHome,
    inspectWatcherHomeBootstrapState: bootstrapHelpers.inspectWatcherHomeBootstrapState,
    seedWatcherHomeAuthFromMainProfile: bootstrapHelpers.seedWatcherHomeAuthFromMainProfile
  });

  return {
    ensureCodexHome: bootstrapHelpers.ensureCodexHome,
    inspectWatcherHomeBootstrapState: bootstrapHelpers.inspectWatcherHomeBootstrapState,
    inspectWatcherHomeBootstrap: bootstrapHelpers.inspectWatcherHomeBootstrap,
    seedWatcherHomeBootstrapFromProfilePaths: bootstrapHelpers.seedWatcherHomeBootstrapFromProfilePaths,
    seedWatcherHomeAuthFromMainProfile: bootstrapHelpers.seedWatcherHomeAuthFromMainProfile,
    getCodexLoginStatus: loginHelpers.getCodexLoginStatus,
    confirmLoginIfNeeded: loginHelpers.confirmLoginIfNeeded,
    openLoginTerminal: loginHelpers.openLoginTerminal
  };
}

module.exports = {
  createRuntimeWatcherHomeHelpers
};
