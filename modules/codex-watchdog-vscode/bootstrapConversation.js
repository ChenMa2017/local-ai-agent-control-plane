"use strict";

const {
  bootstrapArchiveDir,
  bootstrapChangePreviewPath,
  bootstrapConversationJsonPath,
  bootstrapConversationMarkdownPath,
  bootstrapLastResultPath,
  bootstrapResultSchemaPath,
  bootstrapRuntimeStatePath,
  bootstrapConversationTurnSchemaPath,
  emptyBootstrapConversation,
  emptyBootstrapRuntimeState
} = require("./bootstrapConversationPaths");
const {
  readBootstrapConversation,
  readBootstrapRuntimeState,
  renderBootstrapConversationMarkdown,
  writeBootstrapConversation,
  writeBootstrapRuntimeState,
  getBootstrapConversationState
} = require("./bootstrapConversationStore");
const {
  normalizeMarkdownDraft,
  summarizeBootstrapDraftChanges,
  writeBootstrapChangePreview,
  clearBootstrapDraftArtifacts,
  collectBootstrapDraftChanges,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
} = require("./bootstrapConversationDrafts");
const {
  bootstrapConversationPromptText,
  bootstrapInstantiationPromptText
} = require("./bootstrapConversationPrompts");

module.exports = {
  bootstrapArchiveDir,
  bootstrapChangePreviewPath,
  bootstrapConversationJsonPath,
  bootstrapConversationMarkdownPath,
  bootstrapConversationPromptText,
  bootstrapConversationTurnSchemaPath,
  bootstrapLastResultPath,
  bootstrapResultSchemaPath,
  bootstrapRuntimeStatePath,
  bootstrapInstantiationPromptText,
  emptyBootstrapConversation,
  emptyBootstrapRuntimeState,
  getBootstrapConversationState,
  readBootstrapConversation,
  readBootstrapRuntimeState,
  renderBootstrapConversationMarkdown,
  writeBootstrapConversation,
  writeBootstrapRuntimeState,
  normalizeMarkdownDraft,
  summarizeBootstrapDraftChanges,
  writeBootstrapChangePreview,
  clearBootstrapDraftArtifacts,
  collectBootstrapDraftChanges,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
};
