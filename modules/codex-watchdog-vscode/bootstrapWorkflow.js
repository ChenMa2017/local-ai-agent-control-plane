"use strict";

const fs = require("fs");
const fsp = fs.promises;

function createBootstrapWorkflowHelpers({
  vscode,
  projectSetupHelpers,
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
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  openDocument,
  bootstrapConversationMarkdownPath,
  bootstrapChangePreviewPath,
  ensureCodexHome,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  updateControlPanel,
  confirmLoginIfNeeded
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

  async function ensureBootstrapInstantiationDraft(root) {
    if (fs.existsSync(bootstrapLastResultPath(root)) && fs.existsSync(bootstrapChangePreviewPath(root))) {
      return JSON.parse(await fsp.readFile(bootstrapLastResultPath(root), "utf8"));
    }
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Building watchdog setup candidate",
      cancellable: false
    }, async () => {
      const startedAt = new Date().toISOString();
      await projectSetupHelpers.ensureBootstrapConversationReady(root);
      await ensureCodexHome(root);
      await writeBootstrapRuntimeState(root, {
        status: "running",
        detail: "Codex is turning the discussion transcript into a concrete candidate setup draft...",
        started_at: startedAt,
        updated_at: new Date().toISOString(),
        completed_at: "",
        error: ""
      });
      await updateControlPanel();
      const canContinue = await confirmLoginIfNeeded(root);
      if (!canContinue) {
        await writeBootstrapRuntimeState(root, emptyBootstrapRuntimeState());
        await updateControlPanel();
        return null;
      }
      try {
        const parsed = await buildBootstrapInstantiationDraft(root);
        await writeBootstrapRuntimeState(root, {
          status: "idle",
          detail: "",
          started_at: "",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error: ""
        });
        return parsed;
      } catch (error) {
        await writeBootstrapRuntimeState(root, {
          status: "error",
          detail: "Bootstrap instantiation draft failed.",
          started_at: "",
          updated_at: new Date().toISOString(),
          completed_at: "",
          error: error && error.message ? error.message : String(error)
        });
        throw error;
      } finally {
        await updateControlPanel();
      }
    });
  }

  async function instantiateBootstrapProjectCommand(root) {
    const result = await ensureBootstrapInstantiationDraft(root);
    if (!result) {
      return;
    }
    const changes = await applyBootstrapDraftFiles(root, result);
    const conversation = await readBootstrapConversation(root);
    const appliedAt = new Date().toISOString();
    conversation.updated_at = appliedAt;
    conversation.latest_result = {
      ready_for_start_guard: Boolean(result.ready_for_start_guard),
      open_questions: Array.isArray(result.open_questions) ? result.open_questions.map((item) => String(item || "").trim()).filter(Boolean) : [],
      suggested_next_step: String(result.suggested_next_step || ""),
      has_draft: true,
      applied_at: appliedAt
    };
    await writeBootstrapConversation(root, conversation);

    const changedCount = changes.filter((change) => change.changed).length;
    if (changedCount === 0) {
      vscode.window.showInformationMessage(projectSetupHelpers.taskLooksInstantiated(root)
        ? "Instantiate Project finished. The latest draft already matches the current setup files, and Start Guard is now available."
        : "Instantiate Project finished. The latest draft already matches the current setup files.");
    } else {
      vscode.window.showInformationMessage(projectSetupHelpers.taskLooksInstantiated(root)
        ? `Instantiate Project applied the latest draft to ${changedCount} setup file${changedCount === 1 ? "" : "s"}. Start Guard is now available.`
        : `Instantiate Project applied the latest draft to ${changedCount} setup file${changedCount === 1 ? "" : "s"}. Review them, then Start Guard when ready.`);
    }
  }

  async function openBootstrapTranscriptCommand(root) {
    const file = bootstrapConversationMarkdownPath(root);
    if (!fs.existsSync(file)) {
      vscode.window.showWarningMessage("No bootstrap conversation transcript exists yet. Generate drafts first.");
      return;
    }
    await openDocument(file, false);
  }

  async function openBootstrapChangePreviewCommand(root) {
    const draft = await ensureBootstrapInstantiationDraft(root);
    if (!draft) {
      return;
    }
    const file = bootstrapChangePreviewPath(root);
    if (!fs.existsSync(file)) {
      vscode.window.showWarningMessage("No bootstrap change preview exists yet. Generate drafts first.");
      return;
    }
    await openDocument(file, false);
  }

  return {
    runBootstrapConversationTurn,
    buildBootstrapInstantiationDraft,
    ensureBootstrapInstantiationDraft,
    instantiateBootstrapProjectCommand,
    openBootstrapTranscriptCommand,
    openBootstrapChangePreviewCommand
  };
}

module.exports = {
  createBootstrapWorkflowHelpers
};
