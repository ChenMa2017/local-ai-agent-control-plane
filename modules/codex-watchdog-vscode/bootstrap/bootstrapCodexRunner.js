"use strict";

const fs = require("fs");
const { runBootstrapCodexJsonCall } = require("./bootstrapCodexExec");
const {
  createBootstrapDiscussionLatestResult,
  createBootstrapDraftLatestResult
} = require("./bootstrapLatestResult");

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
    const parsed = await runBootstrapCodexJsonCall({
      root,
      codexBin,
      codexHome,
      schemaPath: bootstrapConversationTurnSchemaPath(root),
      resultFile,
      prompt,
      runLoggedWithInput,
      watchdogCommandTimeoutMs
    });
    await clearBootstrapDraftArtifacts(root);

    conversation.turns.push({
      id: createNonce(),
      role: "assistant",
      text: String(parsed.assistant_reply || "").trim(),
      created_at: new Date().toISOString()
    });
    conversation.draft_input = "";
    conversation.updated_at = new Date().toISOString();
    conversation.latest_result = createBootstrapDiscussionLatestResult(parsed);
    await writeBootstrapConversation(root, conversation);
    return parsed;
  }

  async function buildBootstrapInstantiationDraft(root) {
    const codexBin = await resolveCodexBin(root);
    const codexHome = codexHomeSetting(root);
    const conversation = await readBootstrapConversation(root);
    const resultFile = bootstrapLastResultPath(root);
    const prompt = bootstrapInstantiationPromptText(root, conversation);
    const parsed = await runBootstrapCodexJsonCall({
      root,
      codexBin,
      codexHome,
      schemaPath: bootstrapResultSchemaPath(root),
      resultFile,
      prompt,
      runLoggedWithInput,
      watchdogCommandTimeoutMs
    });
    await stageBootstrapDraftFiles(root, parsed);
    const latestConversation = await readBootstrapConversation(root);
    latestConversation.updated_at = new Date().toISOString();
    latestConversation.latest_result = createBootstrapDraftLatestResult(parsed);
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
