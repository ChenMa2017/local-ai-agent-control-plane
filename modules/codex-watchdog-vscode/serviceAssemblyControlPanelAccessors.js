"use strict";

function createServiceAssemblyControlPanelAccessors({
  getControlPanelServices
}) {
  function getControlPanelStateHelpers() {
    return getControlPanelServices().getControlPanelStateHelpers();
  }

  function getControlPanelMessageHandler() {
    return getControlPanelServices().getControlPanelMessageHandler();
  }

  function getControlPanelController() {
    return getControlPanelServices().getControlPanelController();
  }

  function deactivate() {
    getControlPanelServices().deactivate();
  }

  return {
    getControlPanelStateHelpers,
    getControlPanelMessageHandler,
    getControlPanelController,
    deactivate
  };
}

module.exports = {
  createServiceAssemblyControlPanelAccessors
};
