"use strict";

function buildBootstrapCodexRunnerArgs({
  resolveCodexBin,
  codexHomeSetting,
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
  stageBootstrapDraftFiles
}) {
  return {
    resolveCodexBin,
    codexHomeSetting,
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
    stageBootstrapDraftFiles
  };
}

function buildBootstrapInstantiationFlowArgs({
  vscode,
  projectSetupHelpers,
  bootstrapCodexRunner,
  bootstrapLastResultPath,
  bootstrapChangePreviewPath,
  ensureCodexHome,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  updateControlPanel,
  confirmLoginIfNeeded,
  applyBootstrapDraftFiles,
  readBootstrapConversation,
  writeBootstrapConversation,
  openDocument
}) {
  return {
    vscode,
    projectSetupHelpers,
    bootstrapCodexRunner,
    bootstrapLastResultPath,
    bootstrapChangePreviewPath,
    ensureCodexHome,
    writeBootstrapRuntimeState,
    emptyBootstrapRuntimeState,
    updateControlPanel,
    confirmLoginIfNeeded,
    applyBootstrapDraftFiles,
    readBootstrapConversation,
    writeBootstrapConversation,
    openDocument
  };
}

module.exports = {
  buildBootstrapCodexRunnerArgs,
  buildBootstrapInstantiationFlowArgs
};
