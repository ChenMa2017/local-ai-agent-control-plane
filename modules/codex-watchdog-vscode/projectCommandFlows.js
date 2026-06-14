"use strict";

const { createBootstrapConversationFlow } = require("./bootstrapConversationFlow");

function createProjectCommandFlows({
  vscode,
  ensureCodexHome,
  confirmLoginIfNeeded,
  getBootstrapScaffoldingHelpers,
  getGeneratedFilesHelpers,
  getProjectSetupHelpers,
  getBootstrapWorkflowHelpers,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  setPanelOperationState,
  clearPanelOperationState,
  updateControlPanel,
  openDocument,
  path
}) {
  const bootstrapConversationFlow = createBootstrapConversationFlow({
    vscode,
    ensureCodexHome,
    confirmLoginIfNeeded,
    getProjectSetupHelpers,
    getBootstrapWorkflowHelpers,
    writeBootstrapRuntimeState,
    emptyBootstrapRuntimeState,
    updateControlPanel
  });

  async function prepareProject(root) {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Preparing Codex Watchdog project template",
      cancellable: false
    }, async () => {
      const startedAt = new Date().toISOString();
      try {
        await setPanelOperationState({
          title: "Preparing project",
          detail: "Creating or refreshing the watchdog project template files...",
          startedAt
        });
        await getProjectSetupHelpers().prepareProjectForInstantiation(root);
        await setPanelOperationState({
          title: "Preparing project",
          detail: "Opening the setup files so you can review the initial handoff documents...",
          startedAt
        });
        await getProjectSetupHelpers().openInstantiationFiles(root);
        vscode.window.showInformationMessage("Codex Watchdog project template is ready. Continue the setup in the Bootstrap Conversation section before starting the guard.");
      } finally {
        await clearPanelOperationState();
      }
    });
  }

  async function generateBootstrapConversation(root, rawText) {
    return bootstrapConversationFlow.generateBootstrapConversation(root, rawText);
  }

  async function refreshGeneratedFiles(root) {
    const answer = await vscode.window.showWarningMessage(
      "Refresh generated watcher files? This overwrites README.codex-watchdog.md, agent/CODEX_TAKEOVER.md, agent/SKILL_ROUTER.md, agent/skills/, agent/bin scripts, the wakeup prompt, and the JSON schema, but leaves TASK_REQUEST, PLAN, STATE, TODO, SAFETY, DAILY_HANDOFF, and AGENTS.md untouched.",
      { modal: true },
      "Refresh"
    );
    if (answer !== "Refresh") {
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Refreshing Codex Watchdog generated files",
      cancellable: false
    }, async () => {
      const startedAt = new Date().toISOString();
      try {
        await setPanelOperationState({
          title: "Refreshing generated files",
          detail: "Rebuilding watchdog scripts, skills, prompts, and schema files...",
          startedAt
        });
        await getGeneratedFilesHelpers().ensureGeneratedDirs(root);
        await getGeneratedFilesHelpers().refreshGeneratedWatcherFiles(root);
        vscode.window.showInformationMessage("Codex Watchdog generated files refreshed.");
      } finally {
        await clearPanelOperationState();
      }
    });
  }

  async function prepareEveningHandoff(root) {
    const startedAt = new Date().toISOString();
    try {
      await setPanelOperationState({
        title: "Preparing evening handoff",
        detail: "Refreshing project bootstrap files and preparing DAILY_HANDOFF for tonight...",
        startedAt
      });
      await getBootstrapScaffoldingHelpers().bootstrapProject(root);
      await getGeneratedFilesHelpers().ensureHandoffFiles(root);
      await setPanelOperationState({
        title: "Preparing evening handoff",
        detail: "Opening DAILY_HANDOFF so you can review it before unattended mode...",
        startedAt
      });
      await openDocument(path.join(root, "agent", "DAILY_HANDOFF.md"), false);
      vscode.window.showInformationMessage("Evening handoff is ready. Update DAILY_HANDOFF, PLAN, TODO, STATE, and SAFETY before starting the timer.");
    } finally {
      await clearPanelOperationState();
    }
  }

  return {
    prepareProject,
    generateBootstrapConversation,
    refreshGeneratedFiles,
    prepareEveningHandoff
  };
}

module.exports = {
  createProjectCommandFlows
};
