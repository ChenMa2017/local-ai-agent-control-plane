"use strict";

const {
  buildProjectCommandsArgs,
  buildGuardLifecycleArgs
} = require("./serviceProjectCommandArgBuilders");

function createServiceProjectCommandAccessors({
  createProjectCommands,
  createGuardLifecycle,
  vscode,
  fs,
  fsp,
  path,
  ensureDir,
  getOutput,
  openDocument,
  getRuntimeConfigHelpers,
  bridges,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  extensionSetting,
  defaultTimeoutMinutes,
  runLogged,
  unitNames,
  getControlPanelController,
  getProjectSetupHelpers,
  getBootstrapWorkflowHelpers,
  getGeneratedFilesHelpers,
  getBootstrapScaffoldingHelpers
}) {
  let projectCommands;
  let guardCommands;

  function getProjectCommands() {
    if (!projectCommands) {
      const runtimeConfig = getRuntimeConfigHelpers();
      projectCommands = createProjectCommands(buildProjectCommandsArgs({
        vscode,
        fs,
        fsp,
        path,
        bridges,
        runtimeConfig,
        extensionSetting,
        defaultTimeoutMinutes,
        getBootstrapScaffoldingHelpers,
        getGeneratedFilesHelpers,
        getProjectSetupHelpers,
        getBootstrapWorkflowHelpers,
        writeBootstrapRuntimeState,
        emptyBootstrapRuntimeState,
        openDocument
      }));
    }
    return projectCommands;
  }

  function getGuardCommands() {
    if (!guardCommands) {
      const commands = getProjectCommands();
      const guardLifecycle = buildGuardLifecycleArgs({
        createGuardLifecycle,
        vscode,
        getOutput,
        bridges,
        ensureDir,
        getProjectSetupHelpers,
        runLogged,
        commands,
        getControlPanelController,
        unitNames,
        openDocument
      });
      guardCommands = guardLifecycle.createGuardLifecycle(guardLifecycle.args);
    }
    return guardCommands;
  }

  return {
    getProjectCommands,
    getGuardCommands
  };
}

module.exports = {
  createServiceProjectCommandAccessors
};
