"use strict";

const { createProjectCommandFlows } = require("./projectCommandFlows");

function createProjectCommands({
  vscode,
  fs,
  fsp,
  path,
  getProjectRoot,
  selectProjectRoot,
  rememberProjectRoot,
  ensureCodexHome,
  confirmLoginIfNeeded,
  effectiveWatchdogSettings,
  positiveNumberSetting,
  extensionSetting,
  defaultTimeoutMinutes,
  getBootstrapScaffoldingHelpers,
  getGeneratedFilesHelpers,
  getProjectSetupHelpers,
  getBootstrapWorkflowHelpers,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  setPanelOperationState,
  clearPanelOperationState,
  updateControlPanel,
  openDocument
}) {
  const projectCommandFlows = createProjectCommandFlows({
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
  });

  async function selectProjectRootCommand() {
    const root = await selectProjectRoot("Enter the project folder Codex Watchdog should control");
    if (!root) {
      return;
    }
    await rememberProjectRoot(root);
    await showProjectRootSelected(root);
  }

  async function bootstrapProjectCommand() {
    const root = await selectProjectRoot("Enter the project folder for Codex Watchdog bootstrap");
    if (!root) {
      return;
    }
    await rememberProjectRoot(root);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Bootstrapping Codex Watchdog",
      cancellable: false
    }, async () => {
      const result = await getBootstrapScaffoldingHelpers().bootstrapProject(root);
      getBootstrapScaffoldingHelpers().showBootstrapResult(result);
    });
  }

  async function createDemoProjectTemplateCommand() {
    const root = await selectProjectRoot("Enter or create the folder that should receive the Codex Watchdog demo template");
    if (!root) {
      return;
    }
    await rememberProjectRoot(root);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Creating Codex Watchdog demo template",
      cancellable: false
    }, async () => {
      const result = await getBootstrapScaffoldingHelpers().createDemoProjectTemplate(root);
      getBootstrapScaffoldingHelpers().showBootstrapResult(result);
      vscode.window.showInformationMessage("Codex Watchdog demo template is ready and selected as the project root. You can now run Codex Watchdog: Run Once Now from any workspace.");
    });
  }

  async function prepareProjectCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await projectCommandFlows.prepareProject(root);
  }

  async function generateBootstrapConversationCommand(rawText) {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await projectCommandFlows.generateBootstrapConversation(root, rawText);
  }

  async function refreshGeneratedFilesCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await projectCommandFlows.refreshGeneratedFiles(root);
  }

  async function prepareEveningHandoffCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await projectCommandFlows.prepareEveningHandoff(root);
  }

  async function openMorningBriefCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const files = [
      path.join(root, "agent", "MORNING_BRIEF.md"),
      path.join(root, "agent", "reports", "latest.md"),
      path.join(root, "agent", "RUNTIME_STATE.md")
    ].filter((file) => fs.existsSync(file));

    if (files.length === 0) {
      vscode.window.showWarningMessage("No morning brief or watchdog reports exist yet. Run Codex Watchdog once first.");
      return;
    }

    for (const file of files) {
      await openDocument(file, false);
    }
  }

  async function acceptStateUpdateCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const proposed = path.join(root, "agent", "STATE.proposed.md");
    const state = path.join(root, "agent", "STATE.md");
    if (!fs.existsSync(proposed)) {
      vscode.window.showWarningMessage("No proposed state update exists.");
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      "Replace agent/STATE.md with agent/STATE.proposed.md?",
      { modal: true },
      "Accept"
    );
    if (answer !== "Accept") {
      return;
    }
    const data = await fsp.readFile(proposed);
    await fsp.writeFile(state, data);
    vscode.window.showInformationMessage("Accepted proposed Codex Watchdog state update.");
  }

  async function showProjectRootSelected(root) {
    await getBootstrapScaffoldingHelpers().showProjectRootSelected(root);
  }

  async function offerProjectInitialization(root) {
    await getBootstrapScaffoldingHelpers().offerProjectInitialization(root);
  }

  function isGuardPaused(root) {
    return fs.existsSync(path.join(root, "agent", "control", "PAUSE"));
  }

  async function watchdogCommandEnv(root) {
    const settings = await effectiveWatchdogSettings(root);
    return {
      CODEX_BIN: settings.codexBin,
      CODEX_HOME: settings.codexHome,
      CODEX_SANDBOX_MODE: settings.sandboxMode,
      WATCHDOG_INTERVAL_MINUTES: String(settings.intervalMinutes),
      WATCHDOG_TIMEOUT_MINUTES: String(settings.timeoutMinutes),
      WATCHDOG_COMPACT_EVERY_RUNS: String(settings.compactEveryRuns),
      WATCHDOG_ROLE: settings.role,
      WATCHDOG_PHASE_OFFSET_MINUTES: String(settings.phaseOffsetMinutes),
      WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP: settings.supervisorLightFollowup ? "1" : "0",
      WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS: String(settings.supervisorAuditEveryRunnerRuns),
      WATCHDOG_SERVICE_PREFIX: settings.servicePrefix,
      CUDA_VISIBLE_DEVICES: ""
    };
  }

  function watchdogCommandTimeoutMs(root) {
    const timeout = positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", defaultTimeoutMinutes), 1, defaultTimeoutMinutes);
    return (timeout + 5) * 60 * 1000;
  }

  return {
    selectProjectRootCommand,
    bootstrapProjectCommand,
    createDemoProjectTemplateCommand,
    prepareProjectCommand,
    generateBootstrapConversationCommand,
    refreshGeneratedFilesCommand,
    prepareEveningHandoffCommand,
    openMorningBriefCommand,
    acceptStateUpdateCommand,
    showProjectRootSelected,
    offerProjectInitialization,
    isGuardPaused,
    watchdogCommandEnv,
    watchdogCommandTimeoutMs
  };
}

module.exports = {
  createProjectCommands
};
