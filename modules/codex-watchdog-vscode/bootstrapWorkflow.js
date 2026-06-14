"use strict";

const fs = require("fs");
const { createBootstrapCodexRunner } = require("./bootstrapCodexRunner");
const { createBootstrapInstantiationFlow } = require("./bootstrapInstantiationFlow");

function createBootstrapWorkflowHelpers({
  vscode,
  projectSetupHelpers,
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
}) {
  const bootstrapCodexRunner = createBootstrapCodexRunner({
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
  });
  const bootstrapInstantiationFlow = createBootstrapInstantiationFlow({
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
  });

  async function runBootstrapConversationTurn(root, userText) {
    return bootstrapCodexRunner.runBootstrapConversationTurn(root, userText);
  }

  async function buildBootstrapInstantiationDraft(root) {
    return bootstrapCodexRunner.buildBootstrapInstantiationDraft(root);
  }

  async function ensureBootstrapInstantiationDraft(root) {
    return bootstrapInstantiationFlow.ensureBootstrapInstantiationDraft(root);
  }

  async function instantiateBootstrapProjectCommand(root) {
    return bootstrapInstantiationFlow.instantiateBootstrapProjectCommand(root);
  }

  async function openBootstrapTranscriptCommand(root) {
    const file = bootstrapConversationMarkdownPath(root);
    if (!fs.existsSync(file)) {
      vscode.window.showWarningMessage("No bootstrap conversation transcript exists yet. Generate drafts first.");
      return;
    }
    await openDocument(file, false);
  }

  async function openBootstrapChangePreviewCommand(root) {
    return bootstrapInstantiationFlow.openBootstrapChangePreviewCommand(root);
  }

  return {
    runBootstrapConversationTurn,
    buildBootstrapInstantiationDraft,
    ensureBootstrapInstantiationDraft,
    instantiateBootstrapProjectCommand,
    openBootstrapTranscriptCommand,
    openBootstrapChangePreviewCommand
  };
}

module.exports = {
  createBootstrapWorkflowHelpers
};
