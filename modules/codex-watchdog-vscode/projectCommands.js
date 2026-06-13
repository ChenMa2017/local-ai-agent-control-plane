"use strict";

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

  async function generateBootstrapConversationCommand(rawText) {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
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
        await writeBootstrapRuntimeState(root, {
          status: "running",
          detail: "Preparing the project scaffold and the bootstrap conversation...",
          started_at: startedAt,
          updated_at: new Date().toISOString(),
          completed_at: "",
          error: "",
          pending_input: userText
        });
        await updateControlPanel();

        progress.report({ message: "Preparing project scaffold" });
        await getProjectSetupHelpers().ensureBootstrapConversationReady(root);
        await writeBootstrapRuntimeState(root, {
          status: "running",
          detail: "Preparing the project scaffold and the bootstrap conversation...",
          started_at: startedAt,
          updated_at: new Date().toISOString(),
          completed_at: "",
          error: "",
          pending_input: userText
        });
        await updateControlPanel();

        progress.report({ message: "Checking Codex login" });
        await ensureCodexHome(root);
        await writeBootstrapRuntimeState(root, {
          status: "running",
          detail: "Checking login and starting a fresh Codex discussion turn. This is still slower than ordinary chat because the panel launches a separate codex exec and keeps the conversation/project state in sync.",
          started_at: startedAt,
          updated_at: new Date().toISOString(),
          completed_at: "",
          error: "",
          pending_input: userText
        });
        await updateControlPanel();
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
        await writeBootstrapRuntimeState(root, {
          status: "running",
          detail: "Codex is answering your setup question and updating the shared bootstrap conversation...",
          started_at: startedAt,
          updated_at: new Date().toISOString(),
          completed_at: "",
          error: "",
          pending_input: userText
        });
        await updateControlPanel();
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

  async function refreshGeneratedFilesCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
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

  async function prepareEveningHandoffCommand() {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
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
