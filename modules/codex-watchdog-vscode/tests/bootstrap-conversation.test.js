"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const bootstrapConversation = require("../bootstrapConversation");
const pathsApi = require("../bootstrapConversationPaths");
const storeApi = require("../bootstrapConversationStore");
const draftsApi = require("../bootstrapConversationDrafts");

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-bootstrap-conversation-"));

  assert.strictEqual(
    pathsApi.bootstrapConversationJsonPath(projectRoot),
    path.join(projectRoot, "agent", "status", "bootstrap_conversation.json")
  );
  assert.strictEqual(
    pathsApi.bootstrapConversationMarkdownPath(projectRoot),
    path.join(projectRoot, "agent", "status", "bootstrap_conversation.md")
  );

  const emptyConversation = pathsApi.emptyBootstrapConversation(projectRoot);
  assert.strictEqual(emptyConversation.project_root, projectRoot);
  assert.deepStrictEqual(emptyConversation.turns, []);
  assert.strictEqual(emptyConversation.latest_result.has_draft, false);
  assert.strictEqual(pathsApi.emptyBootstrapRuntimeState().status, "idle");

  const draftResult = {
    assistant_reply: "我们先把项目目标说清楚。",
    suggested_next_step: "继续讨论，再预览候选方案。",
    ready_for_start_guard: false,
    open_questions: ["这个项目是否需要联网研究？"],
    plan_md: "# PLAN\n\n第一轮只读检查当前目录结构。\n",
    todo_md: "# TODO\n\n- [ ] 整理项目目标\n",
    state_md: "# STATE\n\n当前项目仍在 bootstrap 阶段。\n",
    safety_md: "# SAFETY\n\n默认只读，不启动 guard。\n",
    daily_handoff_md: "# DAILY HANDOFF\n\n下一步继续讨论 watchdog 目标。\n"
  };

  const stagedChanges = await draftsApi.stageBootstrapDraftFiles(projectRoot, draftResult);
  assert.strictEqual(stagedChanges.length, 5);
  assert.ok(fs.existsSync(pathsApi.bootstrapLastResultPath(projectRoot)));
  assert.ok(fs.existsSync(pathsApi.bootstrapChangePreviewPath(projectRoot)));
  const previewText = fs.readFileSync(pathsApi.bootstrapChangePreviewPath(projectRoot), "utf8");
  assert.match(previewText, /Bootstrap Change Preview/);
  assert.match(previewText, /agent\/PLAN\.md/);

  const appliedChanges = await draftsApi.applyBootstrapDraftFiles(projectRoot, draftResult);
  assert.strictEqual(appliedChanges.filter((item) => item.changed).length, 5);
  assert.match(fs.readFileSync(path.join(projectRoot, "agent", "PLAN.md"), "utf8"), /第一轮只读检查当前目录结构/);

  const conversation = await storeApi.writeBootstrapConversation(projectRoot, {
    updated_at: "2026-06-13T10:00:00Z",
    draft_input: "先不要启动 guard。",
    turns: [
      {
        id: "turn-user",
        role: "user",
        text: "请先只读检查项目结构。",
        created_at: "2026-06-13T09:58:00Z"
      },
      {
        id: "turn-assistant",
        role: "assistant",
        text: "好的，我们先把 bootstrap 方案定清楚。",
        created_at: "2026-06-13T09:59:00Z"
      }
    ],
    latest_result: {
      ready_for_start_guard: false,
      open_questions: ["是否允许 guard 后续写研究笔记？"],
      suggested_next_step: "先预览候选文件，再决定是否实例化。",
      has_draft: true,
      applied_at: ""
    }
  });
  assert.strictEqual(conversation.turns.length, 2);
  assert.ok(fs.existsSync(pathsApi.bootstrapConversationJsonPath(projectRoot)));
  assert.ok(fs.existsSync(pathsApi.bootstrapConversationMarkdownPath(projectRoot)));
  const markdown = fs.readFileSync(pathsApi.bootstrapConversationMarkdownPath(projectRoot), "utf8");
  assert.match(markdown, /## User request/);
  assert.match(markdown, /## AI reply/);

  const reloadedConversation = await storeApi.readBootstrapConversation(projectRoot);
  assert.strictEqual(reloadedConversation.turns.length, 2);
  assert.strictEqual(reloadedConversation.latest_result.has_draft, true);

  await storeApi.writeBootstrapRuntimeState(projectRoot, {
    status: "running",
    detail: "Codex is answering your setup question...",
    started_at: "2026-06-13T10:01:00Z",
    pending_input: "我想先做一个安全的研究型 watchdog。"
  });

  const runningState = await storeApi.getBootstrapConversationState(projectRoot);
  assert.strictEqual(runningState.isRunning, true);
  assert.match(runningState.statusText, /Waiting for AI reply/);
  assert.strictEqual(runningState.draftText, "我想先做一个安全的研究型 watchdog。");

  await storeApi.writeBootstrapRuntimeState(projectRoot, {
    status: "idle",
    detail: "",
    completed_at: "2026-06-13T10:03:00Z",
    pending_input: ""
  });
  await storeApi.writeBootstrapConversation(projectRoot, {
    ...reloadedConversation,
    latest_result: {
      ready_for_start_guard: true,
      open_questions: [],
      suggested_next_step: "检查候选文件，没有问题就可以启动 guard。",
      has_draft: true,
      applied_at: "2026-06-13T10:04:00Z"
    }
  });

  const appliedState = await bootstrapConversation.getBootstrapConversationState(projectRoot);
  assert.strictEqual(appliedState.hasAppliedDraft, true);
  assert.strictEqual(appliedState.readyForStartGuard, true);
  assert.match(appliedState.statusText, /Start Guard/);

  const prompt = bootstrapConversation.bootstrapConversationPromptText(projectRoot, reloadedConversation);
  assert.match(prompt, /discussion, not full file instantiation/);
  const instantiationPrompt = bootstrapConversation.bootstrapInstantiationPromptText(projectRoot, reloadedConversation);
  assert.match(instantiationPrompt, /Return JSON matching the provided schema/);

  writeFile(projectRoot, "agent/status/extra.txt", "keep me\n");
  await draftsApi.archiveAndResetBootstrapConversation(projectRoot);
  const resetConversation = await storeApi.readBootstrapConversation(projectRoot);
  const resetRuntime = await storeApi.readBootstrapRuntimeState(projectRoot);
  assert.deepStrictEqual(resetConversation.turns, []);
  assert.strictEqual(resetConversation.latest_result.has_draft, false);
  assert.strictEqual(resetRuntime.status, "idle");
  const archiveEntries = fs.readdirSync(pathsApi.bootstrapArchiveDir(projectRoot));
  assert(archiveEntries.some((name) => name.endsWith("bootstrap_conversation.json")));
  assert(archiveEntries.some((name) => name.endsWith("bootstrap_change_preview.md")));

  await draftsApi.clearBootstrapDraftArtifacts(projectRoot);
  assert.strictEqual(fs.existsSync(pathsApi.bootstrapLastResultPath(projectRoot)), false);
  assert.strictEqual(fs.existsSync(pathsApi.bootstrapChangePreviewPath(projectRoot)), false);

  console.log("bootstrap-conversation test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
