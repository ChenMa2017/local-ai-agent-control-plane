"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const {
  bootstrapArchiveDir,
  bootstrapLastResultPath,
  bootstrapChangePreviewPath,
  bootstrapConversationJsonPath,
  bootstrapConversationMarkdownPath,
  emptyBootstrapConversation,
  emptyBootstrapRuntimeState
} = require("./bootstrapConversationPaths");
const {
  writeBootstrapConversation,
  writeBootstrapRuntimeState
} = require("./bootstrapConversationStore");

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
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
  const lastResultFile = bootstrapLastResultPath(root);
  await ensureDir(path.dirname(lastResultFile));
  await fsp.writeFile(lastResultFile, `${JSON.stringify(result, null, 2)}\n`);
  await writeBootstrapChangePreview(root, changes);
  return changes;
}

async function applyBootstrapDraftFiles(root, result) {
  const changes = await collectBootstrapDraftChanges(root, result);
  for (const change of changes) {
    await ensureDir(path.dirname(change.target));
    await fsp.writeFile(change.target, change.nextText);
  }
  const lastResultFile = bootstrapLastResultPath(root);
  await ensureDir(path.dirname(lastResultFile));
  await fsp.writeFile(lastResultFile, `${JSON.stringify(result, null, 2)}\n`);
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
  normalizeMarkdownDraft,
  summarizeBootstrapDraftChanges,
  writeBootstrapChangePreview,
  clearBootstrapDraftArtifacts,
  collectBootstrapDraftChanges,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
};
