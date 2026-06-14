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
const {
  ensureDir,
  normalizeMarkdownDraft,
  writeBootstrapChangePreview
} = require("./bootstrapDraftPreview");

function getBootstrapDraftMapping(result) {
  return [
    ["agent/PLAN.md", result.plan_md],
    ["agent/TODO.md", result.todo_md],
    ["agent/STATE.md", result.state_md],
    ["agent/SAFETY.md", result.safety_md],
    ["agent/DAILY_HANDOFF.md", result.daily_handoff_md]
  ];
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
  const changes = [];
  for (const [relativePath, content] of getBootstrapDraftMapping(result)) {
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

async function writeBootstrapLastResult(root, result) {
  const lastResultFile = bootstrapLastResultPath(root);
  await ensureDir(path.dirname(lastResultFile));
  await fsp.writeFile(lastResultFile, `${JSON.stringify(result, null, 2)}\n`);
  return lastResultFile;
}

async function stageBootstrapDraftFiles(root, result) {
  const changes = await collectBootstrapDraftChanges(root, result);
  await writeBootstrapLastResult(root, result);
  await writeBootstrapChangePreview(root, changes);
  return changes;
}

async function applyBootstrapDraftFiles(root, result) {
  const changes = await collectBootstrapDraftChanges(root, result);
  for (const change of changes) {
    await ensureDir(path.dirname(change.target));
    await fsp.writeFile(change.target, change.nextText);
  }
  await writeBootstrapLastResult(root, result);
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
  clearBootstrapDraftArtifacts,
  collectBootstrapDraftChanges,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
};
