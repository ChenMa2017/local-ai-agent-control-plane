"use strict";

const fs = require("fs");
const fsp = fs.promises;

function createBootstrapCodexRunner({
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
}) {
  async function runBootstrapConversationTurn(root, userText) {
    const codexBin = await resolveCodexBin(root);
    const codexHome = codexHomeSetting(root);
    const conversation = await readBootstrapConversation(root);
    const userTurn = {
      id: createNonce(),
      role: "user",
      text: userText,
      created_at: new Date().toISOString()
    };
    conversation.draft_input = userText;
    conversation.turns.push(userTurn);
    conversation.updated_at = userTurn.created_at;
    await writeBootstrapConversation(root, conversation);
    await clearBootstrapDraftArtifacts(root);

    const resultFile = bootstrapLastResultPath(root);
    const prompt = bootstrapConversationPromptText(root, conversation);
    const args = [
      "--ask-for-approval", "never",
      "exec",
      "--cd", root,
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--output-schema", bootstrapConversationTurnSchemaPath(root),
      "--output-last-message", resultFile,
      "-"
    ];
    await runLoggedWithInput(codexBin, args, prompt, {
      cwd: root,
      env: {
        CODEX_HOME: codexHome,
        CUDA_VISIBLE_DEVICES: ""
      },
      timeout: watchdogCommandTimeoutMs(root)
    });

    const parsed = JSON.parse(await fsp.readFile(resultFile, "utf8"));
    await clearBootstrapDraftArtifacts(root);

    conversation.turns.push({
      id: createNonce(),
      role: "assistant",
      text: String(parsed.assistant_reply || "").trim(),
      created_at: new Date().toISOString()
    });
    conversation.draft_input = "";
    conversation.updated_at = new Date().toISOString();
    conversation.latest_result = {
      ready_for_start_guard: false,
      open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions.map((item) => String(item || "").trim()).filter(Boolean) : [],
      suggested_next_step: String(parsed.suggested_next_step || ""),
      has_draft: false,
      applied_at: ""
    };
    await writeBootstrapConversation(root, conversation);
    return parsed;
  }

  async function buildBootstrapInstantiationDraft(root) {
    const codexBin = await resolveCodexBin(root);
    const codexHome = codexHomeSetting(root);
    const conversation = await readBootstrapConversation(root);
    const resultFile = bootstrapLastResultPath(root);
    const prompt = bootstrapInstantiationPromptText(root, conversation);
    const args = [
      "--ask-for-approval", "never",
      "exec",
      "--cd", root,
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--output-schema", bootstrapResultSchemaPath(root),
      "--output-last-message", resultFile,
      "-"
    ];
    await runLoggedWithInput(codexBin, args, prompt, {
      cwd: root,
      env: {
        CODEX_HOME: codexHome,
        CUDA_VISIBLE_DEVICES: ""
      },
      timeout: watchdogCommandTimeoutMs(root)
    });
    const parsed = JSON.parse(await fsp.readFile(resultFile, "utf8"));
    await stageBootstrapDraftFiles(root, parsed);
    const latestConversation = await readBootstrapConversation(root);
    latestConversation.updated_at = new Date().toISOString();
    latestConversation.latest_result = {
      ready_for_start_guard: Boolean(parsed.ready_for_start_guard),
      open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions.map((item) => String(item || "").trim()).filter(Boolean) : [],
      suggested_next_step: String(parsed.suggested_next_step || ""),
      has_draft: true,
      applied_at: ""
    };
    await writeBootstrapConversation(root, latestConversation);
    return parsed;
  }

  function bootstrapDraftExists(root) {
    return fs.existsSync(bootstrapLastResultPath(root));
  }

  return {
    runBootstrapConversationTurn,
    buildBootstrapInstantiationDraft,
    bootstrapDraftExists
  };
}

module.exports = {
  createBootstrapCodexRunner
};
