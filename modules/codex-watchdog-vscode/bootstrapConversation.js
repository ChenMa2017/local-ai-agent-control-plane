"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
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

function bootstrapConversationPromptText(root, conversation) {
  const transcript = conversation.turns.slice(-12).map((turn) => {
    const label = turn.role === "assistant" ? "AI reply" : "User request";
    return `### ${label}\n${turn.text}`;
  }).join("\n\n");
  return [
    "You are helping the user discuss and refine a Codex Watchdog project bootstrap inside the VSCode control panel.",
    "",
    `Project root: ${root}`,
    "",
    "Read these files before answering:",
    "- README.codex-watchdog.md",
    "- agent/TASK_REQUEST.md",
    "- agent/CODEX_TAKEOVER.md",
    "- agent/PLAN.md",
    "- agent/TODO.md",
    "- agent/STATE.md",
    "- agent/SAFETY.md",
    "- agent/DAILY_HANDOFF.md",
    "",
    "Your job in this turn is discussion, not full file instantiation.",
    "- First answer the user's latest question directly and conversationally.",
    "- Reply in the same language the user is currently using, unless they ask you to switch.",
    "- Then briefly explain how your current understanding of the watchdog setup changed.",
    "- Ask only the most important follow-up questions, if any.",
    "- Do not narrate internal progress as if it were the final answer.",
    "- Do not claim the project files were already updated unless the user explicitly ran Instantiate Project.",
    "",
    "Return JSON matching the provided schema.",
    "`assistant_reply` should read like a real answer to the user, not like a status log.",
    "`suggested_next_step` should explain whether the user should keep discussing, preview the candidate setup, or instantiate the project.",
    "",
    "Bootstrap conversation transcript:",
    transcript || "(no previous messages)"
  ].join("\n");
}

function bootstrapInstantiationPromptText(root, conversation) {
  const transcript = conversation.turns.slice(-12).map((turn) => {
    const label = turn.role === "assistant" ? "AI reply" : "User request";
    return `### ${label}\n${turn.text}`;
  }).join("\n\n");
  return [
    "You are daily Codex working inside the Codex Watchdog VSCode bootstrap conversation.",
    "",
    `Project root: ${root}`,
    "",
    "Read these files from the project before deciding the setup:",
    "- README.codex-watchdog.md",
    "- agent/TASK_REQUEST.md",
    "- agent/CODEX_TAKEOVER.md",
    "- agent/PLAN.md",
    "- agent/TODO.md",
    "- agent/STATE.md",
    "- agent/SAFETY.md",
    "- agent/DAILY_HANDOFF.md",
    "",
    "Goal:",
    "- turn the user's setup conversation into concrete watchdog bootstrap files;",
    "- keep the first objective bounded and safe;",
    "- do not start the guard;",
    "- do not assume training, GPU work, external sends, or destructive actions unless the user explicitly asks and the files make that safe;",
    "- prefer read-only bootstrap goals when the project is still being defined.",
    "",
    "Return JSON matching the provided schema.",
    "The markdown fields must be complete file contents, not summaries and not fenced code blocks.",
    "`assistant_reply` should use the same language the user is currently using.",
    "`assistant_reply` should be a concise UI-facing answer that explains the candidate setup and what still needs review.",
    "`ready_for_start_guard` should be true only if the files look concrete enough that a later manual Start Guard would make sense.",
    "",
    "Bootstrap conversation transcript:",
    transcript || "(no previous messages)"
  ].join("\n");
}

function normalizeMarkdownDraft(text) {
  const trimmed = String(text || "").trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
  const body = fenceMatch ? fenceMatch[1] : trimmed;
  return `${body.trimEnd()}\n`;
}

function summarizeBootstrapDraftChanges(changes) {
  const lines = [
    "# Bootstrap Change Preview",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "This preview summarizes what the latest bootstrap conversation changed in the five core watchdog handoff files.",
    ""
  ];
  for (const change of changes) {
    lines.push(`## ${change.relativePath}`);
    lines.push("");
    lines.push(`- Status: ${change.changed ? "updated" : "unchanged"}`);
    lines.push(`- Previous length: ${change.previousLength}`);
    lines.push(`- New length: ${change.nextLength}`);
    lines.push("");
    lines.push("### Incoming preview");
    lines.push("");
    lines.push("```markdown");
    lines.push(change.preview.trimEnd());
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeBootstrapChangePreview(root, changes) {
  const file = bootstrapChangePreviewPath(root);
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, summarizeBootstrapDraftChanges(changes));
  return file;
}

async function clearBootstrapDraftArtifacts(root) {
  for (const file of [
    bootstrapLastResultPath(root),
    bootstrapChangePreviewPath(root)
  ]) {
    if (fs.existsSync(file)) {
      await fsp.unlink(file);
    }
  }
}

async function collectBootstrapDraftChanges(root, result) {
  const mapping = [
    ["agent/PLAN.md", result.plan_md],
    ["agent/TODO.md", result.todo_md],
    ["agent/STATE.md", result.state_md],
    ["agent/SAFETY.md", result.safety_md],
    ["agent/DAILY_HANDOFF.md", result.daily_handoff_md]
  ];
  const changes = [];
  for (const [relativePath, content] of mapping) {
    const target = path.join(root, relativePath);
    const nextText = normalizeMarkdownDraft(content);
    const previousText = fs.existsSync(target) ? await fsp.readFile(target, "utf8") : "";
    changes.push({
      target,
      relativePath,
      changed: previousText !== nextText,
      previousLength: previousText.length,
      nextLength: nextText.length,
      preview: nextText.split(/\r?\n/).slice(0, 24).join("\n"),
      nextText
    });
  }
  return changes;
}

async function stageBootstrapDraftFiles(root, result) {
  const changes = await collectBootstrapDraftChanges(root, result);
  await fsp.writeFile(bootstrapLastResultPath(root), `${JSON.stringify(result, null, 2)}\n`);
  await writeBootstrapChangePreview(root, changes);
  return changes;
}

async function applyBootstrapDraftFiles(root, result) {
  const changes = await collectBootstrapDraftChanges(root, result);
  for (const change of changes) {
    await ensureDir(path.dirname(change.target));
    await fsp.writeFile(change.target, change.nextText);
  }
  await fsp.writeFile(bootstrapLastResultPath(root), `${JSON.stringify(result, null, 2)}\n`);
  await writeBootstrapChangePreview(root, changes);
  return changes;
}

async function archiveAndResetBootstrapConversation(root) {
  const archiveDir = bootstrapArchiveDir(root);
  await ensureDir(archiveDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidates = [
    bootstrapConversationJsonPath(root),
    bootstrapConversationMarkdownPath(root),
    bootstrapLastResultPath(root),
    bootstrapChangePreviewPath(root)
  ];
  for (const source of candidates) {
    if (!fs.existsSync(source)) {
      continue;
    }
    const target = path.join(archiveDir, `${stamp}-${path.basename(source)}`);
    await fsp.rename(source, target);
  }
  await writeBootstrapConversation(root, emptyBootstrapConversation(root));
  await writeBootstrapRuntimeState(root, emptyBootstrapRuntimeState());
}

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
