"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const {
  bootstrapChangePreviewPath
} = require("./bootstrapConversationPaths");

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

module.exports = {
  ensureDir,
  normalizeMarkdownDraft,
  summarizeBootstrapDraftChanges,
  writeBootstrapChangePreview
};
