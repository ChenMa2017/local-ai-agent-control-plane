"use strict";

const fs = require("fs");
const fsp = fs.promises;
const { createBootstrapDraftLatestResult } = require("./bootstrapLatestResult");

function createBootstrapInstantiationFlow({
  vscode,
  projectSetupHelpers,
  bootstrapCodexRunner,
  bootstrapLastResultPath,
  bootstrapChangePreviewPath,
  ensureCodexHome,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  updateControlPanel,
  confirmLoginIfNeeded,
  applyBootstrapDraftFiles,
  readBootstrapConversation,
  writeBootstrapConversation,
  openDocument
}) {
  async function ensureBootstrapInstantiationDraft(root) {
    if (bootstrapCodexRunner.bootstrapDraftExists(root) && fs.existsSync(bootstrapChangePreviewPath(root))) {
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
        const parsed = await bootstrapCodexRunner.buildBootstrapInstantiationDraft(root);
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
    conversation.latest_result = createBootstrapDraftLatestResult(result, appliedAt);
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
    ensureBootstrapInstantiationDraft,
    instantiateBootstrapProjectCommand,
    openBootstrapChangePreviewCommand
  };
}

module.exports = {
  createBootstrapInstantiationFlow
};
