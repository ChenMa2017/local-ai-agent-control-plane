"use strict";

function buildProjectSetupHelperArgs({
  vscode,
  ensureDir,
  bridges,
  getGeneratedFilesHelpers,
  bootstrapResultSchemaPath,
  bootstrapConversationTurnSchemaPath,
  openDocument
}) {
  return {
    vscode,
    ensureDir,
    bootstrapProject: bridges.bootstrapProject,
    showBootstrapResult: bridges.showBootstrapResult,
    refreshGeneratedWatcherFiles: (root) => getGeneratedFilesHelpers().refreshGeneratedWatcherFiles(root),
    bootstrapResultSchemaPath,
    bootstrapConversationTurnSchemaPath,
    openDocument
  };
}

function buildBootstrapWorkflowHelperArgs({
  vscode,
  getProjectSetupHelpers,
  bridges,
  runtimeConfig,
  readBootstrapConversation,
  writeBootstrapConversation,
  clearBootstrapDraftArtifacts,
  bootstrapLastResultPath,
  bootstrapConversationPromptText,
  bootstrapConversationTurnSchemaPath,
  runLoggedWithInput,
  getProjectCommands,
  createNonce,
  bootstrapInstantiationPromptText,
  bootstrapResultSchemaPath,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  openDocument,
  bootstrapConversationMarkdownPath,
  bootstrapChangePreviewPath,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState
}) {
  return {
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
  };
}

function buildGeneratedFilesHelperArgs({
  fs,
  fsp,
  path,
  crypto,
  packageVersion,
  templates,
  ensureDir,
  getOutput,
  bridges
}) {
  return {
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
  };
}

function buildBootstrapScaffoldingHelperArgs({
  fs,
  fsp,
  path,
  vscode,
  templates,
  getOutput,
  ensureDir,
  getGeneratedFilesHelpers,
  getProjectSetupHelpers,
  isWatchdogInitialized,
  isEffectivelyEmptyDir
}) {
  return {
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
  };
}

module.exports = {
  buildProjectSetupHelperArgs,
  buildBootstrapWorkflowHelperArgs,
  buildGeneratedFilesHelperArgs,
  buildBootstrapScaffoldingHelperArgs
};
