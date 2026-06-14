"use strict";

function createServiceProjectFactory({
  createProjectSetupHelpers,
  createBootstrapWorkflowHelpers,
  createGeneratedFilesHelpers,
  createBootstrapScaffoldingHelpers,
  createProjectCommands,
  createGuardLifecycle,
  vscode,
  fs,
  fsp,
  path,
  crypto,
  packageVersion,
  templates,
  ensureDir,
  getOutput,
  openDocument,
  getRuntimeConfigHelpers,
  bridges,
  bootstrapConversationTurnSchemaPath,
  bootstrapResultSchemaPath,
  bootstrapLastResultPath,
  bootstrapConversationPromptText,
  bootstrapInstantiationPromptText,
  bootstrapConversationMarkdownPath,
  bootstrapChangePreviewPath,
  readBootstrapConversation,
  writeBootstrapConversation,
  clearBootstrapDraftArtifacts,
  runLoggedWithInput,
  createNonce,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  extensionSetting,
  defaultTimeoutMinutes,
  isWatchdogInitialized,
  isEffectivelyEmptyDir,
  runLogged,
  unitNames,
  getControlPanelController
}) {
  let projectSetupHelpers;
  let bootstrapWorkflowHelpers;
  let generatedFilesHelpers;
  let bootstrapScaffoldingHelpers;
  let projectCommands;
  let guardCommands;

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

  function getBootstrapWorkflowHelpers() {
    if (!bootstrapWorkflowHelpers) {
      const runtimeConfig = getRuntimeConfigHelpers();
      bootstrapWorkflowHelpers = createBootstrapWorkflowHelpers({
        vscode,
        projectSetupHelpers: getProjectSetupHelpers(),
        resolveCodexBin: bridges.resolveCodexBin,
        codexHomeSetting: runtimeConfig.codexHomeSetting,
        readBootstrapConversation,
        writeBootstrapConversation,
        clearBootstrapDraftArtifacts,
        bootstrapLastResultPath,
        bootstrapConversationPromptText,
        bootstrapConversationTurnSchemaPath,
        runLoggedWithInput,
        watchdogCommandTimeoutMs: (root) => getProjectCommands().watchdogCommandTimeoutMs(root),
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
        packageVersion,
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

  function getProjectCommands() {
    if (!projectCommands) {
      const runtimeConfig = getRuntimeConfigHelpers();
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
        positiveNumberSetting: runtimeConfig.positiveNumberSetting,
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

  return {
    getProjectSetupHelpers,
    getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers,
    getBootstrapScaffoldingHelpers,
    getProjectCommands,
    getGuardCommands
  };
}

module.exports = {
  createServiceProjectFactory
};
