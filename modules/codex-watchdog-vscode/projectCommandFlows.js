"use strict";

const { createBootstrapConversationFlow } = require("./bootstrapConversationFlow");
const { createProjectFlowOperationRunner } = require("./projectFlowOperationRunner");

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
  const operationRunner = createProjectFlowOperationRunner({
    vscode,
    setPanelOperationState,
    clearPanelOperationState
  });

  async function prepareProject(root) {
    await operationRunner.runProgressOperation({
      notificationTitle: "Preparing Codex Watchdog project template",
      panelTitle: "Preparing project",
      initialDetail: "Creating or refreshing the watchdog project template files...",
      run: async ({ updateDetail }) => {
        await getProjectSetupHelpers().prepareProjectForInstantiation(root);
        await updateDetail("Opening the setup files so you can review the initial handoff documents...");
        await getProjectSetupHelpers().openInstantiationFiles(root);
        vscode.window.showInformationMessage("Codex Watchdog project template is ready. Continue the setup in the Bootstrap Conversation section before starting the guard.");
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

    await operationRunner.runProgressOperation({
      notificationTitle: "Refreshing Codex Watchdog generated files",
      panelTitle: "Refreshing generated files",
      initialDetail: "Rebuilding watchdog scripts, skills, prompts, and schema files...",
      run: async () => {
        await getGeneratedFilesHelpers().ensureGeneratedDirs(root);
        await getGeneratedFilesHelpers().refreshGeneratedWatcherFiles(root);
        vscode.window.showInformationMessage("Codex Watchdog generated files refreshed.");
      }
    });
  }

  async function prepareEveningHandoff(root) {
    await operationRunner.runPanelOperation({
      panelTitle: "Preparing evening handoff",
      initialDetail: "Refreshing project bootstrap files and preparing DAILY_HANDOFF for tonight...",
      run: async ({ updateDetail }) => {
      await getBootstrapScaffoldingHelpers().bootstrapProject(root);
      await getGeneratedFilesHelpers().ensureHandoffFiles(root);
      await updateDetail("Opening DAILY_HANDOFF so you can review it before unattended mode...");
      await openDocument(path.join(root, "agent", "DAILY_HANDOFF.md"), false);
      vscode.window.showInformationMessage("Evening handoff is ready. Update DAILY_HANDOFF, PLAN, TODO, STATE, and SAFETY before starting the timer.");
      }
    });
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
