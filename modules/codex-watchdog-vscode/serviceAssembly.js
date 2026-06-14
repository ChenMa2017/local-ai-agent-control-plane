"use strict";

const packageMetadata = require("./package.json");
const { createProjectRootManager } = require("./projectRootManager");
const { createRuntimeConfigHelpers } = require("./runtimeConfig");
const { createRuntimeHelpers } = require("./runtimeHelpers");
const { createProjectCommands } = require("./projectCommands");
const { createProjectSetupHelpers } = require("./projectSetup");
const { createBootstrapWorkflowHelpers } = require("./bootstrapWorkflow");
const { createGeneratedFilesHelpers } = require("./generatedFiles");
const { createBootstrapScaffoldingHelpers } = require("./bootstrapScaffolding");
const { createGuardLifecycle } = require("./guardLifecycle");
const { createControlPanelStateHelpers } = require("./controlPanelState");
const { createControlPanelActionHandler } = require("./controlPanelActions");
const { createControlPanelController } = require("./controlPanelController");
const { activateWatchdogServices, registerWatchdogCommand } = require("./serviceActivation");
const {
  bootstrapChangePreviewPath,
  bootstrapConversationMarkdownPath,
  bootstrapConversationPromptText,
  bootstrapConversationTurnSchemaPath,
  bootstrapLastResultPath,
  bootstrapResultSchemaPath,
  bootstrapInstantiationPromptText,
  emptyBootstrapRuntimeState,
  getBootstrapConversationState,
  readBootstrapConversation,
  writeBootstrapConversation,
  writeBootstrapRuntimeState,
  clearBootstrapDraftArtifacts,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
} = require("./bootstrapConversation");

function createServiceAssembly({
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
  ensureDir,
  openDocument,
  extensionSetting,
  extensionSettingWithSource,
  projectSetting,
  projectSettingWithSource,
  expandHome,
  isExistingDirectory,
  isSafeProjectRootPath,
  validateProjectRootPath,
  requireExistingDirectory,
  resolveCodexBin,
  runLogged,
  runLoggedWithInput,
  createNonce,
  updateProjectSetting,
  run,
  unitNames,
  systemdQuote,
  systemdPathValue,
  systemdEnvValue,
  shellQuote,
  readFilePrefix,
  isWatchdogInitialized,
  isEffectivelyEmptyDir
}) {
  let guardCommands;
  let projectSetupHelpers;
  let bootstrapWorkflowHelpers;
  let generatedFilesHelpers;
  let bootstrapScaffoldingHelpers;
  let projectRootManager;
  let runtimeConfigHelpers;
  let runtimeHelpers;
  let projectCommands;
  let controlPanelStateHelpers;
  let controlPanelMessageHandler;
  let controlPanelController;

  function getProjectSetupHelpers() {
    if (!projectSetupHelpers) {
      projectSetupHelpers = createProjectSetupHelpers({
        vscode,
        ensureDir,
        bootstrapProject,
        showBootstrapResult,
        refreshGeneratedWatcherFiles: (root) => getGeneratedFilesHelpers().refreshGeneratedWatcherFiles(root),
        bootstrapResultSchemaPath,
        bootstrapConversationTurnSchemaPath,
        openDocument
      });
    }
    return projectSetupHelpers;
  }

  function getProjectRootManager() {
    if (!projectRootManager) {
      projectRootManager = createProjectRootManager({
        vscode,
        fs,
        path,
        os,
        projectRootKey,
        getExtensionContext,
        output: getOutput(),
        updateStatusBar: () => updateStatusBar(),
        extensionSetting,
        expandHome,
        isExistingDirectory,
        isSafeProjectRootPath,
        validateProjectRootPath,
        ensureDir,
        requireExistingDirectory
      });
    }
    return projectRootManager;
  }

  function getBootstrapWorkflowHelpers() {
    if (!bootstrapWorkflowHelpers) {
      const runtimeConfig = getRuntimeConfigHelpers();
      bootstrapWorkflowHelpers = createBootstrapWorkflowHelpers({
        vscode,
        projectSetupHelpers: getProjectSetupHelpers(),
        resolveCodexBin,
        codexHomeSetting: runtimeConfig.codexHomeSetting,
        readBootstrapConversation,
        writeBootstrapConversation,
        clearBootstrapDraftArtifacts,
        bootstrapLastResultPath,
        bootstrapConversationPromptText,
        bootstrapConversationTurnSchemaPath,
        runLoggedWithInput,
        watchdogCommandTimeoutMs,
        createNonce,
        bootstrapInstantiationPromptText,
        bootstrapResultSchemaPath,
        stageBootstrapDraftFiles,
        applyBootstrapDraftFiles,
        openDocument,
        bootstrapConversationMarkdownPath,
        bootstrapChangePreviewPath,
        ensureCodexHome,
        writeBootstrapRuntimeState,
        emptyBootstrapRuntimeState,
        updateControlPanel,
        confirmLoginIfNeeded
      });
    }
    return bootstrapWorkflowHelpers;
  }

  function getGeneratedFilesHelpers() {
    if (!generatedFilesHelpers) {
      generatedFilesHelpers = createGeneratedFilesHelpers({
        fs,
        fsp,
        path,
        crypto,
        packageVersion: packageMetadata.version,
        templates,
        ensureDir,
        output: getOutput(),
        ensureCodexHome,
        renderWatchdogEnv
      });
    }
    return generatedFilesHelpers;
  }

  function getBootstrapScaffoldingHelpers() {
    if (!bootstrapScaffoldingHelpers) {
      bootstrapScaffoldingHelpers = createBootstrapScaffoldingHelpers({
        fs,
        fsp,
        path,
        vscode,
        templates,
        output: getOutput(),
        ensureDir,
        generatedFilesHelpers: getGeneratedFilesHelpers(),
        getProjectSetupHelpers,
        isWatchdogInitialized,
        isEffectivelyEmptyDir
      });
    }
    return bootstrapScaffoldingHelpers;
  }

  function getRuntimeConfigHelpers() {
    if (!runtimeConfigHelpers) {
      runtimeConfigHelpers = createRuntimeConfigHelpers({
        fs,
        path,
        os,
        output: getOutput(),
        defaultWatchdogRole,
        defaultServicePrefix,
        extensionSetting,
        extensionSettingWithSource,
        projectSetting,
        projectSettingWithSource,
        expandHome
      });
    }
    return runtimeConfigHelpers;
  }

  function getRuntimeHelpers() {
    if (!runtimeHelpers) {
      const runtimeConfig = getRuntimeConfigHelpers();
      runtimeHelpers = createRuntimeHelpers({
        vscode,
        fs,
        fsp,
        path,
        os,
        output: getOutput(),
        loginReadyRe,
        resolveCodexBin,
        codexHomeSetting: runtimeConfig.codexHomeSetting,
        codexHomePlan: runtimeConfig.codexHomePlan,
        sandboxModeSetting: runtimeConfig.sandboxModeSetting,
        positiveNumberSetting: runtimeConfig.positiveNumberSetting,
        extensionSetting,
        watchdogRoleSetting: runtimeConfig.watchdogRoleSetting,
        booleanSetting: runtimeConfig.booleanSetting,
        servicePrefixSetting: runtimeConfig.servicePrefixSetting,
        defaultTimeoutMinutes,
        defaultIntervalMinutes,
        defaultCompactEveryRuns,
        defaultPhaseOffsetMinutes,
        defaultSupervisorLightFollowup,
        defaultSupervisorAuditEveryRunnerRuns,
        updateProjectSetting,
        watcherProfileModelDefaults: runtimeConfig.watcherProfileModelDefaults,
        mergeWatcherConfigText: runtimeConfig.mergeWatcherConfigText,
        hasTomlAssignment: runtimeConfig.hasTomlAssignment,
        parseTomlBasicString: runtimeConfig.parseTomlBasicString,
        run,
        ensureDir,
        unitNames,
        systemdQuote,
        systemdPathValue,
        systemdEnvValue,
        shellQuote,
        getProjectRoot,
        readFilePrefix
      });
    }
    return runtimeHelpers;
  }

  function getProjectCommands() {
    if (!projectCommands) {
      projectCommands = createProjectCommands({
        vscode,
        fs,
        fsp,
        path,
        getProjectRoot,
        selectProjectRoot,
        rememberProjectRoot,
        ensureCodexHome,
        confirmLoginIfNeeded,
        effectiveWatchdogSettings,
        positiveNumberSetting,
        extensionSetting,
        defaultTimeoutMinutes,
        getBootstrapScaffoldingHelpers,
        getGeneratedFilesHelpers,
        getProjectSetupHelpers,
        getBootstrapWorkflowHelpers,
        writeBootstrapRuntimeState,
        emptyBootstrapRuntimeState,
        setPanelOperationState,
        clearPanelOperationState,
        updateControlPanel,
        openDocument
      });
    }
    return projectCommands;
  }

  function getGuardCommands() {
    if (!guardCommands) {
      const commands = getProjectCommands();
      guardCommands = createGuardLifecycle({
        vscode,
        output: getOutput(),
        getProjectRoot,
        ensureDir,
        prepareProjectForGuard: getProjectSetupHelpers().prepareProjectForGuard,
        confirmTaskInstantiatedIfNeeded: getProjectSetupHelpers().confirmTaskInstantiatedIfNeeded,
        ensureCodexHome,
        confirmLoginIfNeeded,
        runLogged,
        watchdogCommandEnv: commands.watchdogCommandEnv,
        watchdogCommandTimeoutMs: commands.watchdogCommandTimeoutMs,
        setPanelOperationState: (data) => getControlPanelController().setPanelOperationState(data),
        clearPanelOperationState: () => getControlPanelController().clearPanelOperationState(),
        updateStatusBar: () => getControlPanelController().updateStatusBar(),
        unitNames,
        getTimerStatus,
        openDocument
      });
    }
    return guardCommands;
  }

  function getControlPanelStateHelpers() {
    if (!controlPanelStateHelpers) {
      const runtimeConfig = getRuntimeConfigHelpers();
      const commands = getProjectCommands();
      controlPanelStateHelpers = createControlPanelStateHelpers({
        getKnownProjectRoot,
        isWatchdogInitialized,
        getProjectSetupHelpers,
        isGuardPaused: commands.isGuardPaused,
        codexHomePlan: runtimeConfig.codexHomePlan,
        resolveCodexBin,
        sandboxModeSetting: runtimeConfig.sandboxModeSetting,
        positiveNumberSetting: runtimeConfig.positiveNumberSetting,
        extensionSetting,
        DEFAULT_TIMEOUT_MINUTES: defaultTimeoutMinutes,
        DEFAULT_INTERVAL_MINUTES: defaultIntervalMinutes,
        DEFAULT_COMPACT_EVERY_RUNS: defaultCompactEveryRuns,
        getCodexLoginStatus,
        getTimerStatus,
        inspectProjectRuntimeClarity,
        effectiveWatchdogSettings,
        readWatcherUnitDrift,
        getBootstrapConversationState,
        readFilePrefix
      });
    }
    return controlPanelStateHelpers;
  }

  function getControlPanelMessageHandler() {
    if (!controlPanelMessageHandler) {
      const commands = getProjectCommands();
      controlPanelMessageHandler = createControlPanelActionHandler({
        vscode,
        getProjectRoot,
        selectProjectRoot,
        rememberProjectRoot,
        showProjectRootSelected: commands.showProjectRootSelected,
        browseExistingProjectRoot,
        normalizeProjectRootInput,
        clearRememberedProjectRoot,
        updateProjectSetting,
        readWatcherUnitDrift,
        effectiveWatchdogSettings,
        updateControlPanel,
        openLoginTerminal,
        prepareProjectCommand: commands.prepareProjectCommand,
        generateBootstrapConversationCommand: commands.generateBootstrapConversationCommand,
        getBootstrapWorkflowHelpers,
        getProjectSetupHelpers,
        archiveAndResetBootstrapConversation,
        getGuardCommands,
        openMorningBriefCommand: commands.openMorningBriefCommand,
        refreshGeneratedFilesCommand: commands.refreshGeneratedFilesCommand
      });
    }
    return controlPanelMessageHandler;
  }

  function getControlPanelController() {
    if (!controlPanelController) {
      const commands = getProjectCommands();
      controlPanelController = createControlPanelController({
        vscode,
        output: getOutput(),
        statusRefreshMs,
        emptyPanelOperationState,
        nextPanelOperationState,
        getKnownProjectRoot,
        isGuardPaused: commands.isGuardPaused,
        getTimerStatus,
        getControlPanelStateHelpers,
        getControlPanelMessageHandler
      });
    }
    return controlPanelController;
  }

  function activate(context) {
    projectSetupHelpers = getProjectSetupHelpers();
    bootstrapWorkflowHelpers = getBootstrapWorkflowHelpers();
    projectCommands = getProjectCommands();
    guardCommands = getGuardCommands();
    bootstrapScaffoldingHelpers = getBootstrapScaffoldingHelpers();
    controlPanelStateHelpers = getControlPanelStateHelpers();
    controlPanelMessageHandler = getControlPanelMessageHandler();
    controlPanelController = getControlPanelController();

    activateWatchdogServices({
      registerCommand: (command, handler) => registerWatchdogCommand({
        context,
        vscode,
        output: getOutput(),
        updateStatusBar: () => getControlPanelController().updateStatusBar()
      }, command, handler),
      initializeStatusBar: () => initializeStatusBar(context),
      openControlPanelCommand,
      projectCommands,
      guardCommands
    });
  }

  function deactivate() {
    if (controlPanelController) {
      controlPanelController.deactivate();
    }
  }

  function initializeStatusBar(context) {
    getControlPanelController().initializeStatusBar(context);
  }

  async function updateStatusBar() {
    await getControlPanelController().updateStatusBar();
  }

  async function openControlPanelCommand() {
    await getControlPanelController().openControlPanel();
  }

  async function updateControlPanel() {
    await getControlPanelController().updateControlPanel();
  }

  async function setPanelOperationState(data) {
    await getControlPanelController().setPanelOperationState(data);
  }

  async function clearPanelOperationState() {
    await getControlPanelController().clearPanelOperationState();
  }

  function getKnownProjectRoot() {
    return getProjectRootManager().getKnownProjectRoot();
  }

  function getWorkspaceRoot() {
    return getProjectRootManager().getWorkspaceRoot();
  }

  async function selectProjectRoot(title) {
    return getProjectRootManager().selectProjectRoot(title);
  }

  async function browseExistingProjectRoot(title, raw) {
    return getProjectRootManager().browseExistingProjectRoot(title, raw);
  }

  async function normalizeProjectRootInput(raw, label, options = {}) {
    return getProjectRootManager().normalizeProjectRootInput(raw, label, options);
  }

  async function getProjectRoot() {
    return getProjectRootManager().getProjectRoot();
  }

  async function rememberProjectRoot(root) {
    await getProjectRootManager().rememberProjectRoot(root);
  }

  async function clearRememberedProjectRoot() {
    await getProjectRootManager().clearRememberedProjectRoot();
  }

  async function effectiveWatchdogSettings(root) {
    return getRuntimeHelpers().effectiveWatchdogSettings(root);
  }

  async function renderWatchdogEnv(root) {
    return getRuntimeHelpers().renderWatchdogEnv(root);
  }

  async function bootstrapProject(root) {
    return getBootstrapScaffoldingHelpers().bootstrapProject(root);
  }

  function showBootstrapResult(result) {
    return getBootstrapScaffoldingHelpers().showBootstrapResult(result);
  }

  async function ensureWatchdogReadme(root) {
    return getBootstrapScaffoldingHelpers().ensureWatchdogReadme(root);
  }

  async function createDemoProjectTemplate(root) {
    return getBootstrapScaffoldingHelpers().createDemoProjectTemplate(root);
  }

  async function writeSystemdUnits(root, units) {
    return getRuntimeHelpers().writeSystemdUnits(root, units);
  }

  async function ensureCodexHome(root) {
    return getRuntimeHelpers().ensureCodexHome(root);
  }

  function inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome) {
    return getRuntimeHelpers().inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome);
  }

  function inspectWatcherHomeBootstrap(root) {
    return getRuntimeHelpers().inspectWatcherHomeBootstrap(root);
  }

  async function seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome) {
    return getRuntimeHelpers().seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome);
  }

  async function seedWatcherHomeAuthFromMainProfile(root) {
    return getRuntimeHelpers().seedWatcherHomeAuthFromMainProfile(root);
  }

  async function getCodexLoginStatus(root) {
    return getRuntimeHelpers().getCodexLoginStatus(root);
  }

  async function confirmLoginIfNeeded(root) {
    return getRuntimeHelpers().confirmLoginIfNeeded(root);
  }

  async function openLoginTerminal(root) {
    return getRuntimeHelpers().openLoginTerminal(root);
  }

  async function getTimerStatus(root) {
    return getRuntimeHelpers().getTimerStatus(root);
  }

  function readWatcherUnitDrift(root, settings, unitDir) {
    return getRuntimeHelpers().readWatcherUnitDrift(root, settings, unitDir);
  }

  function inspectProjectRuntimeClarity(root) {
    return getRuntimeHelpers().inspectProjectRuntimeClarity(root);
  }

  function taskLooksInstantiated(root) {
    return getProjectSetupHelpers().taskLooksInstantiated(root);
  }

  return {
    activate,
    deactivate,
    updateStatusBar,
    openControlPanelCommand,
    updateControlPanel,
    setPanelOperationState,
    clearPanelOperationState,
    getKnownProjectRoot,
    getWorkspaceRoot,
    selectProjectRoot,
    browseExistingProjectRoot,
    normalizeProjectRootInput,
    getProjectRoot,
    rememberProjectRoot,
    clearRememberedProjectRoot,
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
    readWatcherUnitDrift,
    inspectProjectRuntimeClarity,
    taskLooksInstantiated,
    getProjectSetupHelpers,
    getProjectRootManager,
    getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers,
    getBootstrapScaffoldingHelpers,
    getRuntimeConfigHelpers,
    getRuntimeHelpers,
    getProjectCommands,
    getGuardCommands,
    getControlPanelStateHelpers,
    getControlPanelMessageHandler,
    getControlPanelController
  };
}

module.exports = {
  createServiceAssembly
};
