"use strict";

const { createBootstrapCodexRunner } = require("./bootstrapCodexRunner");
const { createBootstrapInstantiationFlow } = require("./bootstrapInstantiationFlow");
const { createBootstrapTranscriptCommands } = require("./bootstrapTranscriptCommands");
const {
  buildBootstrapCodexRunnerArgs,
  buildBootstrapInstantiationFlowArgs
} = require("./bootstrapWorkflowArgBuilders");

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
  const bootstrapCodexRunner = createBootstrapCodexRunner(buildBootstrapCodexRunnerArgs({
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
  }));
  const bootstrapInstantiationFlow = createBootstrapInstantiationFlow(buildBootstrapInstantiationFlowArgs({
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
  }));
  const bootstrapTranscriptCommands = createBootstrapTranscriptCommands({
    vscode,
    openDocument,
    bootstrapConversationMarkdownPath
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
    return bootstrapTranscriptCommands.openBootstrapTranscriptCommand(root);
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
