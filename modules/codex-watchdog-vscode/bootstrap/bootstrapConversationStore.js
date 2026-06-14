"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const {
  BOOTSTRAP_CONVERSATION_SCHEMA_VERSION,
  createBootstrapId,
  bootstrapConversationJsonPath,
  bootstrapConversationMarkdownPath,
  bootstrapChangePreviewPath,
  bootstrapRuntimeStatePath,
  emptyBootstrapConversation,
  emptyBootstrapRuntimeState
} = require("./bootstrapConversationPaths");

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readBootstrapConversation(root) {
  const file = bootstrapConversationJsonPath(root);
  if (!fs.existsSync(file)) {
    return emptyBootstrapConversation(root);
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!parsed || parsed.schema_version !== BOOTSTRAP_CONVERSATION_SCHEMA_VERSION || !Array.isArray(parsed.turns)) {
      return emptyBootstrapConversation(root);
    }
    return {
      schema_version: BOOTSTRAP_CONVERSATION_SCHEMA_VERSION,
      project_root: root,
      updated_at: String(parsed.updated_at || ""),
      draft_input: String(parsed.draft_input || ""),
      turns: parsed.turns.map((turn) => ({
        id: String(turn.id || createBootstrapId()),
        role: turn.role === "assistant" ? "assistant" : "user",
        text: String(turn.text || "").trim(),
        created_at: String(turn.created_at || "")
      })).filter((turn) => turn.text),
      latest_result: {
        ready_for_start_guard: Boolean(parsed.latest_result && parsed.latest_result.ready_for_start_guard),
        open_questions: Array.isArray(parsed.latest_result && parsed.latest_result.open_questions)
          ? parsed.latest_result.open_questions.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
        suggested_next_step: String(parsed.latest_result && parsed.latest_result.suggested_next_step || ""),
        has_draft: Boolean(parsed.latest_result && parsed.latest_result.has_draft),
        applied_at: String(parsed.latest_result && parsed.latest_result.applied_at || "")
      }
    };
  } catch (_error) {
    return emptyBootstrapConversation(root);
  }
}

async function readBootstrapRuntimeState(root) {
  const file = bootstrapRuntimeStatePath(root);
  if (!fs.existsSync(file)) {
    return emptyBootstrapRuntimeState();
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    return {
      status: ["idle", "running", "error"].includes(parsed && parsed.status) ? parsed.status : "idle",
      detail: String(parsed && parsed.detail || ""),
      started_at: String(parsed && parsed.started_at || ""),
      updated_at: String(parsed && parsed.updated_at || ""),
      completed_at: String(parsed && parsed.completed_at || ""),
      error: String(parsed && parsed.error || ""),
      pending_input: String(parsed && parsed.pending_input || "")
    };
  } catch (_error) {
    return emptyBootstrapRuntimeState();
  }
}

function renderBootstrapConversationMarkdown(data) {
  const lines = [
    "# Bootstrap Conversation",
    "",
    data.updated_at ? `Last updated: ${data.updated_at}` : "Last updated: unknown",
    "",
    "This file keeps the watchdog project setup conversation inside the project so later Codex sessions can understand how the bootstrap was decided.",
    ""
  ];

  for (const turn of data.turns) {
    lines.push(`## ${turn.role === "assistant" ? "AI reply" : "User request"}`);
    if (turn.created_at) {
      lines.push(`Time: ${turn.created_at}`);
      lines.push("");
    }
    lines.push(turn.text);
    lines.push("");
  }

  lines.push("## Latest Setup Status");
  lines.push("");
  lines.push(`- Draft prepared: ${data.latest_result.has_draft ? "yes" : "not yet"}`);
  lines.push(`- Applied to project files: ${data.latest_result.applied_at || "not yet"}`);
  lines.push(`- Ready for Start Guard: ${data.latest_result.ready_for_start_guard ? "yes" : "not yet"}`);
  lines.push(`- Suggested next step: ${data.latest_result.suggested_next_step || "Review the setup files and continue the conversation if needed."}`);
  if (data.latest_result.open_questions.length) {
    lines.push("- Open questions:");
    for (const item of data.latest_result.open_questions) {
      lines.push(`  - ${item}`);
    }
  } else {
    lines.push("- Open questions: none");
  }
  lines.push("");
  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeBootstrapConversation(root, data) {
  const normalized = {
    schema_version: BOOTSTRAP_CONVERSATION_SCHEMA_VERSION,
    project_root: root,
    updated_at: data.updated_at || new Date().toISOString(),
    draft_input: String(data.draft_input || ""),
    turns: Array.isArray(data.turns) ? data.turns.map((turn) => ({
      id: String(turn.id || createBootstrapId()),
      role: turn.role === "assistant" ? "assistant" : "user",
      text: String(turn.text || "").trim(),
      created_at: String(turn.created_at || new Date().toISOString())
    })).filter((turn) => turn.text) : [],
    latest_result: {
      ready_for_start_guard: Boolean(data.latest_result && data.latest_result.ready_for_start_guard),
      open_questions: Array.isArray(data.latest_result && data.latest_result.open_questions)
        ? data.latest_result.open_questions.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      suggested_next_step: String(data.latest_result && data.latest_result.suggested_next_step || ""),
      has_draft: Boolean(data.latest_result && data.latest_result.has_draft),
      applied_at: String(data.latest_result && data.latest_result.applied_at || "")
    }
  };
  const jsonFile = bootstrapConversationJsonPath(root);
  const markdownFile = bootstrapConversationMarkdownPath(root);
  await ensureDir(path.dirname(jsonFile));
  await fsp.writeFile(jsonFile, `${JSON.stringify(normalized, null, 2)}\n`);
  await fsp.writeFile(markdownFile, renderBootstrapConversationMarkdown(normalized));
  return normalized;
}

async function writeBootstrapRuntimeState(root, data) {
  const file = bootstrapRuntimeStatePath(root);
  const normalized = {
    status: ["idle", "running", "error"].includes(data && data.status) ? data.status : "idle",
    detail: String(data && data.detail || ""),
    started_at: String(data && data.started_at || ""),
    updated_at: String(data && data.updated_at || new Date().toISOString()),
    completed_at: String(data && data.completed_at || ""),
    error: String(data && data.error || ""),
    pending_input: String(data && data.pending_input || "")
  };
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

async function getBootstrapConversationState(root) {
  const conversation = await readBootstrapConversation(root);
  const latest = conversation.latest_result || {};
  const previewFile = bootstrapChangePreviewPath(root);
  const runtime = await readBootstrapRuntimeState(root);
  const messages = conversation.turns.slice(-10).map((turn) => ({
    role: turn.role,
    text: turn.text,
    createdAt: turn.created_at
  }));
  let statusText;
  if (runtime.status === "running") {
    statusText = [
      "Waiting for AI reply.",
      runtime.detail || "Running setup conversation..."
    ].join("\n\n");
  } else if (runtime.status === "error") {
    statusText = [
      "The last draft attempt failed.",
      runtime.error || runtime.detail || "Check the Codex Watchdog output panel for details."
    ].join("\n\n");
  } else if (latest.has_draft && !latest.applied_at) {
    statusText = [
      "A new bootstrap draft is ready.",
      "Continue the conversation if you still want to refine the idea. When the goal is clear enough, click Instantiate Project to apply the current draft to PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF."
    ].join("\n\n");
  } else if (latest.applied_at) {
    statusText = [
      "The latest bootstrap draft has been applied to the project files.",
      latest.ready_for_start_guard
        ? "Review the instantiated files, then Start Guard when you want to enter unattended mode."
        : "Review the instantiated files and continue the conversation if more setup work is still needed before any guard start."
    ].join("\n\n");
  } else {
    statusText = [
      latest.ready_for_start_guard
        ? "Bootstrap drafts are in place. Review the files, then you can start the guard when ready."
        : "Use this conversation to refine the watchdog setup before any guard start.",
      latest.suggested_next_step || "Describe the project goal, allowed scope, and whether guard start should wait for review."
    ].join("\n\n");
  }
  return {
    messages,
    openQuestions: Array.isArray(latest.open_questions) ? latest.open_questions : [],
    readyForStartGuard: Boolean(latest.ready_for_start_guard),
    hasPreview: fs.existsSync(previewFile),
    hasDraft: Boolean(latest.has_draft),
    hasAppliedDraft: Boolean(latest.applied_at),
    draftText: String(runtime.pending_input || conversation.draft_input || ""),
    isRunning: runtime.status === "running",
    runtimeDetail: String(runtime.detail || ""),
    runtimeStartedAt: String(runtime.started_at || runtime.updated_at || ""),
    statusText
  };
}

module.exports = {
  readBootstrapConversation,
  readBootstrapRuntimeState,
  renderBootstrapConversationMarkdown,
  writeBootstrapConversation,
  writeBootstrapRuntimeState,
  getBootstrapConversationState
};
