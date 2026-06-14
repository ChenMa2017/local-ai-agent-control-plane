"use strict";

function activateServiceAssembly({
  context,
  projectServices,
  controlPanelAccessors,
  activateWatchdogServices,
  registerWatchdogCommand,
  vscode,
  getOutput,
  bridges
}) {
  projectServices.getProjectSetupHelpers();
  projectServices.getBootstrapWorkflowHelpers();
  projectServices.getProjectCommands();
  projectServices.getGuardCommands();
  projectServices.getBootstrapScaffoldingHelpers();
  controlPanelAccessors.getControlPanelStateHelpers();
  controlPanelAccessors.getControlPanelMessageHandler();
  controlPanelAccessors.getControlPanelController();

  activateWatchdogServices({
    registerCommand: (command, handler) => registerWatchdogCommand({
      context,
      vscode,
      output: getOutput(),
      updateStatusBar: () => bridges.updateStatusBar()
    }, command, handler),
    initializeStatusBar: () => bridges.initializeStatusBar(context),
    openControlPanelCommand: bridges.openControlPanelCommand,
    projectCommands: projectServices.getProjectCommands(),
    guardCommands: projectServices.getGuardCommands()
  });
}

module.exports = {
  activateServiceAssembly
};
