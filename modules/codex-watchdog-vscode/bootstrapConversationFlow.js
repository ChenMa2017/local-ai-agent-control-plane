"use strict";

function createBootstrapConversationFlow({
  vscode,
  ensureCodexHome,
  confirmLoginIfNeeded,
  getProjectSetupHelpers,
  getBootstrapWorkflowHelpers,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  updateControlPanel
}) {
  async function setBootstrapRuntimeState(root, userText, startedAt, overrides) {
    await writeBootstrapRuntimeState(root, {
      status: "running",
      detail: "",
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      completed_at: "",
      error: "",
      pending_input: userText,
      ...overrides
    });
    await updateControlPanel();
  }

  async function generateBootstrapConversation(root, rawText) {
    const userText = String(rawText || "").trim();
    if (!userText) {
      throw new Error("Enter a bootstrap request before generating drafts.");
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Generating bootstrap drafts in Codex Watchdog",
      cancellable: false
    }, async (progress) => {
      const startedAt = new Date().toISOString();
      try {
        await setBootstrapRuntimeState(root, userText, startedAt, {
          detail: "Preparing the project scaffold and the bootstrap conversation..."
        });

        progress.report({ message: "Preparing project scaffold" });
        await getProjectSetupHelpers().ensureBootstrapConversationReady(root);
        await setBootstrapRuntimeState(root, userText, startedAt, {
          detail: "Preparing the project scaffold and the bootstrap conversation..."
        });

        progress.report({ message: "Checking Codex login" });
        await ensureCodexHome(root);
        await setBootstrapRuntimeState(root, userText, startedAt, {
          detail: "Checking login and starting a fresh Codex discussion turn. This is still slower than ordinary chat because the panel launches a separate codex exec and keeps the conversation/project state in sync."
        });

        const canContinue = await confirmLoginIfNeeded(root);
        if (!canContinue) {
          await writeBootstrapRuntimeState(root, {
            ...emptyBootstrapRuntimeState(),
            pending_input: userText
          });
          await updateControlPanel();
          return;
        }

        progress.report({ message: "Running Codex setup conversation" });
        await setBootstrapRuntimeState(root, userText, startedAt, {
          detail: "Codex is answering your setup question and updating the shared bootstrap conversation..."
        });
        const result = await getBootstrapWorkflowHelpers().runBootstrapConversationTurn(root, userText);
        await writeBootstrapRuntimeState(root, {
          status: "idle",
          detail: "",
          started_at: "",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error: "",
          pending_input: ""
        });
        const nextStep = String(result.suggested_next_step || "").trim()
          || "AI replied. Continue the setup conversation, or use Preview Changed Files / Instantiate Project when the goal feels clear.";
        vscode.window.showInformationMessage(nextStep);
      } catch (error) {
        await writeBootstrapRuntimeState(root, {
          status: "error",
          detail: "Bootstrap drafting failed.",
          started_at: "",
          updated_at: new Date().toISOString(),
          completed_at: "",
          error: error && error.message ? error.message : String(error),
          pending_input: userText
        });
        throw error;
      } finally {
        await updateControlPanel();
      }
    });
  }

  return {
    generateBootstrapConversation
  };
}

module.exports = {
  createBootstrapConversationFlow
};
