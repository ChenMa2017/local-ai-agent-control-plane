"use strict";

function createServiceAssemblyBridges({
  getProjectRootManager,
  getRuntimeHelpers,
  getBootstrapScaffoldingHelpers,
  getControlPanelController,
  getProjectSetupHelpers
}) {
  return {
    async updateStatusBar() {
      await getControlPanelController().updateStatusBar();
    },

    async openControlPanelCommand() {
      await getControlPanelController().openControlPanel();
    },

    async updateControlPanel() {
      await getControlPanelController().updateControlPanel();
    },

    async setPanelOperationState(data) {
      await getControlPanelController().setPanelOperationState(data);
    },

    async clearPanelOperationState() {
      await getControlPanelController().clearPanelOperationState();
    },

    initializeStatusBar(context) {
      getControlPanelController().initializeStatusBar(context);
    },

    getKnownProjectRoot() {
      return getProjectRootManager().getKnownProjectRoot();
    },

    getWorkspaceRoot() {
      return getProjectRootManager().getWorkspaceRoot();
    },

    async selectProjectRoot(title) {
      return getProjectRootManager().selectProjectRoot(title);
    },

    async browseExistingProjectRoot(title, raw) {
      return getProjectRootManager().browseExistingProjectRoot(title, raw);
    },

    async normalizeProjectRootInput(raw, label, options = {}) {
      return getProjectRootManager().normalizeProjectRootInput(raw, label, options);
    },

    async getProjectRoot() {
      return getProjectRootManager().getProjectRoot();
    },

    async rememberProjectRoot(root) {
      await getProjectRootManager().rememberProjectRoot(root);
    },

    async clearRememberedProjectRoot() {
      await getProjectRootManager().clearRememberedProjectRoot();
    },

    async effectiveWatchdogSettings(root) {
      return getRuntimeHelpers().effectiveWatchdogSettings(root);
    },

    async renderWatchdogEnv(root) {
      return getRuntimeHelpers().renderWatchdogEnv(root);
    },

    async bootstrapProject(root) {
      return getBootstrapScaffoldingHelpers().bootstrapProject(root);
    },

    showBootstrapResult(result) {
      return getBootstrapScaffoldingHelpers().showBootstrapResult(result);
    },

    async ensureWatchdogReadme(root) {
      return getBootstrapScaffoldingHelpers().ensureWatchdogReadme(root);
    },

    async createDemoProjectTemplate(root) {
      return getBootstrapScaffoldingHelpers().createDemoProjectTemplate(root);
    },

    async writeSystemdUnits(root, units) {
      return getRuntimeHelpers().writeSystemdUnits(root, units);
    },

    async ensureCodexHome(root) {
      return getRuntimeHelpers().ensureCodexHome(root);
    },

    inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome) {
      return getRuntimeHelpers().inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome);
    },

    inspectWatcherHomeBootstrap(root) {
      return getRuntimeHelpers().inspectWatcherHomeBootstrap(root);
    },

    async seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome) {
      return getRuntimeHelpers().seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome);
    },

    async seedWatcherHomeAuthFromMainProfile(root) {
      return getRuntimeHelpers().seedWatcherHomeAuthFromMainProfile(root);
    },

    async getCodexLoginStatus(root) {
      return getRuntimeHelpers().getCodexLoginStatus(root);
    },

    async confirmLoginIfNeeded(root) {
      return getRuntimeHelpers().confirmLoginIfNeeded(root);
    },

    async openLoginTerminal(root) {
      return getRuntimeHelpers().openLoginTerminal(root);
    },

    async getTimerStatus(root) {
      return getRuntimeHelpers().getTimerStatus(root);
    },

    readWatcherUnitDrift(root, settings, unitDir) {
      return getRuntimeHelpers().readWatcherUnitDrift(root, settings, unitDir);
    },

    inspectProjectRuntimeClarity(root) {
      return getRuntimeHelpers().inspectProjectRuntimeClarity(root);
    },

    taskLooksInstantiated(root) {
      return getProjectSetupHelpers().taskLooksInstantiated(root);
    }
  };
}

module.exports = {
  createServiceAssemblyBridges
};
