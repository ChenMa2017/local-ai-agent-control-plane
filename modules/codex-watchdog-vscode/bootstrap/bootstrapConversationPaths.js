"use strict";

const crypto = require("crypto");
const path = require("path");

const BOOTSTRAP_CONVERSATION_SCHEMA_VERSION = 1;

function createBootstrapId() {
  return crypto.randomBytes(16).toString("base64");
}

function bootstrapConversationJsonPath(root) {
  return path.join(root, "agent", "status", "bootstrap_conversation.json");
}

function bootstrapConversationMarkdownPath(root) {
  return path.join(root, "agent", "status", "bootstrap_conversation.md");
}

function bootstrapLastResultPath(root) {
  return path.join(root, "agent", "status", "bootstrap_last_result.json");
}

function bootstrapChangePreviewPath(root) {
  return path.join(root, "agent", "status", "bootstrap_change_preview.md");
}

function bootstrapArchiveDir(root) {
  return path.join(root, "agent", "status", "bootstrap_archive");
}

function bootstrapRuntimeStatePath(root) {
  return path.join(root, "agent", "status", "bootstrap_runtime.json");
}

function bootstrapResultSchemaPath(root) {
  return path.join(root, "agent", "schemas", "bootstrap_instantiation.schema.json");
}

function bootstrapConversationTurnSchemaPath(root) {
  return path.join(root, "agent", "schemas", "bootstrap_conversation_turn.schema.json");
}

function emptyBootstrapConversation(root) {
  return {
    schema_version: BOOTSTRAP_CONVERSATION_SCHEMA_VERSION,
    project_root: root,
    updated_at: "",
    draft_input: "",
    turns: [],
    latest_result: {
      ready_for_start_guard: false,
      open_questions: [],
      suggested_next_step: "Prepare the project and describe the watchdog setup goal.",
      has_draft: false,
      applied_at: ""
    }
  };
}

function emptyBootstrapRuntimeState() {
  return {
    status: "idle",
    detail: "",
    started_at: "",
    updated_at: "",
    completed_at: "",
    error: "",
    pending_input: ""
  };
}

module.exports = {
  BOOTSTRAP_CONVERSATION_SCHEMA_VERSION,
  createBootstrapId,
  bootstrapConversationJsonPath,
  bootstrapConversationMarkdownPath,
  bootstrapLastResultPath,
  bootstrapChangePreviewPath,
  bootstrapArchiveDir,
  bootstrapRuntimeStatePath,
  bootstrapResultSchemaPath,
  bootstrapConversationTurnSchemaPath,
  emptyBootstrapConversation,
  emptyBootstrapRuntimeState
};
