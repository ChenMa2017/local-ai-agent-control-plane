"use strict";

function createServiceProjectHelperAccessors({
  createProjectSetupHelpers,
  createBootstrapWorkflowHelpers,
  createGeneratedFilesHelpers,
  createBootstrapScaffoldingHelpers,
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
  isWatchdogInitialized,
  isEffectivelyEmptyDir,
  getProjectCommands
}) {
  let projectSetupHelpers;
  let bootstrapWorkflowHelpers;
  let generatedFilesHelpers;
  let bootstrapScaffoldingHelpers;

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

  return {
    getProjectSetupHelpers,
    getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers,
    getBootstrapScaffoldingHelpers
  };
}

module.exports = {
  createServiceProjectHelperAccessors
};
