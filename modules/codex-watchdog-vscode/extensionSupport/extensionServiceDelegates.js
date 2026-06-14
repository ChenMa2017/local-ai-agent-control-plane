"use strict";

function createExtensionServiceDelegates({
  getServiceAssembly,
  getGeneratedFilesHelpers,
  getBootstrapScaffoldingHelpers,
  getRuntimeConfigHelpers,
  getRuntimeHelpers,
  crypto,
  path,
  os
}) {
  function getProjectSetupHelpers() { return getServiceAssembly().getProjectSetupHelpers(); }
  function getProjectRootManager() { return getServiceAssembly().getProjectRootManager(); }
  function taskLooksInstantiated(root) { return getServiceAssembly().taskLooksInstantiated(root); }
  function getBootstrapWorkflowHelpers() { return getServiceAssembly().getBootstrapWorkflowHelpers(); }
  function getGeneratedFilesHelpersDelegate() { return getGeneratedFilesHelpers(); }
  function getBootstrapScaffoldingHelpersDelegate() { return getBootstrapScaffoldingHelpers(); }
  function getRuntimeConfigHelpersDelegate() { return getRuntimeConfigHelpers(); }
  function getRuntimeHelpersDelegate() { return getRuntimeHelpers(); }
  function getProjectCommands() { return getServiceAssembly().getProjectCommands(); }
  async function ensureGeneratedDirs(root) { return getGeneratedFilesHelpers().ensureGeneratedDirs(root); }
  async function refreshGeneratedWatcherFiles(root) { return getGeneratedFilesHelpers().refreshGeneratedWatcherFiles(root); }
  function getGuardCommands() { return getServiceAssembly().getGuardCommands(); }
  function getControlPanelStateHelpers() { return getServiceAssembly().getControlPanelStateHelpers(); }
  function getControlPanelMessageHandler() { return getServiceAssembly().getControlPanelMessageHandler(); }
  function getControlPanelController() { return getServiceAssembly().getControlPanelController(); }
  async function updateStatusBar() { await getServiceAssembly().updateStatusBar(); }
  async function openControlPanelCommand() { await getServiceAssembly().openControlPanelCommand(); }
  async function updateControlPanel() { await getServiceAssembly().updateControlPanel(); }
  async function setPanelOperationState(data) { await getServiceAssembly().setPanelOperationState(data); }
  async function clearPanelOperationState() { await getServiceAssembly().clearPanelOperationState(); }
  function getKnownProjectRoot() { return getServiceAssembly().getKnownProjectRoot(); }
  function createNonce() { return crypto.randomBytes(16).toString("base64"); }
  async function effectiveWatchdogSettings(root) { return getRuntimeHelpers().effectiveWatchdogSettings(root); }
  async function renderWatchdogEnv(root) { return getRuntimeHelpers().renderWatchdogEnv(root); }
  async function bootstrapProject(root) { return getBootstrapScaffoldingHelpers().bootstrapProject(root); }
  async function ensureWatchdogReadme(root) { return getBootstrapScaffoldingHelpers().ensureWatchdogReadme(root); }
  async function createDemoProjectTemplate(root) { return getBootstrapScaffoldingHelpers().createDemoProjectTemplate(root); }
  async function writeSystemdUnits(root, units) { return getRuntimeHelpers().writeSystemdUnits(root, units); }
  async function ensureCodexHome(root) { return getRuntimeHelpers().ensureCodexHome(root); }
  function inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome = path.join(os.homedir(), ".codex")) {
    return getRuntimeHelpers().inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome);
  }
  function inspectWatcherHomeBootstrap(root) { return getRuntimeHelpers().inspectWatcherHomeBootstrap(root); }
  async function seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome = path.join(os.homedir(), ".codex")) {
    return getRuntimeHelpers().seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome);
  }
  async function seedWatcherHomeAuthFromMainProfile(root) { return getRuntimeHelpers().seedWatcherHomeAuthFromMainProfile(root); }
  async function getCodexLoginStatus(root) { return getRuntimeHelpers().getCodexLoginStatus(root); }
  async function confirmLoginIfNeeded(root) { return getRuntimeHelpers().confirmLoginIfNeeded(root); }
  async function openLoginTerminal(rootArg) { return getRuntimeHelpers().openLoginTerminal(rootArg); }
  async function getTimerStatus(root) { return getRuntimeHelpers().getTimerStatus(root); }
  function showBootstrapResult(result) { getBootstrapScaffoldingHelpers().showBootstrapResult(result); }
  function getWorkspaceRoot() { return getServiceAssembly().getWorkspaceRoot(); }
  async function selectProjectRoot(title) { return getServiceAssembly().selectProjectRoot(title); }
  async function browseExistingProjectRoot(title, raw) { return getServiceAssembly().browseExistingProjectRoot(title, raw); }
  async function normalizeProjectRootInput(raw, label, options = {}) {
    return getServiceAssembly().normalizeProjectRootInput(raw, label, options);
  }
  async function getProjectRoot() { return getServiceAssembly().getProjectRoot(); }
  async function rememberProjectRoot(root) { await getServiceAssembly().rememberProjectRoot(root); }
  async function clearRememberedProjectRoot() { await getServiceAssembly().clearRememberedProjectRoot(); }
  function readWatcherUnitDrift(root, settings, unitDir) { return getRuntimeHelpers().readWatcherUnitDrift(root, settings, unitDir); }
  function inspectProjectRuntimeClarity(root) { return getRuntimeHelpers().inspectProjectRuntimeClarity(root); }

  return {
    getProjectSetupHelpers,
    getProjectRootManager,
    taskLooksInstantiated,
    getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers: getGeneratedFilesHelpersDelegate,
    getBootstrapScaffoldingHelpers: getBootstrapScaffoldingHelpersDelegate,
    getRuntimeConfigHelpers: getRuntimeConfigHelpersDelegate,
    getRuntimeHelpers: getRuntimeHelpersDelegate,
    getProjectCommands,
    ensureGeneratedDirs,
    refreshGeneratedWatcherFiles,
    getGuardCommands,
    getControlPanelStateHelpers,
    getControlPanelMessageHandler,
    getControlPanelController,
    updateStatusBar,
    openControlPanelCommand,
    updateControlPanel,
    setPanelOperationState,
    clearPanelOperationState,
    getKnownProjectRoot,
    createNonce,
    effectiveWatchdogSettings,
    renderWatchdogEnv,
    bootstrapProject,
    ensureWatchdogReadme,
    createDemoProjectTemplate,
    writeSystemdUnits,
    ensureCodexHome,
    inspectWatcherHomeBootstrapState,
    inspectWatcherHomeBootstrap,
    seedWatcherHomeBootstrapFromProfilePaths,
    seedWatcherHomeAuthFromMainProfile,
    getCodexLoginStatus,
    confirmLoginIfNeeded,
    openLoginTerminal,
    getTimerStatus,
    showBootstrapResult,
    getWorkspaceRoot,
    selectProjectRoot,
    browseExistingProjectRoot,
    normalizeProjectRootInput,
    getProjectRoot,
    rememberProjectRoot,
    clearRememberedProjectRoot,
    readWatcherUnitDrift,
    inspectProjectRuntimeClarity
  };
}

module.exports = {
  createExtensionServiceDelegates
};
