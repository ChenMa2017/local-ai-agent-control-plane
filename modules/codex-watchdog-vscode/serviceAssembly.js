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
const { createServiceAssemblyBridges } = require("./serviceBridges");
const { createServiceControlPanelFactory } = require("./serviceControlPanelFactory");
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
  const bridges = createServiceAssemblyBridges({
    getProjectRootManager,
    getRuntimeHelpers,
    getBootstrapScaffoldingHelpers,
    getControlPanelController,
    getProjectSetupHelpers,
    resolveCodexBin,
    updateProjectSetting,
    archiveAndResetBootstrapConversation
  });
  const controlPanelServices = createServiceControlPanelFactory({
    createControlPanelStateHelpers,
    createControlPanelActionHandler,
    createControlPanelController,
    vscode,
    getOutput,
    statusRefreshMs,
    emptyPanelOperationState,
    nextPanelOperationState,
    defaultTimeoutMinutes,
    defaultIntervalMinutes,
    defaultCompactEveryRuns,
    extensionSetting,
    isWatchdogInitialized,
    getProjectSetupHelpers,
    getProjectCommands,
    getRuntimeConfigHelpers,
    getBootstrapWorkflowHelpers,
    getGuardCommands,
    bridges,
    getBootstrapConversationState,
    readFilePrefix
  });

  function getProjectSetupHelpers() {
    if (!projectSetupHelpers) {
      projectSetupHelpers = createProjectSetupHelpers({
        vscode,
        ensureDir,
        bootstrapProject: bridges.bootstrapProject,
        showBootstrapResult: bridges.showBootstrapResult,
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
        updateStatusBar: () => bridges.updateStatusBar(),
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
        ensureCodexHome: bridges.ensureCodexHome,
        writeBootstrapRuntimeState,
        emptyBootstrapRuntimeState,
        updateControlPanel: bridges.updateControlPanel,
        confirmLoginIfNeeded: bridges.confirmLoginIfNeeded
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
        ensureCodexHome: bridges.ensureCodexHome,
        renderWatchdogEnv: bridges.renderWatchdogEnv
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
        getProjectRoot: bridges.getProjectRoot,
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
        getProjectRoot: bridges.getProjectRoot,
        selectProjectRoot: bridges.selectProjectRoot,
        rememberProjectRoot: bridges.rememberProjectRoot,
        ensureCodexHome: bridges.ensureCodexHome,
        confirmLoginIfNeeded: bridges.confirmLoginIfNeeded,
        effectiveWatchdogSettings: bridges.effectiveWatchdogSettings,
        positiveNumberSetting,
        extensionSetting,
        defaultTimeoutMinutes,
        getBootstrapScaffoldingHelpers,
        getGeneratedFilesHelpers,
        getProjectSetupHelpers,
        getBootstrapWorkflowHelpers,
        writeBootstrapRuntimeState,
        emptyBootstrapRuntimeState,
        setPanelOperationState: bridges.setPanelOperationState,
        clearPanelOperationState: bridges.clearPanelOperationState,
        updateControlPanel: bridges.updateControlPanel,
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
        getProjectRoot: bridges.getProjectRoot,
        ensureDir,
        prepareProjectForGuard: getProjectSetupHelpers().prepareProjectForGuard,
        confirmTaskInstantiatedIfNeeded: getProjectSetupHelpers().confirmTaskInstantiatedIfNeeded,
        ensureCodexHome: bridges.ensureCodexHome,
        confirmLoginIfNeeded: bridges.confirmLoginIfNeeded,
        runLogged,
        watchdogCommandEnv: commands.watchdogCommandEnv,
        watchdogCommandTimeoutMs: commands.watchdogCommandTimeoutMs,
        setPanelOperationState: (data) => getControlPanelController().setPanelOperationState(data),
        clearPanelOperationState: () => getControlPanelController().clearPanelOperationState(),
        updateStatusBar: () => bridges.updateStatusBar(),
        unitNames,
        getTimerStatus: bridges.getTimerStatus,
        openDocument
      });
    }
    return guardCommands;
  }

  function getControlPanelStateHelpers() {
    return controlPanelServices.getControlPanelStateHelpers();
  }

  function getControlPanelMessageHandler() {
    return controlPanelServices.getControlPanelMessageHandler();
  }

  function getControlPanelController() {
    return controlPanelServices.getControlPanelController();
  }

  function activate(context) {
    projectSetupHelpers = getProjectSetupHelpers();
    bootstrapWorkflowHelpers = getBootstrapWorkflowHelpers();
    projectCommands = getProjectCommands();
    guardCommands = getGuardCommands();
    bootstrapScaffoldingHelpers = getBootstrapScaffoldingHelpers();
    getControlPanelStateHelpers();
    getControlPanelMessageHandler();
    getControlPanelController();

    activateWatchdogServices({
      registerCommand: (command, handler) => registerWatchdogCommand({
        context,
        vscode,
        output: getOutput(),
        updateStatusBar: () => bridges.updateStatusBar()
      }, command, handler),
      initializeStatusBar: () => bridges.initializeStatusBar(context),
      openControlPanelCommand: bridges.openControlPanelCommand,
      projectCommands,
      guardCommands
    });
  }

  function deactivate() {
    controlPanelServices.deactivate();
  }

  return {
    activate,
    deactivate,
    ...bridges,
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
