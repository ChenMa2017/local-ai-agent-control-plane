"use strict";

const vscode = require("vscode");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");
const packageMetadata = require("./package.json");
const { createGuardLifecycle } = require("./guardLifecycle");
const { createProjectSetupHelpers } = require("./projectSetup");
const {
  bootstrapArchiveDir,
  bootstrapChangePreviewPath,
  bootstrapConversationJsonPath,
  bootstrapConversationMarkdownPath,
  bootstrapConversationPromptText,
  bootstrapConversationTurnSchemaPath,
  bootstrapLastResultPath,
  bootstrapResultSchemaPath,
  bootstrapRuntimeStatePath,
  bootstrapInstantiationPromptText,
  emptyBootstrapConversation,
  emptyBootstrapRuntimeState,
  getBootstrapConversationState,
  readBootstrapConversation,
  readBootstrapRuntimeState,
  renderBootstrapConversationMarkdown,
  writeBootstrapConversation,
  writeBootstrapRuntimeState,
  writeBootstrapChangePreview,
  clearBootstrapDraftArtifacts,
  collectBootstrapDraftChanges,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  archiveAndResetBootstrapConversation
} = require("./bootstrapConversation");

let output;
let extensionContext;
let controlPanel;
let statusBarItem;
let statusBarRefresh;
let panelOperationState;
let guardCommands;
let projectSetupHelpers;

const PROJECT_ROOT_KEY = "projectRoot";
const STATUS_REFRESH_MS = 60000;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_TIMEOUT_MINUTES = 25;
const DEFAULT_COMPACT_EVERY_RUNS = 6;
const DEFAULT_PHASE_OFFSET_MINUTES = 10;
const DEFAULT_WATCHDOG_ROLE = "runner";
const DEFAULT_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS = 4;
const DEFAULT_SUPERVISOR_LIGHT_FOLLOWUP = true;
const DEFAULT_SERVICE_PREFIX = "codex-watchdog";
const LOGIN_READY_RE = /(?:logged\s+in|authenticated)/i;

function emptyPanelOperationState() {
  return {
    status: "idle",
    title: "",
    detail: "",
    startedAt: ""
  };
}

panelOperationState = emptyPanelOperationState();

function getProjectSetupHelpers() {
  if (!projectSetupHelpers) {
    projectSetupHelpers = createProjectSetupHelpers({
      vscode,
      ensureDir,
      bootstrapProject,
      showBootstrapResult,
      refreshGeneratedWatcherFiles,
      bootstrapResultSchemaPath,
      bootstrapConversationTurnSchemaPath,
      openDocument
    });
  }
  return projectSetupHelpers;
}

function taskLooksInstantiated(root) {
  return getProjectSetupHelpers().taskLooksInstantiated(root);
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel("Codex Watchdog");
  context.subscriptions.push(output);

  projectSetupHelpers = getProjectSetupHelpers();

  guardCommands = createGuardLifecycle({
    vscode,
    output,
    getProjectRoot,
    ensureDir,
    prepareProjectForGuard: projectSetupHelpers.prepareProjectForGuard,
    confirmTaskInstantiatedIfNeeded: projectSetupHelpers.confirmTaskInstantiatedIfNeeded,
    ensureCodexHome,
    confirmLoginIfNeeded,
    runLogged,
    watchdogCommandEnv,
    watchdogCommandTimeoutMs,
    setPanelOperationState,
    clearPanelOperationState,
    updateStatusBar,
    unitNames,
    getTimerStatus,
    openDocument
  });

  register(context, "codexWatchdog.openControlPanel", openControlPanelCommand);
  register(context, "codexWatchdog.selectProjectRoot", selectProjectRootCommand);
  register(context, "codexWatchdog.bootstrapProject", bootstrapProjectCommand);
  register(context, "codexWatchdog.createDemoProjectTemplate", createDemoProjectTemplateCommand);
  register(context, "codexWatchdog.prepareProject", prepareProjectCommand);
  register(context, "codexWatchdog.refreshGeneratedFiles", refreshGeneratedFilesCommand);
  register(context, "codexWatchdog.prepareEveningHandoff", prepareEveningHandoffCommand);
  register(context, "codexWatchdog.openMorningBrief", openMorningBriefCommand);
  register(context, "codexWatchdog.startGuard", guardCommands.startGuardCommand);
  register(context, "codexWatchdog.pauseGuard", guardCommands.pauseGuardCommand);
  register(context, "codexWatchdog.resumeGuard", guardCommands.resumeGuardCommand);
  register(context, "codexWatchdog.stopGuard", guardCommands.stopGuardCommand);
  register(context, "codexWatchdog.runOnce", guardCommands.runOnceCommand);
  register(context, "codexWatchdog.startTimer", guardCommands.startTimerCommand);
  register(context, "codexWatchdog.stopTimer", guardCommands.stopTimerCommand);
  register(context, "codexWatchdog.showTimerStatus", guardCommands.showTimerStatusCommand);
  register(context, "codexWatchdog.openLatestReport", guardCommands.openLatestReportCommand);
  register(context, "codexWatchdog.acceptStateUpdate", acceptStateUpdateCommand);

  initializeStatusBar(context);
}

function deactivate() {
  if (statusBarRefresh) {
    clearInterval(statusBarRefresh);
    statusBarRefresh = undefined;
  }
}

function register(context, command, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    try {
      await handler();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      output.appendLine(`[error] ${message}`);
      vscode.window.showErrorMessage(`Codex Watchdog: ${message}`);
    } finally {
      await updateStatusBar();
    }
  }));
}

function initializeStatusBar(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "codexWatchdog.openControlPanel";
  statusBarItem.name = "Codex Watchdog";
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  statusBarRefresh = setInterval(() => {
    updateStatusBar();
  }, STATUS_REFRESH_MS);
  context.subscriptions.push(new vscode.Disposable(() => {
    if (statusBarRefresh) {
      clearInterval(statusBarRefresh);
      statusBarRefresh = undefined;
    }
  }));

  updateStatusBar();
}

async function updateStatusBar() {
  if (!statusBarItem) {
    return;
  }

  const root = getKnownProjectRoot();
  if (!root) {
    statusBarItem.text = "$(circle-slash) Watchdog: No Project";
    statusBarItem.tooltip = "Codex Watchdog: select a project root";
    statusBarItem.backgroundColor = undefined;
    return;
  }

  if (!fs.existsSync(root)) {
    statusBarItem.text = "$(warning) Watchdog: Missing";
    statusBarItem.tooltip = `Codex Watchdog project root is missing:\n${root}`;
    statusBarItem.backgroundColor = undefined;
    return;
  }

  if (isGuardPaused(root)) {
    statusBarItem.text = "$(debug-pause) Watchdog: Paused";
    statusBarItem.tooltip = `Codex Watchdog is paused for:\n${root}`;
    statusBarItem.backgroundColor = undefined;
    return;
  }

  statusBarItem.text = "$(sync~spin) Watchdog: Checking";
  statusBarItem.tooltip = `Checking Codex Watchdog timer for:\n${root}`;

  try {
    const timer = await getTimerStatus(root);
    const projectName = path.basename(root) || root;
    if (timer.isActive) {
      statusBarItem.text = "$(watch) Watchdog: On";
    } else if (timer.isEnabled) {
      statusBarItem.text = "$(debug-pause) Watchdog: Enabled";
    } else {
      statusBarItem.text = "$(debug-stop) Watchdog: Off";
    }
    statusBarItem.tooltip = [
      `Project: ${projectName}`,
      root,
      "",
      timer.text
    ].join("\n");
    statusBarItem.backgroundColor = undefined;
  } catch (error) {
    statusBarItem.text = "$(warning) Watchdog: Unknown";
    statusBarItem.tooltip = `Could not read Codex Watchdog status:\n${error.message || String(error)}`;
    statusBarItem.backgroundColor = undefined;
  }
}

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
    const result = await bootstrapProject(root);
    showBootstrapResult(result);
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
    const result = await createDemoProjectTemplate(root);
    showBootstrapResult(result);
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
      await projectSetupHelpers.prepareProjectForInstantiation(root);
      await setPanelOperationState({
        title: "Preparing project",
        detail: "Opening the setup files so you can review the initial handoff documents...",
        startedAt
      });
      await projectSetupHelpers.openInstantiationFiles(root);
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
      await projectSetupHelpers.ensureBootstrapConversationReady(root);
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
      const result = await runBootstrapConversationTurn(root, userText);
      await writeBootstrapRuntimeState(root, {
        status: "idle",
        detail: "",
        started_at: "",
        updated_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        error: "",
        pending_input: ""
      });
      const nextStep = String(result.suggested_next_step || "").trim() ||
        "AI replied. Continue the setup conversation, or use Preview Changed Files / Instantiate Project when the goal feels clear.";
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

async function offerProjectInitialization(root) {
  if (isWatchdogInitialized(root)) {
    const createdReadme = await ensureWatchdogReadme(root);
    const suffix = createdReadme ? " Created README.codex-watchdog.md." : "";
    vscode.window.showInformationMessage(`Codex Watchdog project root set to: ${root}.${suffix}`);
    return;
  }

  const empty = await isEffectivelyEmptyDir(root);
  const message = empty
    ? `Selected folder is empty. Prepare a Codex Watchdog project template here?\n${root}`
    : `Selected folder has no Codex Watchdog agent/ template yet. Initialize it?\n${root}`;
  const answer = await vscode.window.showInformationMessage(
    message,
    "Prepare Project",
    "Create Demo Template",
    "Select Only"
  );

  if (answer === "Prepare Project") {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Preparing Codex Watchdog project template",
      cancellable: false
    }, async () => {
      await projectSetupHelpers.prepareProjectForInstantiation(root);
      await projectSetupHelpers.openInstantiationFiles(root);
    });
    vscode.window.showInformationMessage("Project template prepared. Continue in the Bootstrap Conversation section to instantiate PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF, then Start Guard when ready.");
    return;
  }

  if (answer === "Create Demo Template") {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Creating Codex Watchdog demo template",
      cancellable: false
    }, async () => {
      const result = await createDemoProjectTemplate(root);
      showBootstrapResult(result);
    });
    vscode.window.showInformationMessage("Demo template created. Run Codex Watchdog: Run Once Now to instantiate the watchdog cycle.");
    return;
  }

  vscode.window.showInformationMessage(`Codex Watchdog project root set to: ${root}`);
}

async function showProjectRootSelected(root) {
  if (isWatchdogInitialized(root)) {
    const createdReadme = await ensureWatchdogReadme(root);
    const suffix = createdReadme ? " Created README.codex-watchdog.md." : "";
    vscode.window.showInformationMessage(`Codex Watchdog project selected. Next: Start Guard when the task is ready.${suffix}`);
    return;
  }
  vscode.window.showInformationMessage("Codex Watchdog project selected. Next: click Prepare Project.");
}

async function openControlPanelCommand() {
  if (controlPanel) {
    controlPanel.reveal(vscode.ViewColumn.One);
    await updateControlPanel();
    return;
  }

  controlPanel = vscode.window.createWebviewPanel(
    "codexWatchdogControl",
    "Codex Watchdog",
    vscode.ViewColumn.One,
    { enableScripts: true }
  );
  controlPanel.onDidDispose(() => {
    controlPanel = undefined;
  });
  controlPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      await handleControlPanelMessage(message);
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      vscode.window.showErrorMessage(`Codex Watchdog: ${text}`);
      output.appendLine(`[control-panel error] ${text}`);
      await updateControlPanel();
    }
  });

  await updateControlPanel();
}

async function handleControlPanelMessage(message) {
  const command = message && message.command;

  if (command === "chooseRoot") {
    const root = await selectProjectRoot("Enter the project folder Codex Watchdog should control");
    if (root) {
      await rememberProjectRoot(root);
      await showProjectRootSelected(root);
    }
    await updateControlPanel();
    return;
  }

  if (command === "browseRoot") {
    const root = await browseExistingProjectRoot("Browse for an existing project folder", message.root);
    if (root) {
      await rememberProjectRoot(root);
      await showProjectRootSelected(root);
    }
    await updateControlPanel();
    return;
  }

  if (command === "saveRoot") {
    const root = await normalizeProjectRootInput(message.root, "Project root", { offerCreate: true, confirmCreate: false });
    if (!root) {
      await updateControlPanel();
      return;
    }
    await rememberProjectRoot(root);
    await showProjectRootSelected(root);
    await updateControlPanel();
    return;
  }

  if (command === "clearRoot") {
    await clearRememberedProjectRoot();
    await updateControlPanel();
    return;
  }

  if (command === "saveInterval") {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    const interval = Number(message.intervalMinutes);
    if (!Number.isInteger(interval) || interval < 5) {
      throw new Error("Interval must be a whole number >= 5 minutes.");
    }
    const compactEveryRuns = Number(message.compactEveryRuns);
    if (!Number.isInteger(compactEveryRuns) || compactEveryRuns < 0) {
      throw new Error("Compaction cadence must be a whole number >= 0 runs.");
    }
    await updateProjectSetting(root, "codexWatchdog.intervalMinutes", interval);
    await updateProjectSetting(root, "codexWatchdog.compactEveryRuns", compactEveryRuns);
    const drift = readWatcherUnitDrift(root, await effectiveWatchdogSettings(root));
    vscode.window.showInformationMessage(
      drift.needsReinstall
        ? `Codex Watchdog schedule saved: ${interval} minutes; compact every ${compactEveryRuns} runs. Reinstall the timer so systemd uses the new schedule.`
        : `Codex Watchdog schedule saved: ${interval} minutes; compact every ${compactEveryRuns} runs`
    );
    await updateControlPanel();
    return;
  }

  if (command === "refresh") {
    await updateControlPanel();
    return;
  }

  if (command === "login") {
    await openLoginTerminal();
    await updateControlPanel();
    return;
  }

  if (command === "prepareProject") {
    await prepareProjectCommand();
    await updateControlPanel();
    return;
  }

  if (command === "generateBootstrap") {
    await generateBootstrapConversationCommand(message.text);
    await updateControlPanel();
    return;
  }

  if (command === "instantiateBootstrapProject") {
    const root = await getProjectRoot();
    if (root) {
      await instantiateBootstrapProjectCommand(root);
    }
    await updateControlPanel();
    return;
  }

  if (command === "openSetupFiles") {
    const root = await getProjectRoot();
    if (root) {
      await projectSetupHelpers.openInstantiationFiles(root);
    }
    await updateControlPanel();
    return;
  }

  if (command === "openBootstrapTranscript") {
    const root = await getProjectRoot();
    if (root) {
      await openBootstrapTranscriptCommand(root);
    }
    await updateControlPanel();
    return;
  }

  if (command === "openBootstrapPreview") {
    const root = await getProjectRoot();
    if (root) {
      await openBootstrapChangePreviewCommand(root);
    }
    await updateControlPanel();
    return;
  }

  if (command === "resetBootstrapConversation") {
    const root = await getProjectRoot();
    if (root) {
      const answer = await vscode.window.showWarningMessage(
        "Reset the bootstrap conversation? Current transcript and last draft artifacts will be archived under agent/status/bootstrap_archive/ before the panel is cleared.",
        { modal: true },
        "Reset Conversation"
      );
      if (answer === "Reset Conversation") {
        await archiveAndResetBootstrapConversation(root);
        vscode.window.showInformationMessage("Bootstrap conversation reset. Previous transcript and draft artifacts were archived under agent/status/bootstrap_archive/.");
      }
    }
    await updateControlPanel();
    return;
  }

  if (command === "runOnce") {
    await guardCommands.runOnceCommand();
    await updateControlPanel();
    return;
  }

  if (command === "startGuard") {
    await guardCommands.startGuardCommand();
    await updateControlPanel();
    return;
  }

  if (command === "pauseGuard") {
    await guardCommands.pauseGuardCommand();
    await updateControlPanel();
    return;
  }

  if (command === "resumeGuard") {
    await guardCommands.resumeGuardCommand();
    await updateControlPanel();
    return;
  }

  if (command === "stopGuard") {
    await guardCommands.stopGuardCommand();
    await updateControlPanel();
    return;
  }

  if (command === "startTimer") {
    await guardCommands.startTimerCommand();
    await updateControlPanel();
    return;
  }

  if (command === "stopTimer") {
    await guardCommands.stopTimerCommand();
    await updateControlPanel();
    return;
  }

  if (command === "openLatest") {
    await guardCommands.openLatestReportCommand();
    await updateControlPanel();
    return;
  }

  if (command === "openMorning") {
    await openMorningBriefCommand();
    await updateControlPanel();
    return;
  }

  if (command === "refreshGenerated") {
    await refreshGeneratedFilesCommand();
    await updateControlPanel();
  }
}

async function updateControlPanel() {
  if (!controlPanel) {
    await updateStatusBar();
    return;
  }
  controlPanel.webview.html = renderControlPanel(await getControlPanelState(), createNonce());
  await updateStatusBar();
}

async function setPanelOperationState(data) {
  panelOperationState = {
    status: "running",
    title: String(data && data.title || ""),
    detail: String(data && data.detail || ""),
    startedAt: String(data && data.startedAt || panelOperationState.startedAt || new Date().toISOString())
  };
  await updateControlPanel();
}

async function clearPanelOperationState() {
  panelOperationState = emptyPanelOperationState();
  await updateControlPanel();
}

async function getControlPanelState() {
  const root = getKnownProjectRoot();
		  const state = {
    root: root || "",
    rootExists: Boolean(root && fs.existsSync(root)),
    initialized: Boolean(root && fs.existsSync(root) && isWatchdogInitialized(root)),
    taskReady: Boolean(root && fs.existsSync(root) && isWatchdogInitialized(root) && projectSetupHelpers.taskLooksInstantiated(root)),
	    paused: Boolean(root && fs.existsSync(root) && isGuardPaused(root)),
	    codexHome: "",
    codexHomeNotice: "",
	    codexBin: "",
    sandboxMode: "",
    timeoutMinutes: "",
    intervalMinutes: "",
    compactEveryRuns: "",
    login: { ok: false, text: "Select a project root first.", bootstrapText: "", canSeedFromMainAuth: false },
	    timer: { text: "Unavailable", isActive: false, isEnabled: false, activeText: "unknown", enabledText: "unknown", needsReinstall: false, warningText: "" },
    runtime: { queueText: "", signals: [] },
    latestReport: "",
	    latestSummary: "",
    bootstrap: {
      messages: [],
      openQuestions: [],
      readyForStartGuard: false,
      draftText: "",
      isRunning: false,
      runtimeDetail: "",
      runtimeStartedAt: "",
      statusText: "Prepare the project, then describe the watchdog objective here."
    },
    operation: {
      isRunning: false,
      title: "",
      detail: "",
      startedAt: ""
    },
    nextStep: "Select a project root, then start the guard."
  };

  if (!root || !fs.existsSync(root)) {
    state.nextStep = getControlPanelNextStep(state);
    return state;
  }

	  try {
    const codexHome = codexHomePlan(root);
	    state.codexHome = codexHome.effectivePath;
    state.codexHomeNotice = codexHome.migrationReason || "";
	    state.codexBin = await resolveCodexBin(root);
	    state.sandboxMode = sandboxModeSetting(root);
	    state.timeoutMinutes = String(positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", DEFAULT_TIMEOUT_MINUTES), 1, DEFAULT_TIMEOUT_MINUTES));
	    state.intervalMinutes = String(positiveNumberSetting(root, "codexWatchdog.intervalMinutes", extensionSetting("intervalMinutes", DEFAULT_INTERVAL_MINUTES), 5, DEFAULT_INTERVAL_MINUTES));
	    state.compactEveryRuns = String(positiveNumberSetting(root, "codexWatchdog.compactEveryRuns", extensionSetting("compactEveryRuns", DEFAULT_COMPACT_EVERY_RUNS), 0, DEFAULT_COMPACT_EVERY_RUNS));
	    state.login = await getCodexLoginStatus(root);
	    state.timer = await getTimerStatus(root);
    state.runtime = inspectProjectRuntimeClarity(root);
    const settings = await effectiveWatchdogSettings(root);
    const timerDrift = readWatcherUnitDrift(root, settings);
    state.timer.needsReinstall = timerDrift.needsReinstall;
    state.timer.warningText = timerDrift.text;
	  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    state.login = { ok: false, text: `Configuration error:\n${message}`, bootstrapText: "", canSeedFromMainAuth: false };
	    state.timer = { text: "Unavailable until configuration is fixed.", isActive: false, isEnabled: false, activeText: "unknown", enabledText: "unknown", needsReinstall: false, warningText: "" };
    state.nextStep = "Fix the project-local watchdog configuration, then refresh status.";
    return state;
  }
  state.nextStep = getControlPanelNextStep(state);
  state.bootstrap = await getBootstrapConversationState(root);
  state.operation = {
    isRunning: panelOperationState.status === "running",
    title: panelOperationState.title || "",
    detail: panelOperationState.detail || "",
    startedAt: panelOperationState.startedAt || ""
  };

	  const latest = path.join(root, "agent", "reports", "latest.md");
	  if (fs.existsSync(latest)) {
	    state.latestReport = latest;
	    state.latestSummary = readFilePrefix(latest, 64 * 1024).split(/\r?\n/).slice(0, 10).join("\n");
	  }

  return state;
}

function getControlPanelNextStep(state) {
  if (!state.root) {
    return "Select the Linux folder that Codex Watchdog should control.";
  }
  if (!state.rootExists) {
    return "Create or browse to an existing Linux project folder.";
  }
  if (state.paused) {
    return "Watchdog is paused. Resume Guard when you want the next timer wakeup to run.";
  }
  if (!state.initialized) {
    return "Project folder is selected. Click Prepare Project, then use the Bootstrap Conversation section to instantiate the watchdog task from your plain-language requirement.";
  }
  if (!state.taskReady) {
    return "Use the Bootstrap Conversation section to talk through the setup, preview the candidate files, then click Instantiate Project before Start Guard.";
  }
  if (!state.login.ok) {
    return "Open the login terminal, complete OpenAI login, then click Start Guard again.";
  }
  if (state.timer && state.timer.needsReinstall) {
    return "Watchdog settings changed. Click Start Guard or run ./agent/bin/watchdog timer-install to reinstall the timer with the current CODEX_HOME and schedule.";
  }
  if (state.timer.isActive) {
    return "Watchdog is running. Use Open Latest Report or Open Morning Brief to inspect its work.";
  }
  return "After Codex has instantiated PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF, click Start Guard.";
}

function getKnownProjectRoot() {
  const configured = expandHome(extensionSetting("projectRoot", ""));
  if (configured && isExistingDirectory(configured) && isSafeProjectRootPath(configured)) {
    return configured;
  }
  const remembered = extensionContext && extensionContext.globalState.get(PROJECT_ROOT_KEY);
  if (remembered && isExistingDirectory(remembered) && isSafeProjectRootPath(remembered)) {
    return remembered;
  }
  return "";
}

function renderControlPanel(state, nonce) {
  const esc = escapeHtml;
  const scriptNonce = nonce || createNonce();
  const loginClass = state.login.ok ? "ok" : "bad";
  const initializedClass = state.initialized ? "ok" : "warn";
  const timerActive = Boolean(state.timer.isActive);
  const timerEnabled = Boolean(state.timer.isEnabled);
  const timerClass = timerActive ? "ok" : timerEnabled ? "warn" : "muted";
  const timerLabel = timerActive ? "On" : timerEnabled ? "Enabled" : "Off";
  const projectLabel = state.root ? path.basename(state.root) || state.root : "No project selected";
  const prepareButtonClass = !state.initialized || !state.taskReady ? "" : "secondary";
  const startButtonClass = state.initialized && state.taskReady && !timerActive ? "" : "secondary";
  const instantiateButtonClass = state.bootstrap.hasDraft ? "" : "secondary";
  const selectedOnlyStyle = state.root ? "" : ' style="display:none"';
  const timerPill = state.root ? `<div class="pill ${timerClass}">Timer ${esc(timerLabel)}</div>` : "";
  const bootstrapConversationHtml = state.bootstrap.messages.length
    ? state.bootstrap.messages.map((message) => {
      const roleClass = message.role === "assistant" ? "assistant" : "user";
      const roleLabel = message.role === "assistant" ? "AI reply" : "You";
      return `
        <div class="message ${roleClass}">
          <div class="message-meta">${esc(roleLabel)}${message.createdAt ? ` · ${esc(message.createdAt)}` : ""}</div>
          <div class="message-body">${esc(message.text)}</div>
        </div>
      `;
    }).join("")
    : `<div class="subtle">No bootstrap conversation yet. Describe the project goal here, then let Codex draft the watchdog setup files inside this panel.</div>`;
  const bootstrapQuestionsHtml = state.bootstrap.openQuestions.length
    ? `
      <div class="hint">
        <strong>Open questions</strong>
        <ul>
          ${state.bootstrap.openQuestions.map((item) => `<li>${esc(item)}</li>`).join("")}
        </ul>
      </div>
    `
    : "";
  const bootstrapPendingHtml = state.bootstrap.isRunning
    ? `
      <div class="message assistant pending">
        <div class="message-meta">⌛ Waiting for AI reply${state.bootstrap.runtimeStartedAt ? ` · ${esc(state.bootstrap.runtimeStartedAt)}` : ""}</div>
        <div class="message-body">${esc(state.bootstrap.runtimeDetail || "Codex is thinking about the next reply...")}</div>
      </div>
    `
    : "";
  const operationPendingHtml = state.operation.isRunning
    ? `
      <div class="message assistant pending">
        <div class="message-meta">⌛ ${esc(state.operation.title || "Working")}${state.operation.startedAt ? ` · ${esc(state.operation.startedAt)}` : ""}</div>
        <div class="message-body">${esc(state.operation.detail || "Codex Watchdog is still working on this step...")}</div>
      </div>
    `
    : "";
  const runtimeSignalsHtml = state.runtime.signals.length
    ? state.runtime.signals.map((signal) => `<div class="status ${esc(signal.level || "muted")}">${esc(signal.text || "")}</div>`).join("")
    : `<div class="subtle">No paused/stale-state warning is visible from the local watchdog runtime files.</div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
	  <meta charset="UTF-8">
	  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${esc(scriptNonce)}';">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Watchdog</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      max-width: 960px;
      margin: 0;
      padding: 22px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      line-height: 1.45;
    }
    h1 { font-size: 21px; margin: 0; font-weight: 700; letter-spacing: 0; }
    h2 {
      font-size: 12px;
      margin: 24px 0 10px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      letter-spacing: 0;
      font-weight: 700;
    }
    .header {
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .subtitle { margin-top: 4px; color: var(--vscode-descriptionForeground); }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 26px;
      padding: 3px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      font-weight: 700;
      white-space: nowrap;
    }
    .pill::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
      box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent);
    }
    .section {
      padding-top: 2px;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 64%, transparent);
      margin-top: 18px;
    }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
    input, textarea {
      flex: 1;
      min-width: min(360px, 100%);
      min-height: 32px;
      padding: 7px 9px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 5px;
    }
    input.small { flex: 0 0 92px; min-width: 92px; }
    textarea {
      width: 100%;
      min-height: 116px;
      resize: vertical;
      font: inherit;
      line-height: 1.45;
    }
    input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    button {
      appearance: none;
      min-height: 32px;
      padding: 7px 12px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      line-height: 1;
      box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.2);
      transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
    }
    button:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-color: var(--vscode-button-border, var(--vscode-panel-border));
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.ghost {
      color: var(--vscode-foreground);
      background: transparent;
      border-color: var(--vscode-panel-border);
      box-shadow: none;
    }
    button.danger {
      color: #f85149;
      background: transparent;
      border-color: color-mix(in srgb, #f85149 56%, var(--vscode-panel-border));
      box-shadow: none;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .status {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      margin: 8px 0;
      white-space: pre-wrap;
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background));
    }
    .ok { color: #3fb950; }
    .bad { color: #f85149; }
    .warn { color: #d29922; }
    .muted { color: var(--vscode-descriptionForeground); }
    code, pre { font-family: var(--vscode-editor-font-family); }
    pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow: auto; max-height: 180px; border-radius: 6px; }
    .grid { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; }
    .label { color: var(--vscode-descriptionForeground); }
    .metric {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin-top: 12px;
    }
    .metric-item {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 9px 10px;
    }
	    .metric-item span { display: block; color: var(--vscode-descriptionForeground); font-size: 12px; }
	    .metric-item strong { display: block; margin-top: 2px; font-size: 14px; }
	    .hint {
	      border-left: 3px solid var(--vscode-focusBorder);
	      padding: 8px 10px;
	      margin-top: 12px;
	      background: color-mix(in srgb, var(--vscode-focusBorder) 9%, transparent);
	      border-radius: 5px;
	    }
	    details { margin-top: 12px; }
    summary {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 5px 8px;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      cursor: pointer;
      font-weight: 700;
    }
    summary:hover { color: var(--vscode-foreground); }
    .advanced-actions { margin-top: 10px; }
    .workflow-stack {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .workflow-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background));
    }
    .workflow-card.ready {
      border-color: color-mix(in srgb, #3fb950 55%, var(--vscode-panel-border));
      background: color-mix(in srgb, #3fb950 7%, var(--vscode-editor-background));
    }
    .workflow-step-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      margin-bottom: 4px;
      letter-spacing: 0;
    }
    .workflow-step-body {
      margin-bottom: 10px;
      white-space: pre-wrap;
    }
    .conversation {
      display: grid;
      gap: 10px;
      margin-top: 10px;
    }
    .message {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-sideBar-background));
    }
    .message.user {
      border-left: 4px solid color-mix(in srgb, var(--vscode-focusBorder) 72%, transparent);
    }
    .message.assistant {
      border-left: 4px solid color-mix(in srgb, #3fb950 72%, transparent);
    }
    .message.pending {
      border-left: 4px solid color-mix(in srgb, #d29922 72%, transparent);
      background: color-mix(in srgb, #d29922 8%, var(--vscode-editor-background));
    }
    .message-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .message-body {
      white-space: pre-wrap;
    }
    .subtle {
      color: var(--vscode-descriptionForeground);
    }
    @media (max-width: 640px) {
      body { padding: 16px; }
      .header { display: block; }
      .pill { margin-top: 10px; }
      .grid { grid-template-columns: 1fr; }
      input, textarea { min-width: 100%; }
    }
  </style>
</head>
<body data-selected-root="${esc(state.root)}">
  <div class="header">
    <div>
      <h1>Codex Watchdog</h1>
      <div class="subtitle">${esc(projectLabel)}</div>
    </div>
    ${timerPill}
  </div>

	  <div class="metric selected-only"${selectedOnlyStyle}>
    <div class="metric-item"><span>Folder</span><strong class="${state.rootExists ? "ok" : "bad"}">${state.rootExists ? "Exists" : "Missing"}</strong></div>
    <div class="metric-item"><span>Template</span><strong class="${initializedClass}">${state.initialized ? "Initialized" : "Not initialized"}</strong></div>
    <div class="metric-item"><span>Task</span><strong class="${state.taskReady ? "ok" : "warn"}">${state.taskReady ? "Instantiated" : "Needs setup"}</strong></div>
    <div class="metric-item"><span>Login</span><strong class="${loginClass}">${state.login.ok ? "Ready" : "Needs login"}</strong></div>
    <div class="metric-item"><span>Control</span><strong class="${state.paused ? "warn" : "ok"}">${state.paused ? "Paused" : "Live"}</strong></div>
	  </div>
	  <div class="hint selected-only"${selectedOnlyStyle}>${esc(state.nextStep)}</div>
  ${state.root ? operationPendingHtml : ""}

  <div class="section">
  <h2>Project</h2>
  <div class="row">
    <input id="root" value="${esc(state.root)}" placeholder="/home/you/project">
    <button id="saveRoot">Use / Create Project</button>
    <button id="browseRoot" class="secondary">Browse Existing</button>
    <button id="chooseRoot" class="ghost">Prompt Path</button>
    <button id="clearRoot" class="ghost">Clear</button>
  </div>
  <div id="pendingRootHint" class="hint" hidden>This path is not selected yet. Click <strong>Use / Create Project</strong> to create/select it before viewing reports or starting the guard.</div>
	  <div class="grid selected-only"${selectedOnlyStyle}>
	    <div class="label">Folder</div><div class="${state.rootExists ? "ok" : "bad"}">${state.rootExists ? "exists" : "missing"}</div>
	    <div class="label">Template</div><div class="${initializedClass}">${state.initialized ? "initialized" : "not initialized"}</div>
	    <div class="label">Task</div><div class="${state.taskReady ? "ok" : "warn"}">${state.taskReady ? "instantiated" : "needs setup"}</div>
	    <div class="label">Sandbox</div><div><code>${esc(state.sandboxMode || "-")}</code></div>
	    <div class="label">Codex Home</div><div><code>${esc(state.codexHome || "-")}</code></div>
	    <div class="label">Codex Bin</div><div><code>${esc(state.codexBin || "-")}</code></div>
	  </div>
    ${state.codexHomeNotice ? `<div class="status warn">${esc(state.codexHomeNotice)}</div>` : ""}
	  </div>

  <div class="section selected-only"${selectedOnlyStyle}>
	  <h2>Login</h2>
	  <div class="status ${loginClass}">${esc(state.login.text)}</div>
    ${state.login.bootstrapText ? `<div class="status warn">${esc(state.login.bootstrapText)}</div>` : ""}
	  <div class="hint">OpenAI login is the only manual authorization step. The extension prepares the folder and scripts, then waits for this login before starting unattended runs.</div>
	  <div class="row">
	    <button id="refresh" class="secondary">Refresh Status</button>
	    <button id="login">Open Login Terminal</button>
  </div>
  </div>

  <div class="section selected-only"${selectedOnlyStyle}>
  <h2>Schedule</h2>
	  <div class="row">
	    <label for="interval">Repeat every</label>
	    <input id="interval" class="small" type="number" min="5" value="${esc(state.intervalMinutes || "30")}">
	    <span>minutes</span>
    <label for="compactEveryRuns">Compact every</label>
    <input id="compactEveryRuns" class="small" type="number" min="0" value="${esc(state.compactEveryRuns || "6")}">
    <span>runs</span>
    <button id="saveInterval">Save</button>
	  </div>
	  <div class="status">${esc(state.timer.text)}</div>
    ${state.timer.warningText ? `<div class="status warn">${esc(state.timer.warningText)}</div>` : ""}
	  </div>

  <div class="section selected-only"${selectedOnlyStyle}>
  <h2>Actions</h2>
  <div class="actions">
    <button id="prepareProject" class="${esc(prepareButtonClass)}">Prepare Project</button>
    <button id="pauseGuard" class="secondary">Pause Guard</button>
    <button id="resumeGuard" class="secondary">Resume Guard</button>
    <button id="stopGuard" class="danger">Stop Guard</button>
    <button id="refreshGenerated" class="secondary">Refresh Generated Files</button>
    <button id="openLatest" class="ghost">Open Latest Report</button>
    <button id="openMorning" class="secondary">Open Morning Brief</button>
  </div>
  <details>
    <summary>Advanced actions</summary>
    <div class="actions advanced-actions">
      <button id="runOnce" class="secondary">Run Once</button>
      <button id="startTimer" class="secondary">Run Once + Start Timer</button>
      <button id="stopTimer" class="danger">Stop Timer Only</button>
    </div>
  </details>
  </div>

  <div class="section selected-only"${selectedOnlyStyle}>
  <h2>Runtime Clarity</h2>
  ${state.runtime.queueText ? `<div class="status">${esc(state.runtime.queueText)}</div>` : ""}
  ${runtimeSignalsHtml}
  </div>

  <div class="section selected-only"${selectedOnlyStyle}>
    <h2>Bootstrap Conversation</h2>
    <div class="hint">Keep the watchdog setup discussion here. Codex will read the bootstrap files, answer inside this panel, stage a candidate setup draft, and keep the setup transcript in the project for later follow-up.</div>
    <div class="status">${esc(state.bootstrap.statusText)}</div>
    ${bootstrapQuestionsHtml}
    <div class="conversation">
      ${bootstrapConversationHtml}
      ${bootstrapPendingHtml}
    </div>
    <div class="row">
      <textarea id="bootstrapPrompt" placeholder="Describe what this watchdog project should do, what to avoid, and whether guard start should wait for review.">${esc(state.bootstrap.draftText || "")}</textarea>
    </div>
    <div class="workflow-stack">
      <div class="workflow-card">
        <div class="workflow-step-title">Step 1</div>
        <div class="workflow-step-body"><strong>Generate Drafts</strong>\n先讨论。让 AI 回答当前问题，并继续澄清项目目标。</div>
        <button id="generateBootstrap">Generate Drafts</button>
      </div>
      <div class="workflow-card">
        <div class="workflow-step-title">Step 2</div>
        <div class="workflow-step-body"><strong>Preview Changed Files</strong>\n看根据当前讨论自动合成的候选项目方案。</div>
        <button id="openBootstrapPreview" class="secondary">Preview Changed Files</button>
      </div>
      <div class="workflow-card">
        <div class="workflow-step-title">Step 3</div>
        <div class="workflow-step-body"><strong>Instantiate Project</strong>\n真正把候选方案写入 PLAN / TODO / STATE / SAFETY / DAILY_HANDOFF。</div>
        <button id="instantiateBootstrapProject" class="${esc(instantiateButtonClass)}">Instantiate Project</button>
      </div>
      <div class="workflow-card ${state.taskReady ? "ready" : ""}">
        <div class="workflow-step-title">Step 4</div>
        <div class="workflow-step-body"><strong>Start Guard</strong>\n最后再启动 guard，让项目进入定时 watchdog 模式。${state.taskReady ? "\n\n当前状态：已满足启动条件。" : "\n\n当前状态：还要先完成实例化。"} </div>
        <button id="startGuard" class="${esc(startButtonClass)}">Start Guard</button>
      </div>
    </div>
    <div class="actions" style="margin-top:10px;">
      <button id="openSetupFiles" class="secondary">Open Setup Files</button>
      <button id="openBootstrapTranscript" class="ghost">Open Setup Transcript</button>
      <button id="resetBootstrapConversation" class="ghost">Reset Conversation</button>
    </div>
  </div>

  <div class="section selected-only"${selectedOnlyStyle}>
  <h2>Latest Report</h2>
  <div>${state.latestReport ? `<code>${esc(state.latestReport)}</code>` : "No latest report found."}</div>
  ${state.latestSummary ? `<pre>${esc(state.latestSummary)}</pre>` : ""}
  </div>

	  <script nonce="${esc(scriptNonce)}">
    const vscode = acquireVsCodeApi();
    const post = (command, payload = {}) => vscode.postMessage({ command, ...payload });
    const selectedRoot = document.body.dataset.selectedRoot || '';
    const rootInput = document.getElementById('root');
    const pendingRootHint = document.getElementById('pendingRootHint');
    const selectedOnlySections = Array.from(document.querySelectorAll('.selected-only'));
    const syncDraftRoot = () => {
      const draftRoot = rootInput.value.trim();
      const changed = !selectedRoot || draftRoot !== selectedRoot;
      pendingRootHint.hidden = selectedRoot ? !changed : !draftRoot;
      selectedOnlySections.forEach((section) => {
        section.style.display = changed ? 'none' : '';
      });
    };
    rootInput.addEventListener('input', syncDraftRoot);
    syncDraftRoot();
    document.getElementById('chooseRoot').addEventListener('click', () => post('chooseRoot'));
    document.getElementById('browseRoot').addEventListener('click', () => post('browseRoot', { root: rootInput.value }));
    document.getElementById('saveRoot').addEventListener('click', () => post('saveRoot', { root: rootInput.value }));
    document.getElementById('clearRoot').addEventListener('click', () => post('clearRoot'));
    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
    document.getElementById('login').addEventListener('click', () => post('login'));
    document.getElementById('saveInterval').addEventListener('click', () => post('saveInterval', {
      intervalMinutes: document.getElementById('interval').value,
      compactEveryRuns: document.getElementById('compactEveryRuns').value
    }));
    document.getElementById('prepareProject').addEventListener('click', () => post('prepareProject'));
    const bootstrapPrompt = document.getElementById('bootstrapPrompt');
    const sendBootstrapPrompt = () => post('generateBootstrap', {
      text: bootstrapPrompt.value
    });
    document.getElementById('generateBootstrap').addEventListener('click', sendBootstrapPrompt);
    bootstrapPrompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendBootstrapPrompt();
      }
    });
    document.getElementById('instantiateBootstrapProject').addEventListener('click', () => post('instantiateBootstrapProject'));
    document.getElementById('openSetupFiles').addEventListener('click', () => post('openSetupFiles'));
    document.getElementById('openBootstrapTranscript').addEventListener('click', () => post('openBootstrapTranscript'));
    document.getElementById('openBootstrapPreview').addEventListener('click', () => post('openBootstrapPreview'));
    document.getElementById('resetBootstrapConversation').addEventListener('click', () => post('resetBootstrapConversation'));
    document.getElementById('startGuard').addEventListener('click', () => post('startGuard'));
    document.getElementById('pauseGuard').addEventListener('click', () => post('pauseGuard'));
    document.getElementById('resumeGuard').addEventListener('click', () => post('resumeGuard'));
    document.getElementById('stopGuard').addEventListener('click', () => post('stopGuard'));
    document.getElementById('runOnce').addEventListener('click', () => post('runOnce'));
    document.getElementById('startTimer').addEventListener('click', () => post('startTimer'));
    document.getElementById('stopTimer').addEventListener('click', () => post('stopTimer'));
    document.getElementById('refreshGenerated').addEventListener('click', () => post('refreshGenerated'));
    document.getElementById('openLatest').addEventListener('click', () => post('openLatest'));
    document.getElementById('openMorning').addEventListener('click', () => post('openMorning'));
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createNonce() {
  return crypto.randomBytes(16).toString("base64");
}

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
      await ensureGeneratedDirs(root);
      await refreshGeneratedWatcherFiles(root);
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
    await bootstrapProject(root);
    await ensureHandoffFiles(root);
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
  const timeout = positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", DEFAULT_TIMEOUT_MINUTES), 1, DEFAULT_TIMEOUT_MINUTES);
  const minutes = timeout + 5;
  return minutes * 60 * 1000;
}

async function effectiveWatchdogSettings(root) {
  return {
    codexBin: await resolveCodexBin(root),
    codexHome: codexHomeSetting(root),
    sandboxMode: sandboxModeSetting(root),
    intervalMinutes: positiveNumberSetting(root, "codexWatchdog.intervalMinutes", extensionSetting("intervalMinutes", DEFAULT_INTERVAL_MINUTES), 5, DEFAULT_INTERVAL_MINUTES),
    timeoutMinutes: positiveNumberSetting(root, "codexWatchdog.timeoutMinutes", extensionSetting("timeoutMinutes", DEFAULT_TIMEOUT_MINUTES), 1, DEFAULT_TIMEOUT_MINUTES),
    compactEveryRuns: positiveNumberSetting(root, "codexWatchdog.compactEveryRuns", extensionSetting("compactEveryRuns", DEFAULT_COMPACT_EVERY_RUNS), 0, DEFAULT_COMPACT_EVERY_RUNS),
    role: watchdogRoleSetting(root),
    phaseOffsetMinutes: positiveNumberSetting(root, "codexWatchdog.phaseOffsetMinutes", extensionSetting("phaseOffsetMinutes", DEFAULT_PHASE_OFFSET_MINUTES), 0, DEFAULT_PHASE_OFFSET_MINUTES),
    supervisorLightFollowup: booleanSetting(root, "codexWatchdog.supervisorLightFollowup", extensionSetting("supervisorLightFollowup", DEFAULT_SUPERVISOR_LIGHT_FOLLOWUP), DEFAULT_SUPERVISOR_LIGHT_FOLLOWUP),
    supervisorAuditEveryRunnerRuns: positiveNumberSetting(root, "codexWatchdog.supervisorAuditEveryRunnerRuns", extensionSetting("supervisorAuditEveryRunnerRuns", DEFAULT_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS), 1, DEFAULT_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS),
    servicePrefix: servicePrefixSetting(root)
  };
}

async function renderWatchdogEnv(root) {
  const settings = await effectiveWatchdogSettings(root);
  return [
    "# Generated by Codex Watchdog. No secrets are stored here.",
    "# This file keeps VSCode control-panel startup and project-local CLI startup aligned.",
    `CODEX_BIN=${shellQuote(settings.codexBin)}`,
    `CODEX_HOME=${shellQuote(settings.codexHome)}`,
    `CODEX_SANDBOX_MODE=${shellQuote(settings.sandboxMode)}`,
    `WATCHDOG_INTERVAL_MINUTES=${shellQuote(String(settings.intervalMinutes))}`,
    `WATCHDOG_TIMEOUT_MINUTES=${shellQuote(String(settings.timeoutMinutes))}`,
    `WATCHDOG_COMPACT_EVERY_RUNS=${shellQuote(String(settings.compactEveryRuns))}`,
    `WATCHDOG_ROLE=${shellQuote(settings.role)}`,
    `WATCHDOG_PHASE_OFFSET_MINUTES=${shellQuote(String(settings.phaseOffsetMinutes))}`,
    `WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=${shellQuote(settings.supervisorLightFollowup ? "1" : "0")}`,
    `WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=${shellQuote(String(settings.supervisorAuditEveryRunnerRuns))}`,
    `WATCHDOG_SERVICE_PREFIX=${shellQuote(settings.servicePrefix)}`,
    ""
  ].join("\n");
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

async function bootstrapProject(root) {
  const created = [];
  const skipped = [];

  await ensureGeneratedDirs(root);

  await writeIfAbsent(root, path.join(root, "README.codex-watchdog.md"), templates.watchdogReadme(), created, skipped);
  await writeIfAbsent(root, path.join(root, "AGENTS.md"), templates.agents(), created, skipped);
  if (skipped.includes("AGENTS.md")) {
    await writeIfAbsent(root, path.join(root, "agent", "AGENTS.watchdog.example.md"), templates.agents(), created, skipped);
  }
  await writeIfAbsent(root, path.join(root, "agent", "CODEX_TAKEOVER.md"), templates.codexTakeover(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "WATCHDOG_PROTOCOL.md"), templates.watchdogProtocol(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "TASK_REQUEST.md"), templates.taskRequest(), created, skipped);

  await writeIfAbsent(root, path.join(root, "agent", "PLAN.md"), templates.plan(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "STATE.md"), templates.state(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "STATE.json"), templates.stateJson(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "TASK_BOX.json"), templates.taskBoxJson(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "ROUTE_CANONICAL.json"), templates.routeCanonicalJson(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "PROGRESS_STATE.json"), templates.progressStateJson(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "CURRENT_STATE.md"), templates.currentState(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "RUN_STATE.json"), templates.runStateJson(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "NEXT_ACTION.md"), templates.nextAction(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "BLOCKERS.md"), templates.blockers(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "REVIEW_PENDING.md"), templates.reviewPending(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "ANTI_SNOWBALL.md"), templates.antiSnowball(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "EXPERIMENT_LEDGER.md"), templates.experimentLedger(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "RUNTIME_STATE.md"), templates.runtimeState(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "DAILY_HANDOFF.md"), templates.dailyHandoff(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "MORNING_BRIEF.md"), templates.morningBrief(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "SAFETY.md"), templates.safety(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "TODO.md"), templates.todo(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "workspace_write_policy.example.json"), templates.workspaceWritePolicyExample(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "SECONDARY_SKILLS.example.json"), templates.secondarySkillsExample(), created, skipped);
  for (const [rel, content] of generatedSkillFiles()) {
    await writeIfAbsent(root, path.join(root, rel), content, created, skipped);
  }
  await writeIfAbsent(root, path.join(root, "agent", "prompts", "wakeup.md"), templates.wakeup(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "watch_decision.schema.json"), templates.schema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "bootstrap_conversation_turn.schema.json"), templates.bootstrapConversationTurnSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "bootstrap_instantiation.schema.json"), templates.bootstrapInstantiationSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "state.schema.json"), templates.stateSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "task_box.schema.json"), templates.taskBoxSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "route_canonical.schema.json"), templates.routeCanonicalSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "secondary_skills.schema.json"), templates.secondarySkillsSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "job.schema.json"), templates.jobSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "schemas", "gate.schema.json"), templates.gateSchema(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "status", "QUEUE_STATUS.md"), templates.queueStatus(), created, skipped);
  await writeIfAbsent(root, path.join(root, "agent", "EVIDENCE_LEDGER.jsonl"), templates.evidenceLedgerJsonl(), created, skipped);
  await writeIfAbsent(root, path.join(root, "research", "RESEARCH_LEDGER.md"), templates.researchLedger(), created, skipped);
  await writeIfAbsent(root, path.join(root, "research", "LEDGER_NOTES.md"), templates.ledgerNotes(), created, skipped);

  const collect = path.join(root, "agent", "bin", "collect_status.sh");
  const makePrompt = path.join(root, "agent", "bin", "make_prompt.sh");
	  const runWatchdog = path.join(root, "agent", "bin", "run_watchdog.sh");
	  const renderReport = path.join(root, "agent", "bin", "render_report.py");
	  const routeSkill = path.join(root, "agent", "bin", "route_skill.py");
	  const validateRuntime = path.join(root, "agent", "bin", "validate_runtime.py");
	  const watchdogCli = path.join(root, "agent", "bin", "watchdog");
	  const watchdogTimer = path.join(root, "agent", "bin", "watchdog_timer.sh");
	  const watchdogGuard = path.join(root, "agent", "bin", "watchdog_guard.sh");
	  const watchdogEnv = path.join(root, "agent", "watchdog.env");

  await writeIfAbsent(root, collect, templates.collectStatus(root), created, skipped);
  await writeIfAbsent(root, makePrompt, templates.makePrompt(root), created, skipped);
  await writeIfAbsent(root, runWatchdog, templates.runWatchdog(root), created, skipped);
  await writeIfAbsent(root, renderReport, templates.renderReport(), created, skipped);
	  await writeIfAbsent(root, routeSkill, templates.routeSkill(), created, skipped);
	  await writeIfAbsent(root, validateRuntime, templates.validateRuntime(), created, skipped);
	  await writeIfAbsent(root, watchdogCli, templates.watchdogCli(root), created, skipped);
	  await writeIfAbsent(root, watchdogTimer, templates.watchdogTimer(root), created, skipped);
	  await writeIfAbsent(root, watchdogGuard, templates.watchdogGuard(root), created, skipped);
	  await writeIfAbsent(root, watchdogEnv, await renderWatchdogEnv(root), created, skipped);

  for (const file of [collect, makePrompt, runWatchdog, renderReport, routeSkill, validateRuntime, watchdogCli, watchdogTimer, watchdogGuard]) {
    if (fs.existsSync(file)) {
      await fsp.chmod(file, 0o755);
    }
  }

  await writeGeneratedManifest(root, await generatedWatcherFileEntries(root));

  return { created, skipped };
}

async function ensureWatchdogReadme(root) {
  const created = [];
  const skipped = [];
  await writeIfAbsent(root, path.join(root, "README.codex-watchdog.md"), templates.watchdogReadme(), created, skipped);
  if (created.length) {
    output.appendLine(`Created ${created.join(", ")}`);
  }
  return created.length > 0;
}

async function createDemoProjectTemplate(root) {
  const created = [];
  const skipped = [];

  await ensureDir(root);
  await ensureDir(path.join(root, "logs"));
  await writeIfAbsent(root, path.join(root, "README.md"), templates.demoReadme(), created, skipped);
  await writeIfAbsent(root, path.join(root, "logs", "train.log"), templates.demoTrainLog(), created, skipped);

  const bootstrapResult = await bootstrapProject(root);
  created.push(...bootstrapResult.created);
  skipped.push(...bootstrapResult.skipped);

  await writeDemoFileIfFreshOrTemplate(root, "agent/DAILY_HANDOFF.md", templates.demoDailyHandoff(), bootstrapResult.created, created);
  await writeDemoFileIfFreshOrTemplate(root, "agent/PLAN.md", templates.demoPlan(), bootstrapResult.created, created);
  await writeDemoFileIfFreshOrTemplate(root, "agent/TODO.md", templates.demoTodo(), bootstrapResult.created, created);
  await writeDemoFileIfFreshOrTemplate(root, "agent/STATE.md", templates.demoState(), bootstrapResult.created, created);
  await writeDemoFileIfFreshOrTemplate(root, "agent/SAFETY.md", templates.demoSafety(), bootstrapResult.created, created);
  await writeDemoStateJsonIfFreshOrDefault(root, "agent/STATE.json", templates.demoStateJson(), bootstrapResult.created, created);

  return { created, skipped };
}

async function writeDemoFileIfFresh(root, rel, content, freshlyCreated, created) {
  if (!freshlyCreated.includes(rel)) {
    return;
  }
  const file = path.join(root, rel);
  await fsp.writeFile(file, content);
  created.push(`${rel} (demo content)`);
}

async function writeDemoFileIfFreshOrTemplate(root, rel, content, freshlyCreated, created) {
  const file = path.join(root, rel);
  const existing = fs.existsSync(file) ? await fsp.readFile(file, "utf8") : "";
  if (!freshlyCreated.includes(rel) && !existing.includes("CODEX_WATCHDOG_TEMPLATE_FILE")) {
    return;
  }
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, content);
  created.push(`${rel} (demo content)`);
}

async function writeDemoStateJsonIfFreshOrDefault(root, rel, content, freshlyCreated, created) {
  const file = path.join(root, rel);
  let shouldWrite = freshlyCreated.includes(rel);

  if (!shouldWrite && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
      shouldWrite = Boolean(
        parsed &&
        parsed.schema_version === 1 &&
        Array.isArray(parsed.tasks) &&
        parsed.tasks.length === 0 &&
        parsed.allowed_next_action === "report_only"
      );
    } catch (_error) {
      shouldWrite = false;
    }
  }

  if (!shouldWrite) {
    return;
  }

  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, content);
  created.push(`${rel} (demo content)`);
}

async function ensureGeneratedDirs(root) {
  await ensureDir(path.join(root, "agent", "bin"));
  await ensureDir(path.join(root, "agent", "control"));
  await ensureDir(path.join(root, "agent", "queue", "queued"));
  await ensureDir(path.join(root, "agent", "queue", "running"));
  await ensureDir(path.join(root, "agent", "queue", "done"));
  await ensureDir(path.join(root, "agent", "queue", "failed"));
  await ensureDir(path.join(root, "agent", "gates", "pending"));
  await ensureDir(path.join(root, "agent", "gates", "passed"));
  await ensureDir(path.join(root, "agent", "gates", "failed"));
  await ensureDir(path.join(root, "agent", "gates", "review_required"));
  await ensureDir(path.join(root, "agent", "prompts"));
  await ensureDir(path.join(root, "agent", "schemas"));
  await ensureDir(path.join(root, "agent", "skills"));
  await ensureDir(path.join(root, "agent", "status"));
  await ensureDir(path.join(root, "agent", "reports"));
  await ensureDir(path.join(root, "agent", "pending", "review_required"));
  await ensureDir(path.join(root, "agent", "pending", "proposed_actions"));
  await ensureDir(path.join(root, "agent", "task_profiles"));
  await ensureDir(path.join(root, "agent", "logs"));
  await ensureDir(path.join(root, "workspace"));
  await ensureDir(path.join(root, "runs"));
  await ensureDir(path.join(root, "research", "proposals"));
  await ensureDir(path.join(root, "research", "analysis"));
}

function generatedSkillFiles() {
  return [
    ["agent/SKILL_ROUTER.md", templates.skillRouter()],
    ["agent/skills/watchdog-orchestrator/SKILL.md", templates.skillOrchestrator()],
    ["agent/skills/watchdog-job-queue/SKILL.md", templates.skillJobQueue()],
    ["agent/skills/watchdog-gate-evaluator/SKILL.md", templates.skillGateEvaluator()],
    ["agent/skills/watchdog-report-curator/SKILL.md", templates.skillReportCurator()],
    ["agent/skills/watchdog-permission-guardian/SKILL.md", templates.skillPermissionGuardian()],
    ["agent/skills/watchdog-handoff-writer/SKILL.md", templates.skillHandoffWriter()],
    ["agent/skills/watchdog-cleanup-auditor/SKILL.md", templates.skillCleanupAuditor()],
    ["agent/skills/project-secondary-example/SKILL.example.md", templates.projectSecondarySkillExample()]
  ];
}

async function generatedWatcherFileEntries(root) {
  const watchdogEnv = await renderWatchdogEnv(root);
  const files = [
    ["agent/watchdog.env", watchdogEnv, 0o644],
    ["README.codex-watchdog.md", templates.watchdogReadme(), 0o644],
    ["agent/CODEX_TAKEOVER.md", templates.codexTakeover(), 0o644],
    ["agent/WATCHDOG_PROTOCOL.md", templates.watchdogProtocol(), 0o644],
    ["agent/prompts/wakeup.md", templates.wakeup(), 0o644],
    ["agent/schemas/watch_decision.schema.json", templates.schema(), 0o644],
    ["agent/schemas/bootstrap_conversation_turn.schema.json", templates.bootstrapConversationTurnSchema(), 0o644],
    ["agent/schemas/bootstrap_instantiation.schema.json", templates.bootstrapInstantiationSchema(), 0o644],
    ["agent/schemas/state.schema.json", templates.stateSchema(), 0o644],
    ["agent/schemas/task_box.schema.json", templates.taskBoxSchema(), 0o644],
    ["agent/schemas/route_canonical.schema.json", templates.routeCanonicalSchema(), 0o644],
    ["agent/schemas/secondary_skills.schema.json", templates.secondarySkillsSchema(), 0o644],
    ["agent/schemas/job.schema.json", templates.jobSchema(), 0o644],
    ["agent/schemas/gate.schema.json", templates.gateSchema(), 0o644],
    ["agent/TASK_BOX.json", templates.taskBoxJson(), 0o644],
    ["agent/ROUTE_CANONICAL.json", templates.routeCanonicalJson(), 0o644],
    ["agent/EVIDENCE_LEDGER.jsonl", templates.evidenceLedgerJsonl(), 0o644],
    ["agent/SECONDARY_SKILLS.example.json", templates.secondarySkillsExample(), 0o644],
    ["agent/bin/collect_status.sh", templates.collectStatus(root), 0o755],
    ["agent/bin/make_prompt.sh", templates.makePrompt(root), 0o755],
    ["agent/bin/run_watchdog.sh", templates.runWatchdog(root), 0o755],
    ["agent/bin/watchdog", templates.watchdogCli(root), 0o755],
    ["agent/bin/watchdog_timer.sh", templates.watchdogTimer(root), 0o755],
    ["agent/bin/watchdog_guard.sh", templates.watchdogGuard(root), 0o755],
    ["agent/bin/render_report.py", templates.renderReport(), 0o755],
    ["agent/bin/route_skill.py", templates.routeSkill(), 0o755],
    ["agent/bin/validate_runtime.py", templates.validateRuntime(), 0o755]
  ];
  for (const [rel, content] of generatedSkillFiles()) {
    files.push([rel, content, 0o644]);
  }
  return files.map(([rel, content, mode]) => ({
    rel,
    file: path.join(root, rel),
    content,
    mode
  }));
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function generatedManifestContent(entries) {
  const templateHashes = {};
  for (const entry of entries.slice().sort((a, b) => a.rel.localeCompare(b.rel))) {
    templateHashes[entry.rel] = `sha256:${sha256Text(entry.content)}`;
  }
  return `${JSON.stringify({
    schema_version: 1,
    control_plane_module: "codex-watchdog-vscode",
    control_plane_version: packageMetadata.version,
    generated_at: new Date().toISOString(),
    placeholder_policy: {
      public_paths: ["$PROJECT_ROOT", "$CONTROL_PLANE_ROOT", "$COLLAB_ROOT"]
    },
    template_hashes: templateHashes
  }, null, 2)}\n`;
}

async function writeGeneratedManifest(root, entries) {
  const manifest = path.join(root, "agent", "status", "generated_manifest.json");
  await ensureDir(path.dirname(manifest));
  await fsp.writeFile(manifest, generatedManifestContent(entries));
  return manifest;
}

async function refreshGeneratedWatcherFiles(root) {
  await ensureCodexHome(root);
  const files = await generatedWatcherFileEntries(root);
  for (const { file, content, mode } of files) {
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, content);
    await fsp.chmod(file, mode);
    output.appendLine(`Refreshed ${path.relative(root, file)}`);
  }
  await writeGeneratedManifest(root, files);
  output.appendLine("Refreshed agent/status/generated_manifest.json");

	  const runtimeState = path.join(root, "agent", "RUNTIME_STATE.md");
	  if (!fs.existsSync(runtimeState)) {
	    await fsp.writeFile(runtimeState, templates.runtimeState());
	    output.appendLine("Created agent/RUNTIME_STATE.md");
	  }
  await ensureCollaborationHandoffFiles(root);
  const stateJson = path.join(root, "agent", "STATE.json");
  if (!fs.existsSync(stateJson)) {
    await fsp.writeFile(stateJson, templates.stateJson());
    output.appendLine("Created agent/STATE.json");
  }
  const progressState = path.join(root, "agent", "PROGRESS_STATE.json");
  if (!fs.existsSync(progressState)) {
    await fsp.writeFile(progressState, templates.progressStateJson());
    output.appendLine("Created agent/PROGRESS_STATE.json");
  }
  const queueStatus = path.join(root, "agent", "status", "QUEUE_STATUS.md");
  if (!fs.existsSync(queueStatus)) {
    await fsp.writeFile(queueStatus, templates.queueStatus());
    output.appendLine("Created agent/status/QUEUE_STATUS.md");
  }
  const researchLedger = path.join(root, "research", "RESEARCH_LEDGER.md");
  if (!fs.existsSync(researchLedger)) {
    await ensureDir(path.dirname(researchLedger));
    await fsp.writeFile(researchLedger, templates.researchLedger());
    output.appendLine("Created research/RESEARCH_LEDGER.md");
  }
  const ledgerNotes = path.join(root, "research", "LEDGER_NOTES.md");
  if (!fs.existsSync(ledgerNotes)) {
    await ensureDir(path.dirname(ledgerNotes));
    await fsp.writeFile(ledgerNotes, templates.ledgerNotes());
    output.appendLine("Created research/LEDGER_NOTES.md");
  }
	  const taskRequest = path.join(root, "agent", "TASK_REQUEST.md");
	  if (!fs.existsSync(taskRequest)) {
	    await fsp.writeFile(taskRequest, templates.taskRequest());
	    output.appendLine("Created agent/TASK_REQUEST.md");
	  }
  const workspaceWritePolicyExample = path.join(root, "agent", "workspace_write_policy.example.json");
  if (!fs.existsSync(workspaceWritePolicyExample)) {
    await fsp.writeFile(workspaceWritePolicyExample, templates.workspaceWritePolicyExample());
    output.appendLine("Created agent/workspace_write_policy.example.json");
  }
  const secondarySkillsExample = path.join(root, "agent", "SECONDARY_SKILLS.example.json");
  if (!fs.existsSync(secondarySkillsExample)) {
    await fsp.writeFile(secondarySkillsExample, templates.secondarySkillsExample());
    output.appendLine("Created agent/SECONDARY_SKILLS.example.json");
  }
  await ensureHandoffFiles(root);
}

async function ensureCollaborationHandoffFiles(root) {
  const files = [
    ["agent/CURRENT_STATE.md", templates.currentState()],
    ["agent/RUN_STATE.json", templates.runStateJson()],
    ["agent/TASK_BOX.json", templates.taskBoxJson()],
    ["agent/ROUTE_CANONICAL.json", templates.routeCanonicalJson()],
    ["agent/NEXT_ACTION.md", templates.nextAction()],
    ["agent/BLOCKERS.md", templates.blockers()],
    ["agent/REVIEW_PENDING.md", templates.reviewPending()],
    ["agent/ANTI_SNOWBALL.md", templates.antiSnowball()],
    ["agent/EXPERIMENT_LEDGER.md", templates.experimentLedger()],
    ["agent/EVIDENCE_LEDGER.jsonl", templates.evidenceLedgerJsonl()]
  ];
  for (const [rel, content] of files) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      await ensureDir(path.dirname(file));
      await fsp.writeFile(file, content);
      output.appendLine(`Created ${rel}`);
    }
  }
}

async function ensureHandoffFiles(root) {
  const dailyHandoff = path.join(root, "agent", "DAILY_HANDOFF.md");
  if (!fs.existsSync(dailyHandoff)) {
    await fsp.writeFile(dailyHandoff, templates.dailyHandoff());
    output.appendLine("Created agent/DAILY_HANDOFF.md");
  }

  const morningBrief = path.join(root, "agent", "MORNING_BRIEF.md");
  if (!fs.existsSync(morningBrief)) {
    await fsp.writeFile(morningBrief, templates.morningBrief());
    output.appendLine("Created agent/MORNING_BRIEF.md");
  }
}

async function writeSystemdUnits(root, units) {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  await ensureDir(unitDir);

  validateUnitName(units.service, ".service");
  validateUnitName(units.timer, ".timer");

  const settings = await effectiveWatchdogSettings(root);
  const interval = settings.intervalMinutes;
  const timeout = settings.timeoutMinutes;
  const codexBin = settings.codexBin;
  const codexHome = settings.codexHome;
  const sandboxMode = settings.sandboxMode;
  const compactEveryRuns = settings.compactEveryRuns;
  const role = settings.role;
  const phaseOffsetMinutes = settings.phaseOffsetMinutes;
  const supervisorLightFollowup = settings.supervisorLightFollowup ? "1" : "0";
  const supervisorAuditEveryRunnerRuns = settings.supervisorAuditEveryRunnerRuns;

  const service = [
    "[Unit]",
    `Description=Codex project watcher for ${path.basename(root)}`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${systemdPathValue(root)}`,
    `ExecStart=${systemdQuote("/usr/bin/env")} bash ${systemdQuote(path.join(root, "agent", "bin", "run_watchdog.sh"))}`,
    `Environment=CODEX_BIN=${systemdEnvValue(codexBin)}`,
    `Environment=CODEX_HOME=${systemdEnvValue(codexHome)}`,
    `Environment=CODEX_SANDBOX_MODE=${systemdEnvValue(sandboxMode)}`,
    `Environment=WATCHDOG_TIMEOUT_MINUTES=${timeout}`,
    `Environment=WATCHDOG_COMPACT_EVERY_RUNS=${compactEveryRuns}`,
    `Environment=WATCHDOG_ROLE=${systemdEnvValue(role)}`,
    `Environment=WATCHDOG_PHASE_OFFSET_MINUTES=${phaseOffsetMinutes}`,
    `Environment=WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=${supervisorLightFollowup}`,
    `Environment=WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=${supervisorAuditEveryRunnerRuns}`,
    "Environment=CUDA_VISIBLE_DEVICES=",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    `TimeoutStartSec=${timeout}min`,
    ""
  ].join("\n");

  const timer = [
    "[Unit]",
    `Description=Run Codex project watcher every ${interval} minutes for ${path.basename(root)}`,
    "",
    "[Timer]",
    `OnActiveSec=${phaseOffsetMinutes}min`,
    `OnUnitActiveSec=${interval}min`,
    "AccuracySec=1min",
    `Unit=${units.service}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    ""
  ].join("\n");

  await fsp.writeFile(path.join(unitDir, units.service), service);
  await fsp.writeFile(path.join(unitDir, units.timer), timer);
  output.appendLine(`Wrote ${path.join(unitDir, units.service)}`);
  output.appendLine(`Wrote ${path.join(unitDir, units.timer)}`);
}

async function ensureCodexHome(root) {
  let plan = codexHomePlan(root);
  if (plan.requiresProjectSettingUpdate) {
    await updateProjectSetting(root, "codexWatchdog.codexHome", plan.effectivePath);
    output.appendLine(`[warning] ${plan.migrationReason}`);
    vscode.window.showInformationMessage(`Codex Watchdog moved this project's watcher home to ${plan.effectivePath}. Reinstall the timer after review so systemd uses the migrated CODEX_HOME.`);
    plan = codexHomePlan(root);
  }
  const codexHome = plan.effectivePath;
  await ensureDir(codexHome);
  const configPath = path.join(codexHome, "config.toml");
  const profileDefaults = watcherProfileModelDefaults();
  if (!fs.existsSync(configPath)) {
    const merged = mergeWatcherConfigText("", profileDefaults);
    await fsp.writeFile(configPath, merged.text);
    output.appendLine(`Wrote ${configPath}`);
    if (merged.inheritedModel) {
      output.appendLine("Seeded watcher model config from the main Codex profile.");
    }
  } else {
    const existing = await fsp.readFile(configPath, "utf8");
    const merged = mergeWatcherConfigText(existing, profileDefaults);
    if (merged.changed) {
      await fsp.writeFile(configPath, merged.text);
      output.appendLine(`Updated ${configPath}`);
      if (merged.inheritedModel && !hasTomlAssignment(existing, "model")) {
        output.appendLine("Seeded missing watcher model config from the main Codex profile.");
      }
    }
  }
}

function inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome = path.join(os.homedir(), ".codex")) {
  const authPath = path.join(watcherHome, "auth.json");
  const configPath = path.join(watcherHome, "config.toml");
  const modelsCachePath = path.join(watcherHome, "models_cache.json");
  const mainAuthPath = path.join(mainCodexHome, "auth.json");
  const mainModelsCachePath = path.join(mainCodexHome, "models_cache.json");
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const model = parseTomlBasicString(configText, "model");
  const modelReasoningEffort = parseTomlBasicString(configText, "model_reasoning_effort");
  const authExists = fs.existsSync(authPath);
  const mainAuthExists = fs.existsSync(mainAuthPath);
  const modelsCacheExists = fs.existsSync(modelsCachePath);
  const mainModelsCacheExists = fs.existsSync(mainModelsCachePath);
  const signals = [];

  if (!authExists) {
    signals.push("This watcher home does not have auth.json yet.");
    if (mainAuthExists) {
      signals.push("Your main ~/.codex profile is already logged in, so you can seed this watcher home locally or open a dedicated login terminal.");
    } else {
      signals.push("Open Login Terminal to create login state inside this CODEX_HOME.");
    }
  }
  if (!model) {
    signals.push("This watcher home does not declare a model in config.toml yet.");
  }
  if (authExists && !modelsCacheExists && mainModelsCacheExists) {
    signals.push("models_cache.json is still missing here; a local seed from ~/.codex can warm it up.");
  }

  return {
    watcherHome,
    authPath,
    configPath,
    modelsCachePath,
    model,
    modelReasoningEffort,
    authExists,
    configExists: fs.existsSync(configPath),
    modelsCacheExists,
    mainCodexHome,
    mainAuthPath,
    mainModelsCachePath,
    mainAuthExists,
    mainModelsCacheExists,
    canSeedFromMainAuth: mainAuthExists && (!authExists || !modelsCacheExists),
    bootstrapText: signals.join("\n"),
  };
}

function inspectWatcherHomeBootstrap(root) {
  return inspectWatcherHomeBootstrapState(codexHomeSetting(root));
}

async function seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome = path.join(os.homedir(), ".codex")) {
  await ensureDir(watcherHome);
  const copied = [];
  for (const fileName of ["auth.json", "models_cache.json"]) {
    const source = path.join(mainCodexHome, fileName);
    if (!fs.existsSync(source)) {
      continue;
    }
    const target = path.join(watcherHome, fileName);
    await fsp.copyFile(source, target);
    copied.push(fileName);
  }
  return {
    watcherHome,
    mainCodexHome,
    copied,
    copiedAuth: copied.includes("auth.json"),
    copiedModelsCache: copied.includes("models_cache.json"),
  };
}

async function seedWatcherHomeAuthFromMainProfile(root) {
  return seedWatcherHomeBootstrapFromProfilePaths(codexHomeSetting(root));
}

async function getCodexLoginStatus(root) {
  try {
    const codexBin = await resolveCodexBin(root);
    const codexHome = codexHomeSetting(root);
    const bootstrap = inspectWatcherHomeBootstrapState(codexHome);
    const result = await run(codexBin, ["login", "status"], {
      cwd: root,
      env: { CODEX_HOME: codexHome },
      allowFailure: true,
      timeout: 10000
    });
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const statusText = combined || (result.error ? result.error.message : "");
    const spawnMissing = result.error && (result.error.code === "ENOENT" || /ENOENT/.test(statusText));
    const ok = !result.error && LOGIN_READY_RE.test(statusText);

    if (ok) {
      return {
        ok: true,
        bootstrapText: bootstrap.bootstrapText,
        canSeedFromMainAuth: bootstrap.canSeedFromMainAuth,
        text: [
          statusText,
          "",
          `Watcher auth: ${bootstrap.authExists ? "present" : "missing"}`,
          `Watcher model: ${bootstrap.model || "not set"}`,
          bootstrap.modelReasoningEffort ? `Reasoning effort: ${bootstrap.modelReasoningEffort}` : "",
          `CODEX_HOME=${codexHome}`,
          `CODEX_BIN=${codexBin}`
        ].filter(Boolean).join("\n")
      };
    }

    return {
      ok: false,
      bootstrapText: bootstrap.bootstrapText,
      canSeedFromMainAuth: bootstrap.canSeedFromMainAuth,
      text: [
        spawnMissing
          ? "Codex CLI executable was not found for watchdog mode."
          : "Codex login is not ready for watchdog mode.",
        statusText || "No login status output was returned.",
        "",
        `Watcher auth: ${bootstrap.authExists ? "present" : "missing"}`,
        `Watcher model: ${bootstrap.model || "not set"}`,
        bootstrap.modelReasoningEffort ? `Reasoning effort: ${bootstrap.modelReasoningEffort}` : "",
        `CODEX_HOME=${codexHome}`,
        `CODEX_BIN=${codexBin}`
      ].filter(Boolean).join("\n")
    };
  } catch (error) {
    return {
      ok: false,
      text: `Could not check Codex login status: ${error.message || String(error)}`,
      bootstrapText: "",
      canSeedFromMainAuth: false
    };
  }
}

async function confirmLoginIfNeeded(root) {
  const login = await getCodexLoginStatus(root);
  if (login.ok) {
    return true;
  }

  const answer = await vscode.window.showWarningMessage(
    [
      login.text.includes("executable was not found")
        ? "Codex Watchdog could not find a Codex CLI executable."
        : "Codex Watchdog needs an OpenAI login before it can start unattended work.",
      "",
      ...(login.bootstrapText ? [login.bootstrapText, ""] : []),
      login.text,
      "",
      login.text.includes("executable was not found")
        ? "The project files and watchdog scripts are ready. Fix codexWatchdog.codexBin or install/enable the OpenAI Codex CLI, then run Start Guard again."
        : "The project files and watchdog scripts are ready. Complete login in the terminal, then run Start Guard again."
    ].join("\n"),
    { modal: true },
    ...(login.canSeedFromMainAuth ? ["Seed from Main Profile"] : []),
    "Open Login Terminal"
  );

  if (answer === "Seed from Main Profile") {
    const seeded = await seedWatcherHomeAuthFromMainProfile(root);
    if (!seeded.copiedAuth) {
      vscode.window.showWarningMessage("No ~/.codex/auth.json was found to seed this watcher home. Open Login Terminal instead.");
    } else {
      output.appendLine(`Seeded watcher auth bootstrap from ${seeded.mainCodexHome} into ${seeded.watcherHome}`);
      const recheck = await getCodexLoginStatus(root);
      if (recheck.ok) {
        vscode.window.showInformationMessage("Seeded watcher auth from the main Codex profile. Start Guard can continue now.");
        return true;
      }
      vscode.window.showWarningMessage("Seeded local watcher files, but this watcher home still needs a fresh login.");
    }
  }

  if (answer === "Open Login Terminal") {
    await openLoginTerminal(root);
    vscode.window.showInformationMessage("After OpenAI login finishes, click Codex Watchdog: Start Guard again.");
  }

  return false;
}

async function openLoginTerminal(rootArg) {
  const root = rootArg || await getProjectRoot();
  if (!root) {
    return;
  }
  await ensureCodexHome(root);
  const codexBin = await resolveCodexBin(root);
  const codexHome = codexHomeSetting(root);
  const terminal = vscode.window.createTerminal({
    name: "Codex Watchdog Login",
    cwd: root,
    env: {
      CODEX_BIN: codexBin,
      CODEX_HOME: codexHome,
      CUDA_VISIBLE_DEVICES: ""
    }
  });
  terminal.show();
  const projectCli = path.join(root, "agent", "bin", "watchdog");
  if (fs.existsSync(projectCli)) {
    terminal.sendText("./agent/bin/watchdog login; echo; ./agent/bin/watchdog status");
  } else {
    terminal.sendText(`CODEX_HOME=${shellQuote(codexHome)} ${shellQuote(codexBin)} login; echo; CODEX_HOME=${shellQuote(codexHome)} ${shellQuote(codexBin)} login status`);
  }
}

async function getTimerStatus(root) {
  try {
    const units = unitNames(root);
    const active = await run("systemctl", ["--user", "is-active", units.timer], { allowFailure: true, timeout: 5000 });
    const enabled = await run("systemctl", ["--user", "is-enabled", units.timer], { allowFailure: true, timeout: 5000 });
    const next = await run("systemctl", ["--user", "list-timers", units.timer, "--no-pager", "--no-legend"], { allowFailure: true, timeout: 5000 });

    const activeText = (active.stdout || active.stderr || "").trim() || "unknown";
    const enabledText = (enabled.stdout || enabled.stderr || "").trim() || "unknown";
    const nextText = (next.stdout || next.stderr || "").trim();
    const isActive = activeText === "active";
    const isEnabled = enabledText === "enabled";

    return {
      isActive,
      isEnabled,
      activeText,
      enabledText,
      nextText,
      needsReinstall: false,
      warningText: "",
      text: [
        units.timer,
        `active: ${activeText}`,
        `enabled: ${enabledText}`,
        nextText ? `next: ${nextText}` : "next: not scheduled or systemd user timer unavailable"
      ].join("\n")
    };
  } catch (error) {
    return {
      isActive: false,
      isEnabled: false,
      activeText: "unknown",
      enabledText: "unknown",
      nextText: "",
      needsReinstall: false,
      warningText: "",
      text: `Could not read timer status: ${error.message || String(error)}`
    };
  }
}

function showBootstrapResult(result) {
  output.show(true);
  output.appendLine(`# Codex Watchdog bootstrap ${new Date().toISOString()}`);
  output.appendLine(`Created ${result.created.length} files.`);
  for (const file of result.created) {
    output.appendLine(`  + ${file}`);
  }
  if (result.skipped.length) {
    output.appendLine(`Skipped ${result.skipped.length} existing files.`);
    for (const file of result.skipped) {
      output.appendLine(`  = ${file}`);
    }
  }
  vscode.window.showInformationMessage("Codex Watchdog project files are ready.");
}

async function writeIfAbsent(baseRoot, file, content, created, skipped) {
  const rel = path.relative(baseRoot, file);
  if (fs.existsSync(file)) {
    skipped.push(rel);
    return false;
  }
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, content);
  created.push(rel);
  return true;
}

function isWatchdogInitialized(root) {
  return fs.existsSync(path.join(root, "agent", "PLAN.md"))
    && fs.existsSync(path.join(root, "agent", "SAFETY.md"))
    && fs.existsSync(path.join(root, "agent", "bin", "run_watchdog.sh"));
}

async function isEffectivelyEmptyDir(root) {
  try {
    const entries = await fsp.readdir(root);
    return entries.filter((entry) => ![".git", ".DS_Store"].includes(entry)).length === 0;
  } catch (_error) {
    return false;
  }
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("Open a project folder first.");
  }
  return folders[0].uri.fsPath;
}

function getDefaultRootUri() {
  const configured = expandHome(extensionSetting("projectRoot", ""));
  if (configured && isExistingDirectory(configured) && isSafeProjectRootPath(configured)) {
    return vscode.Uri.file(configured);
  }
  const remembered = extensionContext && extensionContext.globalState.get(PROJECT_ROOT_KEY);
  if (remembered && isExistingDirectory(remembered) && isSafeProjectRootPath(remembered)) {
    return vscode.Uri.file(remembered);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri;
  }
  return vscode.Uri.file(os.homedir());
}

function getDefaultRootInputValue() {
  const configured = expandHome(extensionSetting("projectRoot", ""));
  if (configured && isSafeProjectRootPath(configured)) {
    return configured;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0 && isSafeProjectRootPath(folders[0].uri.fsPath)) {
    return folders[0].uri.fsPath;
  }
  return path.join(os.homedir(), "codex-watchdog-project");
}

async function selectProjectRoot(title) {
  const defaultRoot = getDefaultRootInputValue();
  const value = await vscode.window.showInputBox({
    title,
    prompt: "Enter an absolute Linux folder path. If it does not exist, Codex Watchdog can create it.",
    placeHolder: "/home/you/project",
    value: defaultRoot,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const expanded = expandHome(String(raw || "").trim());
      if (!expanded) {
        return "Enter a project folder path.";
      }
      if (!path.isAbsolute(expanded)) {
        return "Use an absolute Linux path, or ~/...";
      }
      try {
        validateProjectRootPath(expanded);
      } catch (error) {
        return error.message || String(error);
      }
      return undefined;
    }
  });
  return normalizeProjectRootInput(value, "Selected project root", { offerCreate: true });
}

async function browseExistingProjectRoot(title, raw) {
  const selected = await vscode.window.showOpenDialog({
    title,
    openLabel: "Select Folder",
    defaultUri: getBrowseDefaultUri(raw),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  if (!selected || selected.length === 0) {
    return undefined;
  }
  return requireExistingDirectory(selected[0].fsPath, "Selected project root");
}

function getBrowseDefaultUri(raw) {
  const expanded = expandHome(String(raw || "").trim());
  if (expanded && isExistingDirectory(expanded) && isSafeProjectRootPath(expanded)) {
    return vscode.Uri.file(expanded);
  }
  if (expanded && path.isAbsolute(expanded)) {
    let parent = path.dirname(expanded);
    while (parent && parent !== path.dirname(parent)) {
      if (isExistingDirectory(parent) && isSafeProjectRootPath(parent)) {
        return vscode.Uri.file(parent);
      }
      parent = path.dirname(parent);
    }
  }
  return getDefaultRootUri();
}

async function normalizeProjectRootInput(raw, label, options = {}) {
  const root = expandHome(String(raw || "").trim());
  if (!root) {
    return undefined;
  }
  validateProjectRootPath(root);
  if (!path.isAbsolute(root)) {
    throw new Error(`${label} must be an absolute Linux path: ${root}`);
  }
  if (!fs.existsSync(root)) {
    if (!options.offerCreate) {
      throw new Error(`${label} does not exist: ${root}`);
    }
    if (options.confirmCreate !== false) {
      const answer = await vscode.window.showWarningMessage(
        `${label} does not exist. Create it?\n${root}`,
        "Create Folder",
        "Cancel"
      );
      if (answer !== "Create Folder") {
        return undefined;
      }
    }
    await ensureDir(root);
  }
  return requireExistingDirectory(root, label);
}

async function getProjectRoot() {
  const configured = expandHome(extensionSetting("projectRoot", ""));
  if (configured) {
    return normalizeProjectRootInput(configured, "Configured codexWatchdog.projectRoot", { offerCreate: true });
  }

	  const remembered = extensionContext && extensionContext.globalState.get(PROJECT_ROOT_KEY);
	  if (remembered && fs.existsSync(remembered)) {
	    return requireExistingDirectory(remembered, "Remembered Codex Watchdog project root");
	  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const root = folders[0].uri.fsPath;
    const answer = await vscode.window.showInformationMessage(
      `No Codex Watchdog project root is selected. Use current workspace folder?\n${root}`,
      "Use Workspace",
      "Choose Folder"
    );
	    if (answer === "Use Workspace") {
	      const safeRoot = requireExistingDirectory(root, "Workspace folder");
	      await rememberProjectRoot(safeRoot);
	      return safeRoot;
	    }
  }

  const selected = await selectProjectRoot("Enter the project folder Codex Watchdog should control");
  if (!selected) {
    return undefined;
  }
  await rememberProjectRoot(selected);
  return selected;
}

async function rememberProjectRoot(root) {
  if (!extensionContext) {
    return;
  }
  await extensionContext.globalState.update(PROJECT_ROOT_KEY, root);
  output.appendLine(`Selected project root: ${root}`);
  await updateStatusBar();
}

async function clearRememberedProjectRoot() {
  if (!extensionContext) {
    return;
  }
  await extensionContext.globalState.update(PROJECT_ROOT_KEY, undefined);
  output.appendLine("Cleared remembered Codex Watchdog project root.");
  await updateStatusBar();
}

function config() {
  return vscode.workspace.getConfiguration("codexWatchdog");
}

function extensionSetting(key, fallback) {
  return extensionSettingWithSource(key, fallback).value;
}

function extensionSettingWithSource(key, fallback) {
  const inspected = config().inspect(key);
  if (!inspected) {
    return { value: fallback, source: "fallback" };
  }
  if (inspected.globalValue !== undefined) {
    return { value: inspected.globalValue, source: "global" };
  }
  if (inspected.defaultValue !== undefined) {
    return { value: inspected.defaultValue, source: "default" };
  }
  return { value: fallback, source: "fallback" };
}

function unitNames(root) {
  const prefix = servicePrefixSetting(root);
  const slug = projectSlug(root);
  const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
  const units = {
    service: `${prefix}-${slug}-${hash}.service`,
    timer: `${prefix}-${slug}-${hash}.timer`
  };
  validateUnitName(units.service, ".service");
  validateUnitName(units.timer, ".timer");
  return units;
}

function projectSlug(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

async function resolveCodexBin(root) {
  const setting = projectSettingWithSource(root, "codexWatchdog.codexBin", extensionSettingWithSource("codexBin", "codex"));
  const configured = String(setting.value || "codex");
  if (configured && configured !== "codex") {
    const expanded = expandHome(configured);
    validateConfiguredCodexBin(expanded);
    return expanded;
  }
  try {
    const result = await run("bash", ["-lc", "command -v codex"], { cwd: os.homedir() });
    const found = result.stdout.trim();
    if (found) {
      return found;
    }
  } catch (_error) {
    // Fall through to the VSCode OpenAI extension binary search below.
  }
  const extensionCodex = findOpenAICodexExtensionBinary();
  return extensionCodex || "codex";
}

function findOpenAICodexExtensionBinary() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode", "extensions")
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const extensionDir of fs.readdirSync(root)) {
      if (!/^openai\.chatgpt-/.test(extensionDir)) {
        continue;
      }
      const binRoot = path.join(root, extensionDir, "bin");
      if (!fs.existsSync(binRoot)) {
        continue;
      }
      for (const platformDir of fs.readdirSync(binRoot)) {
        if (!/^linux-/.test(platformDir)) {
          continue;
        }
        const candidate = path.join(binRoot, platformDir, "codex");
        if (!fs.existsSync(candidate)) {
          continue;
        }
        try {
          validateConfiguredCodexBin(candidate);
          candidates.push(candidate);
        } catch (_error) {
          // Ignore non-executable or non-allowlisted candidates.
        }
      }
    }
  }
  return candidates.sort().at(-1) || "";
}

function validateConfiguredCodexBin(value) {
  if (!path.isAbsolute(value)) {
    throw new Error(`codexWatchdog.codexBin must be "codex" or an allowed absolute path: ${value}`);
  }
  if (path.basename(value) !== "codex") {
    throw new Error(`codexWatchdog.codexBin must point to an executable named codex: ${value}`);
  }

  const normalized = path.normalize(value);
  const home = os.homedir();
  const exactAllowed = [
    path.join(home, ".local", "bin", "codex"),
    "/usr/bin/codex",
    "/usr/local/bin/codex",
    "/bin/codex"
  ];
  if (exactAllowed.includes(normalized) || isOpenAICodexExtensionPath(normalized, path.join(home, ".vscode-server", "extensions")) || isOpenAICodexExtensionPath(normalized, path.join(home, ".vscode", "extensions"))) {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) {
      throw new Error(`codexWatchdog.codexBin is not a file: ${value}`);
    }
    if ((stat.mode & 0o111) === 0) {
      throw new Error(`codexWatchdog.codexBin is not executable: ${value}`);
    }
    return;
  }

  throw new Error(`Refusing codexWatchdog.codexBin outside allowed locations: ${value}`);
}

function isOpenAICodexExtensionPath(value, extensionRoot) {
  const relative = path.relative(path.resolve(extensionRoot), path.resolve(value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(path.sep);
  return parts.length === 4
    && /^openai\.chatgpt-/.test(parts[0])
    && parts[1] === "bin"
    && /^linux-/.test(parts[2])
    && parts[3] === "codex";
}

function projectSetting(root, key, fallback) {
  return projectSettingWithSource(root, key, fallback).value;
}

function projectSettingWithSource(root, key, fallback) {
  const projectSettings = readProjectSettings(root);
  if (Object.prototype.hasOwnProperty.call(projectSettings, key)) {
    return { value: projectSettings[key], source: "project" };
  }
  if (fallback && typeof fallback === "object" && Object.prototype.hasOwnProperty.call(fallback, "value")) {
    return fallback;
  }
  return { value: fallback, source: "extension" };
}

function positiveNumberSetting(root, key, fallback, min, hardFallback) {
  const raw = projectSetting(root, key, fallback);
  const value = Number(raw);
  if (Number.isInteger(value) && value >= min) {
    return value;
  }
  output.appendLine(`[warning] Ignoring invalid ${key}=${JSON.stringify(raw)}; using ${hardFallback}.`);
  return hardFallback;
}

function booleanSetting(root, key, fallback, hardFallback) {
  const raw = projectSetting(root, key, fallback);
  if (raw === true || raw === false) {
    return raw;
  }
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(value)) {
      return false;
    }
  }
  output.appendLine(`[warning] Ignoring invalid ${key}=${JSON.stringify(raw)}; using ${hardFallback}.`);
  return hardFallback;
}

function sandboxModeSetting(root) {
  const value = String(projectSetting(root, "codexWatchdog.sandboxMode", extensionSetting("sandboxMode", "read-only")) || "read-only");
  if (value === "read-only") {
    return value;
  }
  if (value === "workspace-write") {
    if (workspaceWritePolicyAllowed(root)) {
      return value;
    }
    output.appendLine("[warning] workspace-write requested but agent/workspace_write_policy.json is missing or invalid; using read-only.");
    return "read-only";
  }
  output.appendLine(`[warning] Ignoring invalid codexWatchdog.sandboxMode=${JSON.stringify(value)}; using read-only.`);
  return "read-only";
}

function watchdogRoleSetting(root) {
  const value = String(projectSetting(root, "codexWatchdog.role", extensionSetting("role", DEFAULT_WATCHDOG_ROLE)) || DEFAULT_WATCHDOG_ROLE).toLowerCase();
  if (value === "runner" || value === "supervisor") {
    return value;
  }
  output.appendLine(`[warning] Ignoring invalid codexWatchdog.role=${JSON.stringify(value)}; using ${DEFAULT_WATCHDOG_ROLE}.`);
  return DEFAULT_WATCHDOG_ROLE;
}

function workspaceWritePolicyAllowed(root) {
  const policyPath = path.join(root, "agent", "workspace_write_policy.json");
  if (!fs.existsSync(policyPath)) {
    return false;
  }
  try {
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    if (!policy || policy.enabled !== true) {
      return false;
    }
    if (!Array.isArray(policy.writable_paths) || policy.writable_paths.length === 0) {
      return false;
    }
    if (!Array.isArray(policy.allowed_commands) || policy.allowed_commands.length === 0) {
      return false;
    }
    for (const rel of policy.writable_paths) {
      if (typeof rel !== "string" || !rel.trim() || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..") || /[\x00-\x1F\x7F]/.test(rel)) {
        return false;
      }
    }
    for (const command of policy.allowed_commands) {
      if (typeof command !== "string" || !command.trim() || /[\x00-\x08\x0B-\x1F\x7F]/.test(command)) {
        return false;
      }
    }
    return true;
  } catch (error) {
    output.appendLine(`[warning] Could not read agent/workspace_write_policy.json: ${error.message || String(error)}`);
    return false;
  }
}

function codexHomeSetting(root) {
  return codexHomePlan(root).effectivePath;
}

function codexHomePlan(root) {
  const setting = projectSettingWithSource(root, "codexWatchdog.codexHome", extensionSettingWithSource("codexHome", "~/.codex-watcher"));
  const expanded = expandHome(String(setting.value || "~/.codex-watcher"));
  if (!path.isAbsolute(expanded)) {
    throw new Error(`codexWatchdog.codexHome must be an absolute path or ~/ path: ${setting.value}`);
  }
  if (/[\x00-\x1F\x7F%]/.test(expanded)) {
    throw new Error(`codexWatchdog.codexHome contains characters unsafe for generated systemd units: ${expanded}`);
  }
  const home = os.homedir();
  const normalized = path.normalize(expanded);
  const plan = {
    configuredPath: expanded,
    effectivePath: expanded,
    source: setting.source,
    migrationReason: "",
    requiresProjectSettingUpdate: false
  };
  const realHome = fs.realpathSync(home);
  const realTarget = realpathForPotentialPath(normalized);
  if (setting.source === "project" && realTarget === realHome) {
    throw new Error("Refusing project-local codexWatchdog.codexHome equal to the home directory.");
  }
  if (setting.source === "project" && !isPathInside(realTarget, realHome)) {
    const logicalRoot = path.resolve(root);
    const realRoot = realpathForPotentialPath(logicalRoot);
    const targetInsideSelectedProject = isPathInside(normalized, logicalRoot) || isPathInside(realTarget, realRoot);
    if (targetInsideSelectedProject) {
      plan.effectivePath = defaultProjectWatcherHome(root);
      plan.migrationReason = [
        "Project-local codexWatchdog.codexHome resolved outside the current user's home after realpath.",
        `Using ${plan.effectivePath} instead so bind-mounted server workspaces still get a safe watcher home.`
      ].join(" ");
      plan.requiresProjectSettingUpdate = plan.effectivePath !== plan.configuredPath;
    } else {
      throw new Error(`Refusing project-local codexWatchdog.codexHome outside the current user's home: ${expanded}`);
    }
  }
  const effectiveRealTarget = realpathForPotentialPath(path.normalize(plan.effectivePath));
  for (const blocked of [
    "/etc",
    "/root",
    "/bin",
    "/sbin",
    "/usr",
    "/lib",
    "/lib64",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
    "/run",
    path.join(home, ".ssh"),
    path.join(home, ".config", "systemd"),
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode", "extensions")
  ]) {
    const realBlocked = fs.existsSync(blocked)
      ? fs.realpathSync(blocked)
      : realpathForPotentialPath(blocked);
    if (isPathInside(effectiveRealTarget, realBlocked)) {
      throw new Error(`Refusing project-local codexWatchdog.codexHome inside protected path: ${plan.effectivePath}`);
    }
  }
  return plan;
}

function defaultProjectWatcherHome(root) {
  return path.join(os.homedir(), ".codex-watchers", projectSlug(root));
}

function servicePrefixSetting(root) {
  const raw = String(projectSetting(root, "codexWatchdog.servicePrefix", extensionSetting("servicePrefix", DEFAULT_SERVICE_PREFIX)) || DEFAULT_SERVICE_PREFIX);
  if (!isSafeServicePrefix(raw)) {
    throw new Error(`Invalid codexWatchdog.servicePrefix: ${raw}. Use only A-Z, a-z, 0-9, _, ., @, and -, without "..".`);
  }
  return raw;
}

function isSafeServicePrefix(value) {
  return /^[A-Za-z0-9_.@-]+$/.test(value) && !value.includes("..");
}

function validateUnitName(name, suffix) {
  if (path.basename(name) !== name || name.includes("/") || name.includes("\\") || name.includes("..") || !name.endsWith(suffix) || !/^[A-Za-z0-9_.@-]+$/.test(name)) {
    throw new Error(`Unsafe generated systemd unit name: ${name}`);
  }
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isExistingDirectory(value) {
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory();
  } catch (_error) {
    return false;
  }
}

function requireExistingDirectory(value, label) {
  const expanded = expandHome(String(value || ""));
  validateProjectRootPath(expanded);
  if (!fs.existsSync(expanded)) {
    throw new Error(`${label} does not exist: ${expanded}`);
  }
  if (!fs.statSync(expanded).isDirectory()) {
    throw new Error(`${label} is not a directory: ${expanded}`);
  }
  return expanded;
}

function isSafeProjectRootPath(value) {
  try {
    validateProjectRootPath(value);
    return true;
  } catch (_error) {
    return false;
  }
}

function validateProjectRootPath(value) {
  if (!path.isAbsolute(value)) {
    throw new Error(`Project root must be an absolute Linux path: ${value}`);
  }
  if (/[\x00-\x1F\x7F%]/.test(value)) {
    throw new Error(`Project root contains characters unsafe for generated systemd units: ${value}`);
  }
}

function realpathForPotentialPath(target) {
  const resolved = path.resolve(target);
  let current = resolved;
  const missing = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing parent directory for path: ${target}`);
    }
    missing.unshift(path.basename(current));
    current = parent;
  }

  const realBase = fs.realpathSync(current);
  return missing.length ? path.join(realBase, ...missing) : realBase;
}

function readProjectSettings(root) {
  const settingsPath = path.join(root, ".vscode", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(fs.readFileSync(settingsPath, "utf8")));
  } catch (error) {
    output.appendLine(`[warning] Could not parse ${settingsPath} as JSON/JSONC: ${error.message}`);
    return {};
  }
}

async function updateProjectSetting(root, key, value) {
  const settingsDir = path.join(root, ".vscode");
  const settingsPath = path.join(settingsDir, "settings.json");
  await ensureDir(settingsDir);
  const settings = readProjectSettings(root);
  settings[key] = value;
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  output.appendLine(`Updated ${path.relative(root, settingsPath)}: ${key}=${JSON.stringify(value)}`);
}

function parseTomlBasicString(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*$`, "m"));
  if (!match) {
    return "";
  }
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function hasTomlAssignment(text, key) {
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(String(text || ""));
}

function tomlStringLiteral(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function insertRootTomlAssignments(text, assignments) {
  const lines = assignments.filter(Boolean);
  if (!lines.length) {
    return String(text || "");
  }
  const source = String(text || "");
  const withTrailingNewline = source.endsWith("\n") ? source : `${source}\n`;
  const sectionMatch = withTrailingNewline.match(/^\s*\[[^\n]+\]\s*$/m);
  if (!sectionMatch) {
    const prefix = withTrailingNewline.trimEnd();
    return `${prefix}${prefix ? "\n" : ""}${lines.join("\n")}\n`;
  }
  const before = withTrailingNewline.slice(0, sectionMatch.index).trimEnd();
  const after = withTrailingNewline.slice(sectionMatch.index).trimStart();
  return `${before}${before ? "\n" : ""}${lines.join("\n")}\n\n${after}`;
}

function ensureHooksFeature(text) {
  const source = String(text || "");
  if (/^\s*hooks\s*=/m.test(source)) {
    return source;
  }
  if (/^\s*\[features\]\s*$/m.test(source)) {
    return source.replace(/(^\s*\[features\]\s*$)/m, "$1\nhooks = true");
  }
  const prefix = source.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}[features]\nhooks = true\n`;
}

function watcherProfileModelDefaults() {
  const profilePath = path.join(os.homedir(), ".codex", "config.toml");
  if (!fs.existsSync(profilePath)) {
    return { model: "", modelReasoningEffort: "" };
  }
  try {
    const text = fs.readFileSync(profilePath, "utf8");
    return {
      model: parseTomlBasicString(text, "model"),
      modelReasoningEffort: parseTomlBasicString(text, "model_reasoning_effort")
    };
  } catch (_error) {
    return { model: "", modelReasoningEffort: "" };
  }
}

function mergeWatcherConfigText(existingText, profileDefaults = watcherProfileModelDefaults()) {
  let next = String(existingText || "");
  let changed = false;

  const migratedHooks = next.replace(/(^|\n)codex_hooks\s*=\s*true(\s*(?:\n|$))/g, "$1hooks = true$2");
  if (migratedHooks !== next) {
    next = migratedHooks;
    changed = true;
  }

  const rootAssignments = [];
  if (!hasTomlAssignment(next, "approval_policy")) {
    rootAssignments.push('approval_policy = "never"');
  }
  if (!hasTomlAssignment(next, "sandbox_mode")) {
    rootAssignments.push('sandbox_mode = "read-only"');
  }
  if (!hasTomlAssignment(next, "allow_login_shell")) {
    rootAssignments.push("allow_login_shell = false");
  }
  if (profileDefaults.model && !hasTomlAssignment(next, "model")) {
    rootAssignments.push(`model = ${tomlStringLiteral(profileDefaults.model)}`);
  }
  if (profileDefaults.modelReasoningEffort && !hasTomlAssignment(next, "model_reasoning_effort")) {
    rootAssignments.push(`model_reasoning_effort = ${tomlStringLiteral(profileDefaults.modelReasoningEffort)}`);
  }
  if (rootAssignments.length) {
    next = insertRootTomlAssignments(next, rootAssignments);
    changed = true;
  }

  const withHooks = ensureHooksFeature(next);
  if (withHooks !== next) {
    next = withHooks;
    changed = true;
  }

  return {
    text: next.endsWith("\n") ? next : `${next}\n`,
    changed,
    inheritedModel: Boolean(profileDefaults.model),
    inheritedReasoning: Boolean(profileDefaults.modelReasoningEffort)
  };
}

function userSystemdUnitDir() {
  return path.join(os.homedir(), ".config", "systemd", "user");
}

function readWatcherUnitDrift(root, settings, unitDir = userSystemdUnitDir()) {
  const units = unitNames(root);
  const servicePath = path.join(unitDir, units.service);
  const timerPath = path.join(unitDir, units.timer);
  if (!fs.existsSync(servicePath) || !fs.existsSync(timerPath)) {
    return {
      installed: false,
      needsReinstall: false,
      reasons: [],
      text: ""
    };
  }
  const serviceText = fs.readFileSync(servicePath, "utf8");
  const timerText = fs.readFileSync(timerPath, "utf8");
  const checks = [
    [`Environment=CODEX_BIN=${systemdEnvValue(settings.codexBin)}`, "Codex binary"],
    [`Environment=CODEX_HOME=${systemdEnvValue(settings.codexHome)}`, "Codex home"],
    [`Environment=CODEX_SANDBOX_MODE=${systemdEnvValue(settings.sandboxMode)}`, "sandbox mode"],
    [`Environment=WATCHDOG_TIMEOUT_MINUTES=${settings.timeoutMinutes}`, "timeout minutes"],
    [`Environment=WATCHDOG_COMPACT_EVERY_RUNS=${settings.compactEveryRuns}`, "compact cadence"],
    [`Environment=WATCHDOG_ROLE=${systemdEnvValue(settings.role)}`, "watchdog role"],
    [`Environment=WATCHDOG_PHASE_OFFSET_MINUTES=${settings.phaseOffsetMinutes}`, "phase offset"],
    [`Environment=WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=${settings.supervisorLightFollowup ? "1" : "0"}`, "supervisor light followup"],
    [`Environment=WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=${settings.supervisorAuditEveryRunnerRuns}`, "supervisor audit cadence"]
  ];
  const reasons = [];
  for (const [needle, label] of checks) {
    if (!serviceText.includes(needle)) {
      reasons.push(`${label} differs from the installed service`);
    }
  }
  if (!timerText.includes(`OnActiveSec=${settings.phaseOffsetMinutes}min`)) {
    reasons.push("phase offset differs from the installed timer");
  }
  if (!timerText.includes(`OnUnitActiveSec=${settings.intervalMinutes}min`)) {
    reasons.push("repeat interval differs from the installed timer");
  }
  return {
    installed: true,
    needsReinstall: reasons.length > 0,
    reasons,
    text: reasons.length
      ? `Installed timer units still reference older watchdog settings. Re-run Start Guard or ./agent/bin/watchdog timer-install.\n- ${reasons.join("\n- ")}`
      : ""
  };
}

function readJsonFileIfExists(file, fallback = null) {
  if (!fs.existsSync(file)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function countVisibleEntries(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name && !name.startsWith(".")).length;
  } catch (_error) {
    return 0;
  }
}

function markdownFieldValue(text, label) {
  const match = String(text || "").match(new RegExp(`^\\s*[-*]?\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im"));
  return match ? match[1].trim() : "";
}

function isTruthyMarkdownValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["true", "yes", "1", "on"].includes(normalized);
}

function inspectProjectRuntimeClarity(root) {
  const signals = [];
  const pauseFile = path.join(root, "agent", "control", "PAUSE");
  if (fs.existsSync(pauseFile)) {
    const pauseText = readFilePrefix(pauseFile, 2048).trim();
    signals.push({
      level: "warn",
      text: [
        "The guard is paused by agent/control/PAUSE.",
        pauseText || "Open Resume Guard when you want timer wakeups to call Codex again."
      ].join("\n")
    });
  }

  const runState = readJsonFileIfExists(path.join(root, "agent", "RUN_STATE.json"), {});
  if (runState && runState.blocker_type === "stale_state") {
    signals.push({
      level: "warn",
      text: "RUN_STATE.json currently reports blocker_type=stale_state. Treat old failed/preflight records as historical until BLOCKERS.md or the latest report says they are still active."
    });
  }

  const reviewPendingPath = path.join(root, "agent", "REVIEW_PENDING.md");
  if (fs.existsSync(reviewPendingPath)) {
    const reviewText = fs.readFileSync(reviewPendingPath, "utf8");
    const state = markdownFieldValue(reviewText, "state");
    const pendingSend = isTruthyMarkdownValue(markdownFieldValue(reviewText, "pending_send"));
    const requiresHuman = isTruthyMarkdownValue(markdownFieldValue(reviewText, "requires_human_review"));
    if (state === "pending_send" || pendingSend || requiresHuman) {
      signals.push({
        level: "warn",
        text: `Review pending is active (${state || "review_required"}). This is a review/handoff wait inside the project, not a Codex login/runtime bootstrap failure.`
      });
    }
  }

  const queueCounts = {
    queued: countVisibleEntries(path.join(root, "agent", "queue", "queued")) + countVisibleEntries(path.join(root, "gpu_queue")) + countVisibleEntries(path.join(root, "cpu_queue")),
    running: countVisibleEntries(path.join(root, "agent", "queue", "running")) + countVisibleEntries(path.join(root, "gpu_running")) + countVisibleEntries(path.join(root, "cpu_running")),
    done: countVisibleEntries(path.join(root, "agent", "queue", "done")) + countVisibleEntries(path.join(root, "gpu_done")) + countVisibleEntries(path.join(root, "cpu_done")),
    failed: countVisibleEntries(path.join(root, "agent", "queue", "failed")) + countVisibleEntries(path.join(root, "gpu_failed")) + countVisibleEntries(path.join(root, "cpu_failed"))
  };
  const queueText = `Queue snapshot: queued=${queueCounts.queued}, running=${queueCounts.running}, done=${queueCounts.done}, failed=${queueCounts.failed}`;
  if (queueCounts.running > 0 && queueCounts.failed > 0) {
    signals.push({
      level: "warn",
      text: `Running and failed queue records coexist (${queueCounts.running} running, ${queueCounts.failed} failed). Treat failed entries as historical until the newest report or queue runner refresh says they are still live blockers.`
    });
  }

  const reconciliation = readJsonFileIfExists(path.join(root, "agent", "status", "SUPERVISOR_STALE_STATE_RECONCILIATION.json"), {});
  if (reconciliation && reconciliation.timestamp_utc) {
    const changed = reconciliation.reconciliation && reconciliation.reconciliation.changed === true;
    signals.push({
      level: changed ? "ok" : "muted",
      text: `Supervisor stale-state reconciliation last ran at ${reconciliation.timestamp_utc}${changed ? " and reported changed=true." : "."}`
    });
  }

  return { queueText, signals };
}

function stripJsonCommentsAndTrailingCommas(text) {
  let outputText = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        outputText += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        outputText += char;
      }
      continue;
    }

    if (inString) {
      outputText += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      outputText += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    outputText += char;
  }

  return removeTrailingCommas(outputText);
}

function removeTrailingCommas(text) {
  let outputText = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      outputText += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      outputText += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        continue;
      }
    }

    outputText += char;
  }

  return outputText;
}

async function runLogged(command, args, options = {}) {
  output.show(true);
  output.appendLine(`$ ${[command, ...args].join(" ")}`);
  const result = await run(command, args, options);
  if (result.stdout.trim()) {
    output.appendLine(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    output.appendLine(result.stderr.trimEnd());
  }
  return result;
}

async function runLoggedWithInput(command, args, input, options = {}) {
  output.show(true);
  output.appendLine(`$ ${[command, ...args].join(" ")} <stdin>`);
  const result = await runWithInput(command, args, input, options);
  if (result.stdout.trim()) {
    output.appendLine(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    output.appendLine(result.stderr.trimEnd());
  }
  return result;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, {
      cwd: options.cwd || os.homedir(),
      env: { ...process.env, ...(options.env || {}) },
      timeout: options.timeout,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error && !options.allowFailure) {
        error.message = `${error.message}\n${stderr || ""}`.trim();
        reject(error);
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "", error });
    });
  });
}

function runWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: options.cwd || os.homedir(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId;

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (error && !options.allowFailure) {
        error.message = `${error.message}\n${stderr || ""}`.trim();
        reject(error);
        return;
      }
      resolve(result);
    };

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        const error = new Error(`Command timed out after ${options.timeout} ms`);
        error.code = "ETIMEDOUT";
        finish(error, { stdout, stderr, error });
      }, options.timeout);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
        child.kill("SIGTERM");
        const error = new Error("stdout/stderr maxBuffer exceeded");
        finish(error, { stdout, stderr, error });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
        child.kill("SIGTERM");
        const error = new Error("stdout/stderr maxBuffer exceeded");
        finish(error, { stdout, stderr, error });
      }
    });
    child.on("error", (error) => {
      finish(error, { stdout, stderr, error });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if ((code && code !== 0) || signal) {
        const error = new Error(signal ? `Command terminated by ${signal}` : `Command exited with status ${code}`);
        error.code = code;
        finish(error, { stdout, stderr, error });
        return;
      }
      finish(null, { stdout, stderr, error: null });
    });

    child.stdin.end(String(input || ""));
  });
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function openDocument(file, preview) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview });
}

function readFilePrefix(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function expandHome(value) {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function systemdPathValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\s/g, "\\x20");
}

function systemdEnvValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\s/g, "\\x20");
}

const templates = {
  watchdogReadme: () => `# Codex Watchdog Project Guide

This folder has been selected as a Codex Watchdog project root.

Codex Watchdog is a scheduled handoff system. Daily Codex mode and the human operator prepare explicit project state under \`agent/\`. Watchdog mode wakes on a timer, runs \`codex exec\`, reads the handoff files and collected status, reasons about the next safe step, and writes reports back under \`agent/\`.

## What This Folder Contains

\`\`\`text
agent/
  TASK_REQUEST.md          natural-language task request for daily Codex
  WATCHDOG_PROTOCOL.md     runner/supervisor cooperation contract
  PLAN.md                  approved plan for unattended work
  TODO.md                  current task queue
  STATE.md                 human-approved durable state
  DAILY_HANDOFF.md         evening handoff from daily mode
  SAFETY.md                hard safety rules and allowed scope
  SECONDARY_SKILLS.example.json optional template for project-local support skills
  CURRENT_STATE.md         current canonical facts for the next actor
  RUN_STATE.json           machine-readable wakeup status
  NEXT_ACTION.md           one next safe action, not a history dump
  BLOCKERS.md              classified blockers and owner
  REVIEW_PENDING.md        reviewer bundle/send state
  ANTI_SNOWBALL.md         stopped routes and context compaction notes
  EXPERIMENT_LEDGER.md     concise hypothesis/model/loss/data/result ledger
  RUNTIME_STATE.md         compact memory refreshed by watchdog mode
  MORNING_BRIEF.md         summary for daily mode when the user returns
  STATE.proposed.md        candidate state update for human review
  watchdog.env             generated validated runtime configuration
  workspace_write_policy.example.json documentation for optional write probes
  SKILL_ROUTER.md          deterministic primary-skill routing contract
  skills/                  narrow watchdog skill manuals
  status/SKILL_ROUTE.json  deterministic primary skill plus optional secondary support skills
  status/RUNTIME_VALIDATION.json runtime validation report
  status/current.md        deterministic status snapshot
  reports/latest.md        symlink to the latest watchdog report
  pending/review_required/ decisions requiring human review
  bin/                     generated collector/runner scripts
\`\`\`

## How A Wakeup Works

1. \`agent/bin/route_skill.py\` writes or refreshes \`agent/status/SKILL_ROUTE.json\`, the deterministic primary skill for this wakeup plus any optional routed secondary support skills.
2. \`agent/bin/validate_runtime.py\` checks compact runtime JSON, route JSON, queue job JSON, gate JSON, and generated schemas before Codex starts.
3. \`agent/bin/collect_status.sh\` gathers deterministic facts: git status, GPU/process snapshot, handoff files, compact runtime state, bounded report previews, recent log paths/sizes, skill router, deterministic route, and runtime curation controls.
4. \`agent/bin/make_prompt.sh\` combines the wakeup prompt with \`agent/status/current.md\`.
5. \`agent/bin/run_watchdog.sh\` calls \`codex exec\` with the configured sandbox and schema.
6. The wakeup must report the same primary watchdog skill as \`agent/status/SKILL_ROUTE.json\`. If the route also attached secondary skills, the wakeup must acknowledge them through \`secondary_skills_consulted\`.
7. \`agent/bin/render_report.py\` rejects mismatched \`primary_skill\` or \`secondary_skills_consulted\` values and writes:
   - \`agent/reports/<timestamp>.json\`
   - \`agent/reports/<timestamp>.md\`
   - \`agent/reports/latest.md\`
   - \`agent/RUNTIME_STATE.md\`
   - \`agent/MORNING_BRIEF.md\`
   - \`agent/STATE.proposed.md\`
   - \`agent/CURRENT_STATE.md\`
   - \`agent/RUN_STATE.json\`
   - \`agent/NEXT_ACTION.md\`
   - \`agent/BLOCKERS.md\`
   - \`agent/REVIEW_PENDING.md\`

## Runner / Supervisor Cooperation

Set \`codexWatchdog.role\` to \`runner\` for project-local worker watchdogs and \`supervisor\` for low-frequency audit watchdogs. They use the same runtime and scripts; only the responsibility boundary changes.

Runner watchdogs should execute one bounded project-local cycle and update the canonical handoff files. Supervisor watchdogs should read runner canonical handoff files, classify stale/blocking states, prepare reviewer-pending work, and prevent redundant information snowballing. A supervisor must not become a fourth runner: it should not launch training, change model code, delete files, or bypass external-service approval.

Project-local secondary skills are an optional specialization layer. They are selected deterministically after the primary route is known, and they may refine reasoning discipline, comparability checks, reviewer packaging, or evidence hygiene. They must not replace the primary skill or expand queue/write/execution authority.

Use \`codexWatchdog.phaseOffsetMinutes\` to stagger timers. For example, runners can use offsets 0/10/20 minutes and the supervisor can use 30 minutes, while all runners repeat every 45 minutes and the supervisor repeats every 180 minutes.

## Initial Setup For Daily Codex Mode

Before starting a timer, instantiate the task from the user's plain-language request. Start with \`agent/TASK_REQUEST.md\`, then fill or review these files:

1. \`agent/PLAN.md\`: the approved objective and scope.
2. \`agent/TODO.md\`: concrete tasks, each with status.
3. \`agent/STATE.md\`: durable facts the watcher may rely on.
4. \`agent/SAFETY.md\`: forbidden actions, allowed write paths, GPU rules, and review requirements.
5. \`agent/DAILY_HANDOFF.md\`: what the watcher should focus on tonight.

Only after those files describe the concrete task, let the project-local guard check login, run one manual cycle, and start the timer only after that cycle succeeds:

\`\`\`bash
\# If login is not ready, this prints the login command and stops.
./agent/bin/watchdog start
\`\`\`

OpenAI login is the only manual authorization step. If the guard reports that login is not ready, run:

\`\`\`bash
./agent/bin/watchdog login
./agent/bin/watchdog status
\`\`\`

To stop the timer:

\`\`\`bash
./agent/bin/watchdog stop
\`\`\`

You can also start or stop it from the VSCode command \`Codex Watchdog: Start Guard\` or from the control panel. The extension prepares this folder and then blocks until the watchdog \`CODEX_HOME\` is logged in.

## Plain-Language Codex Takeover

If the user says something like "把这个需求实例化成 watchdog 任务", "准备看护员任务", or "instantiate this watchdog project", Codex should read \`agent/TASK_REQUEST.md\` and fill \`PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF\` first.

If the user says something like "启动看护员", "接管 watchdog", "start the guard", or "stand watch for this project", Codex should first verify that the task has been instantiated, then read \`agent/CODEX_TAKEOVER.md\` and use:

\`\`\`bash
./agent/bin/watchdog --help
./agent/bin/watchdog start
\`\`\`

That command checks the local layout and Codex login, runs one immediate wakeup, installs the repeating timer only if the immediate run succeeds, and prints the resulting timer status.

## Project-Local Startup Commands

If Codex only knows this folder path, these are the entry points:

\`\`\`bash
cd /path/to/this/project

# Show the complete project-local CLI manual.
./agent/bin/watchdog --help

# Complete the only manual authorization step if status says login is not ready.
./agent/bin/watchdog login
./agent/bin/watchdog status

# One immediate wakeup with login/layout checks. Good for testing.
./agent/bin/watchdog run-once

# Recompute deterministic route or validate runtime files without calling Codex.
./agent/bin/watchdog route
./agent/bin/watchdog validate

# Show compact queue state without raw log tails.
./agent/bin/watchdog queue

# Let Codex take over and start a standing guard.
./agent/bin/watchdog start

# Install and start the repeating systemd user timer.
./agent/bin/watchdog timer-install

# Check whether the timer is active and when it will run next.
./agent/bin/watchdog status

# Stop the repeating timer.
./agent/bin/watchdog stop
\`\`\`

Optional environment overrides:

\`\`\`bash
CODEX_BIN=/path/to/codex \\
CODEX_HOME=$HOME/.codex-watcher \\
CODEX_SANDBOX_MODE=read-only \\
WATCHDOG_INTERVAL_MINUTES=30 \\
WATCHDOG_TIMEOUT_MINUTES=25 \\
WATCHDOG_COMPACT_EVERY_RUNS=6 \\
./agent/bin/watchdog start
\`\`\`

## Runtime Curation

The guard keeps a project-local run counter in \`agent/status/run_count\`. Every \`WATCHDOG_COMPACT_EVERY_RUNS\` runs, the next wakeup is marked as a scheduled curation cycle in \`agent/status/current.md\`. During that cycle, Codex should use watchdog-report-curator behavior: keep \`RUNTIME_STATE.md\`, \`MORNING_BRIEF.md\`, and the phase report short; remove repeated history; reference old reports by path instead of copying them.

Set \`WATCHDOG_COMPACT_EVERY_RUNS=0\` to disable scheduled curation. Raw log tails are omitted from the core snapshot by default; set \`WATCHDOG_INCLUDE_LOG_TAILS=1\` only for short debugging sessions.

## Safety Boundary

Default watchdog mode is read-only reasoning plus reports. It should not kill jobs, delete files, launch unapproved training, change git state, or use unauthorized GPUs. Dangerous or uncertain next steps must be written as review-required proposals under \`agent/pending/\`.

Workspace-write coding probes are allowed only when \`agent/workspace_write_policy.json\` exists, is valid, sets \`enabled: true\`, and lists exact relative writable paths and exact allowed commands. \`agent/SAFETY.md\` should document the same probe for model guidance. If the JSON policy is missing or invalid, the generated scripts force \`workspace-write\` back to \`read-only\`.

## Daily Mode Handoff

When the user returns, daily Codex mode should read:

- \`agent/MORNING_BRIEF.md\`
- \`agent/reports/latest.md\`
- \`agent/RUNTIME_STATE.md\`
- \`agent/STATE.proposed.md\`

Daily mode should decide whether to accept, edit, or reject \`agent/STATE.proposed.md\`. Do not silently replace \`agent/STATE.md\` without human approval.
`,

  codexTakeover: () => `# Codex Takeover Protocol

This file tells daily Codex mode how to take over Codex Watchdog without reading the VSCode extension source.

## Plain-Language Trigger

If the user says any of the following, treat it as a request to instantiate the project first, not to start the timer immediately:

- "把这个需求实例化成 watchdog 任务"
- "准备看护员任务"
- "根据我的需求填好 watchdog"
- "instantiate this watchdog project"

For instantiation, read \`agent/TASK_REQUEST.md\` and rewrite \`agent/PLAN.md\`, \`agent/TODO.md\`, \`agent/STATE.md\`, \`agent/SAFETY.md\`, and \`agent/DAILY_HANDOFF.md\` so they describe the concrete task.

If the user says any of the following after task instantiation, treat it as a request to operate the project-local watchdog:

- "启动看护员"
- "接管 watchdog"
- "让 Codex 坚守岗位"
- "start the guard"
- "stand watch"
- "start watchdog for this project"

## Required First Reads

Before running commands, read:

1. \`README.codex-watchdog.md\`
2. \`agent/TASK_REQUEST.md\`
3. \`agent/SAFETY.md\`
4. \`agent/DAILY_HANDOFF.md\`
5. \`agent/PLAN.md\`
6. \`agent/TODO.md\`

## Preferred Command

Use the guard helper:

\`\`\`bash
./agent/bin/watchdog --help
./agent/bin/watchdog start
# or directly:
./agent/bin/watchdog_guard.sh start
\`\`\`

This command:

1. Verifies the project-local watchdog layout.
2. Resolves the Codex binary.
3. Checks \`CODEX_HOME\` login status.
4. Runs one immediate wakeup with \`agent/bin/run_watchdog.sh\`.
5. Starts the repeating systemd user timer only if the immediate wakeup succeeds.
6. Prints the timer unit and current timer status.

If login is not ready, do not try to bypass it. Tell the user to complete:

\`\`\`bash
./agent/bin/watchdog login
\`\`\`

Then rerun:

\`\`\`bash
./agent/bin/watchdog start
\`\`\`

## Other Commands

\`\`\`bash
./agent/bin/watchdog --help
./agent/bin/watchdog check
./agent/bin/watchdog run-once
./agent/bin/watchdog status
./agent/bin/watchdog queue
./agent/bin/watchdog route
./agent/bin/watchdog validate
./agent/bin/watchdog stop
./agent/bin/watchdog latest

# Direct helper aliases:
./agent/bin/watchdog_guard.sh check
./agent/bin/watchdog_guard.sh run-once
./agent/bin/watchdog_guard.sh status
./agent/bin/watchdog_guard.sh stop
./agent/bin/watchdog_guard.sh latest
\`\`\`

## Reporting Back To The User

After operating the guard, report:

- project root;
- Codex binary used;
- \`CODEX_HOME\`;
- whether login is ready;
- timer service and timer unit;
- active/enabled status;
- latest report path;
- whether human review is required.

If login is not ready, do not pretend the guard is active. Run or suggest:

\`\`\`bash
./agent/bin/watchdog login
\`\`\`

If safety evidence is insufficient, stop and explain what file needs to be filled before unattended operation.
`,

  taskRequest: () => `# Task Request

This file is for daily Codex mode before the watchdog starts.

## User Request

Describe in plain language what the watchdog should do while unattended.

Examples:

- Watch these logs and summarize whether the experiment is still improving.
- Read these Markdown notes and extract TODO/FIXME/QUESTION items into a report.
- Monitor an evaluation output folder and prepare a morning comparison against a baseline.

## Codex Instantiation Instructions

When the user gives a plain-language task, instantiate this project before starting the guard:

1. Rewrite \`agent/PLAN.md\` with the approved objective, allowed scope, and review-required decisions.
2. Rewrite \`agent/TODO.md\` with concrete watchdog tasks and evidence paths.
3. Rewrite \`agent/STATE.md\` with durable known facts, active inputs, and current blockers.
4. Rewrite \`agent/SAFETY.md\` with hard no-go rules for this specific project.
5. Rewrite \`agent/DAILY_HANDOFF.md\` with tonight's objective, approved scope, active items, known risks, and morning questions.
6. Create any harmless seed files needed for the task only if the user explicitly asked for a demo or test scenario.
7. Do not start the guard until these files describe the concrete task rather than generic placeholders.

## Ready Check

Before starting watchdog mode, these should be true:

- \`agent/PLAN.md\` names a concrete objective.
- \`agent/TODO.md\` names concrete tasks and paths to inspect.
- \`agent/STATE.md\` contains the current known state.
- \`agent/SAFETY.md\` says what must not be touched.
- \`agent/DAILY_HANDOFF.md\` answers what the watcher should do tonight.
`,

  agents: () => `# Project Agent Rules

## Role

You are an overnight research assistant for this project. Inspect the current project state, reason about progress, and prepare safe next-step reports.

## Hard Safety Rules

You must not:

- kill, suspend, restart, or reprioritize running training jobs;
- delete files or directories;
- modify dataset files;
- start a new training job unless an explicit approved job request exists;
- use GPUs outside the allowlist described in agent/SAFETY.md;
- change environment variables that affect active jobs;
- run destructive git commands;
- push, pull, merge, rebase, reset, or checkout branches without approval.

## Allowed By Default

You may:

- read project files;
- inspect logs and experiment outputs;
- summarize metrics;
- compare current status against agent/PLAN.md and agent/TODO.md;
- write reports through the automation output mechanism;
- propose safe next actions;
- mark uncertainty explicitly.

## Watchdog Takeover

If the user asks you in plain language to start, take over, wake, guard, or stand watch for this project, do not ask them to operate the VSCode extension manually. Read README.codex-watchdog.md and agent/CODEX_TAKEOVER.md, then use the project-local scripts:

- agent/bin/watchdog_guard.sh start
- agent/bin/watchdog_guard.sh status
- agent/bin/watchdog_guard.sh stop

Start the guard only after checking the selected project root, Codex login status, and the safety files. Report the timer unit, next run status, and latest report path.

## Decision Principle

When in doubt, do not execute. Write a clear reason and create a review-required recommendation.
`,

  plan: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Overnight Plan

## Objective

Continue monitoring the current training/evaluation pipeline and prepare safe next steps.

## Current Approved Work

1. Monitor the experiments named in agent/TODO.md.
2. Parse relevant logs under runs/, logs/, outputs/, and experiment-specific directories.
3. Detect whether active training completed normally.
4. If training completed, summarize final metrics.
5. If evaluation outputs already exist, compare them against the baseline named in agent/TODO.md.
6. Do not launch new training.
7. Do not stop or alter running jobs.

## Review-Required Decisions

- Starting a new training run.
- Changing hyperparameters.
- Moving or deleting checkpoints.
- Reassigning GPUs.
- Modifying training code.
- Changing dataset preprocessing.
`,

  state: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Agent State

Last updated: unknown

## Active Experiments

- None recorded yet. Fill this section with the experiment IDs, output paths, host, expected logs, and known status before relying on unattended decisions.

## Completed Tasks

- None recorded yet.

## Blocked / Review Required

- New training, code changes, checkpoint deletion, process control, and GPU reassignment require human review.

## Next Safe Task

Read the current snapshot, compare it with agent/PLAN.md and agent/TODO.md, and write a report.
`,

  stateJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    mode: "observer",
    requires_review: false,
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    active_task_id: null,
    route_task_id: null,
    active_branch: null,
    tasks: [],
    latest_completed_job: null,
    latest_gate_result: null,
    allowed_next_action: "report_only",
    blocked_actions: [],
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap",
    important_paths: [
      "agent/PLAN.md",
      "agent/TODO.md",
      "agent/STATE.md",
      "agent/SAFETY.md"
    ]
  }, null, 2) + "\n",

  progressStateJson: () => JSON.stringify({
    last_progress_at: null,
    no_progress_cycles: 0,
    last_report_type: "heartbeat",
    current_blocker: "",
    recommend_pause: false,
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    active_task_id: null,
    route_task_id: null,
    task_box_id: "bootstrap-taskbox",
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap"
  }, null, 2) + "\n",

  taskBoxJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    owner: "Codex",
    task_box_id: "bootstrap-taskbox",
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap",
    successor_contract_required: false,
    active_task_id: null,
    route_task_id: null,
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    active_target: "Define the first concrete watchdog mission before unattended runs.",
    project_question: "What bounded watchdog setup or research question is this task box directly helping answer?",
    decision_relevance: "This task box should reduce one concrete uncertainty that changes the next route decision.",
    uncertainty_reduced_if_success: "A successful bounded cycle should make the next route decision narrower and more concrete.",
    uncertainty_reduced_if_failure: "A failed bounded cycle should still clarify whether the current route should continue, pause, or switch.",
    claim_scope: "bootstrap_setup",
    forbidden_conclusions: [
      "Do not treat setup-only work as a project-level research conclusion.",
      "Do not promote local draft preparation into a shared-source or final quality claim."
    ],
    diagnosis_target: "watchdog bootstrap readiness",
    fair_comparability: {
      same_family_or_not: "not_applicable",
      same_budget_or_not: "not_applicable",
      same_training_contract_or_not: "not_applicable",
      same_eval_contract_or_not: "not_applicable"
    },
    value_of_information: {
      expected_information_gain: "high",
      decision_change_if_positive: "The watchdog project can move from setup into one bounded autonomous cycle.",
      decision_change_if_negative: "The watchdog project should remain in draft/setup mode until the missing contract is repaired.",
      cheaper_alternative_exists: false
    },
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      causal_path_verification: "advisory",
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: [
      "report_only",
      "local_workspace_copy",
      "bounded_cpu_eval",
      "state_reconcile",
      "stale_marker_cleanup",
      "local_profile_authoring",
      "local_queue_draft_authoring"
    ],
    blocked_actions: [
      "direct_gpu_execution",
      "shared_source_edit",
      "dataset_mutation",
      "checkpoint_mutation",
      "promotion_apply",
      "external_send"
    ],
    success_gates: [
      "one bounded watchdog cycle completes with compact state updates",
      "shared files outside allowed local/state paths are untouched"
    ],
    stop_conditions: [
      "finish one bounded step and refresh compact watchdog state",
      "if the next step would change shared facts or external state, switch to review-required"
    ],
    allowed_write_paths: [
      "agent/status/",
      "agent/reports/",
      "agent/logs/",
      "agent/pending/",
      "agent/task_profiles/",
      "workspace/",
      "runs/"
    ],
    allowed_commands: [],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    review_required_when: [
      "shared-source edit or promotion",
      "dataset/checkpoint mutation",
      "external send",
      "direct GPU shell execution"
    ],
    morning_brief_questions: [
      "What did watchdog complete autonomously?",
      "What still needs human approval?"
    ],
    tasks: []
  }, null, 2) + "\n",

  routeCanonicalJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    macro_goal: "Bootstrap a bounded watchdog project before unattended execution.",
    active_ladder: ["bootstrap"],
    current_allowed_step: "bootstrap",
    blocked_downstream_steps: [],
    current_budget_contract: "one bounded wakeup per cycle",
    main_provider_contract: "local Codex watchdog",
    promotion_gates: [
      "human review for shared-source promotion",
      "human review for external send"
    ],
    owner_mode: "fully_autonomous",
    successor_contract_required: false,
    requires_review: false,
    active_task_id: null,
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false
  }, null, 2) + "\n",

  evidenceLedgerJsonl: () => "",

  queueStatus: () => `# Queue Status

Updated: never

## Running

No running jobs recorded.

## Queued

No queued jobs recorded.

## Done / Failed Since Last Wakeup

No completed or failed jobs recorded.

## Log Summary

- Tail included: no
`,

  researchLedger: () => `# Research Ledger

Only durable, evidence-backed facts belong here. Do not paste raw logs or transient reports.

## Research Question

- Not defined yet.

## Operational Definitions

- Not defined yet.

## Confirmed Facts

- None yet.

## Current Hypotheses

- None yet.

## Next Decisions

- None yet.
`,

  ledgerNotes: () => `# Ledger Notes

Use this file for proposed ledger fragments or uncertain observations. Do not overwrite RESEARCH_LEDGER.md unless producing a complete document that starts with "# Research Ledger".
`,

  watchdogProtocol: () => `# Watchdog Cooperation Protocol

This generated protocol keeps runner watchdogs and supervisor watchdogs compatible.

## Roles

- \`runner\`: execute one bounded project-local work cycle, monitor/queue/evaluate project jobs, and update canonical handoff files.
- \`supervisor\`: run less frequently, inspect runner handoff files, classify blockers, compact repeated history, and coordinate reviewer-pending requests.

Both roles use the same Codex runtime and generated scripts. The supervisor is not a privileged fourth runner.

## Canonical Route And Handoff Files

Canonical route truth now starts with:

- \`agent/ROUTE_CANONICAL.json\`: route_id, route_epoch, owner_mode, active step, and downstream gates.
- \`agent/TASK_BOX.json\`: machine-readable bounded assignment, allowed actions, allowed write paths, queue policy, and concrete tasks.

Derived/project-local watchdog files should be reconciled against the canonical route/task box when they drift:

Each wakeup should leave these files coherent:

- \`agent/CURRENT_STATE.md\`: current facts only.
- \`agent/RUN_STATE.json\`: machine-readable role/status/blocker/next-action summary.
- \`agent/NEXT_ACTION.md\`: exactly one next safe action.
- \`agent/BLOCKERS.md\`: blockers grouped as env, queue, permission, reviewer, model, data, stale_state, or none.
- \`agent/REVIEW_PENDING.md\`: reviewer bundle state, sanitization state, send state, and response state.
- \`agent/ANTI_SNOWBALL.md\`: stopped routes, stale facts to avoid repeating, and compaction notes.
- \`agent/EXPERIMENT_LEDGER.md\`: durable experimental hypotheses, model/loss/data protocol, provenance, results, and conclusions.
- \`agent/EVIDENCE_LEDGER.jsonl\`: durable machine-readable evidence objects for later agents.

## Supervisor Modes

- \`light\`: triggered after a new completed runner cycle or a changed reviewer/blocker marker. Repair only safe report-only/bookkeeping issues such as stale pending_send markers, stale handoff files, permission notes, blocker classification, and next-action clarification.
- \`audit\`: triggered every configured runner-cycle cadence. Run light marker hygiene first, then one heavier audit for leakage, anti-snowballing, stale state, environment drift, queue hygiene, and repeated blocker repair.
- \`standby\`: no new runner cycle and no audit due. Write a short heartbeat and stop.

The runtime writes the chosen mode to \`agent/status/SUPERVISOR_MODE.json\` and \`agent/RUN_STATE.json\`. Do not override it inside the prompt; report a runtime blocker if it appears wrong.

## Runner Rules

- Runner is not just an observer. Runner is the default executor for bounded planned work and the default repairer for low-risk local blockers.
- If \`requires_review=false\`, treat the project as fully autonomous for bounded local work inside the task box and route contract.
- Prefer \`agent/TASK_BOX.json\` first, then \`agent/STATE.json\`, then markdown files.
- If \`agent/ROUTE_CANONICAL.json\` disagrees with derived state files, repair the derived files locally instead of waiting for a supervisor essay.
- Queue draft authoring, local profile/package authoring, local workspace copy preparation, stale state cleanup, and bounded CPU eval are autonomy-preserving actions; do them when the task box and safety policy allow them.
- Sandbox-local GPU visibility failures are advisory only. Do not conclude that the host has no GPU unless queue/host evidence agrees.
- Direct GPU shell execution remains forbidden; convert it into a queue path or queue draft.

## Supervisor Rules

- Prefer canonical handoff files over old reports.
- If a runner is active, do not wait on or interrupt it.
- Fix only stale state, stale pause markers, stale queue metadata, reviewer-pending bookkeeping, and anti-snowball summaries.
- You may resolve runner report-only/bookkeeping blockers when the evidence is explicit and no shared-state side effect is being approved.
- You may approve only the capability classes explicitly allowed by \`agent/supervisor_capabilities.json\`; public defaults allow report-only, state reconcile, stale-marker cleanup, local workspace copy work, local profile/package authorship, local queue-draft authorship, and bounded CPU eval.
- You must not approve disabled capability classes such as GPU probes, training canaries, queue enqueue, promotion, external reviewer sending, data/checkpoint mutation, package installation, service mutation, or new high-risk allowlist permissions. Write a review-required handoff instead.
- If \`queue_enqueue\` is enabled, it only permits writing a bounded taskbox/request into the monitored queue; it never permits the runner to execute GPU commands directly or bypass the queue runner.
- If a deterministic project-local reconciliation helper has already repaired stale state, trust its compact report and do not launch a second broad reasoning pass for the same wakeup.
- Passive waiting is a supervisor failure when a blocker is stale/repeated, the evidence is local, and the repair is bookkeeping/report-only or an explicitly supervisor-approved bounded non-mutating task.
- For stale_state, stale_route_text, missing_profile, queue-draft authorship, and sandbox-visibility-only blockers, repair locally when the change stays inside the project-local watchdog boundary.
- For environment or external reviewer blockers, write the exact needed action and evidence path.
- For model/data/loss decisions, prepare a concise reviewer or Deep Research evidence bundle; do not invent a new model line.
`,

  currentState: () => `# Current State

Updated: never

## Role

- Unknown. Generated watchdogs should set this from WATCHDOG_ROLE.

## Current Facts

- No current facts recorded yet.

## Latest Evidence

- None yet.
`,

  runStateJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    role: "runner",
    supervisor_mode: "runner",
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    task_box_id: "bootstrap-taskbox",
    runner_run_count: null,
    runner_started_count: null,
    supervisor_audit_every_runner_runs: null,
    status: "unknown",
    primary_skill: null,
    report_type: null,
    progress_changed: false,
    active_task_id: null,
    blocker_type: "none",
    requires_human_review: false,
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap",
    next_action: {
      kind: "none",
      description: "",
      can_execute_automatically: false,
      reason: ""
    },
    evidence: []
  }, null, 2) + "\n",

  nextAction: () => `# Next Action

Updated: never

## One Next Safe Action

- None recorded yet.

## Stop Condition

- Stop after one bounded action and update canonical handoff files.
`,

  blockers: () => `# Blockers

Updated: never

Use blocker types: env, queue, permission, reviewer, model, data, stale_state, none.

## Active Blockers

- none: no blocker recorded yet.
`,

  reviewPending: () => `# Review Pending

Updated: never

## Reviewer Bundle State

- drafted: no
- sanitized: no
- pending_send: no
- sent: no
- blocked_by_env_policy: no
- response_received: no
- triaged: no

## Notes

- External reviewer sending may require environment-level approval. If blocked, write the exact bundle path and reason here instead of repeating it in every report.
`,

  antiSnowball: () => `# Anti-Snowball Notes

Updated: never

## Current Facts To Preserve

- None yet.

## Stopped Or Deprecated Routes

- None yet.

## Do Not Repeat

- Do not copy long historical reports into new reports. Reference paths instead.
`,

  experimentLedger: () => `# Experiment Ledger

Record durable experimental evidence for later Code Reviewer Agent / ChatGPT Deep Research use.

## Template

### Experiment ID

- Hypothesis:
- Model forward / structure:
- Loss / objective:
- Data protocol:
- Evaluation protocol:
- Provenance:
- Main metrics:
- Possible cheating paths:
- Failure classification:
- Conclusion:
- Next minimal diagnostic:
`,

  runtimeState: () => `# Runtime State

Last updated: never

This file is low-risk watcher memory. The scheduled watcher may refresh it after each run. Keep durable, human-approved project truth in agent/STATE.md.
`,

  dailyHandoff: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Daily Handoff

Last prepared: unknown

This file is written by the human operator or daily Codex mode before leaving the project unattended. The scheduled watchdog reads it but should not rewrite it.

## Tonight's Objective

- Replace this line with the concrete objective for the unattended period.

## Approved Scope

- Read project files, logs, metrics, and experiment outputs.
- Write reports, runtime state, morning brief, and review-required proposals under agent/.

## Active Experiments To Watch

- None recorded yet.

## Known Risks / Do Not Touch

- Do not launch new training.
- Do not stop or alter running jobs.
- Do not modify code, datasets, checkpoints, or git state.

## Morning Questions

- What finished?
- What is still running?
- What needs human review?
`,

  morningBrief: () => `# Morning Brief

No scheduled watchdog run has generated a morning brief yet.
`,

  demoReadme: () => `# Watchdog Demo Project

This folder is a minimal project prepared by daily mode and handed to Codex Watchdog mode for testing.

The plugin creates the agent/ handoff structure here. The scheduled watchdog reads logs/train.log, reasons about the demo experiment, and writes reports under agent/reports/.
`,

  demoTrainLog: () => `[2026-05-13 20:00:00] exp_demo_001 step=100 loss=0.921 psnr=18.2 status=running
[2026-05-13 20:30:00] exp_demo_001 step=200 loss=0.713 psnr=20.1 status=running
[2026-05-13 21:00:00] exp_demo_001 step=300 loss=0.522 psnr=22.4 status=running
`,

  demoDailyHandoff: () => `# Daily Handoff

Last prepared: 2026-05-13 evening

## Tonight's Objective

- Monitor demo experiment \`exp_demo_001\`.
- Read \`logs/train.log\`.
- Decide whether the experiment is still running, completed, blocked, or uncertain.
- Write a report and morning brief.

## Approved Scope

- Read files under this project.
- Write only under \`agent/status/\`, \`agent/reports/\`, \`agent/logs/\`, and \`agent/pending/\`.
- Update \`agent/RUNTIME_STATE.md\`.
- Update \`agent/MORNING_BRIEF.md\`.

## Active Experiments To Watch

- \`exp_demo_001\`
- Expected log: \`logs/train.log\`

## Known Risks / Do Not Touch

- Do not launch training.
- Do not kill any process.
- Do not delete files.
- Do not modify code.
- Do not change git state.

## Morning Questions

- What was the latest observed step?
- Did the loss decrease?
- What is the next safe watch task?
`,

  demoPlan: () => `# Overnight Plan

## Objective

Watch demo experiment \`exp_demo_001\` and produce safe progress reports.

## Current Approved Work

1. Read \`logs/train.log\`.
2. Extract the latest step, loss, PSNR, and status.
3. Decide whether the experiment is still running.
4. Write \`agent/reports/latest.md\`.
5. Update \`agent/RUNTIME_STATE.md\`.
6. Update \`agent/MORNING_BRIEF.md\`.
7. Do not modify training code.
8. Do not launch or stop any process.
`,

  demoTodo: () => `# Watcher TODO

| Status | Task | Evidence / Path |
| --- | --- | --- |
| pending | Monitor \`exp_demo_001\` | \`logs/train.log\` |
`,

  demoState: () => `# Agent State

Last updated: 2026-05-13 evening

## Active Experiments

### exp_demo_001

- Status: running
- Log: \`logs/train.log\`
- Last human-known step: 300
- Last human-known loss: 0.522
- Last human-known PSNR: 22.4

## Next Safe Task

Read the latest log lines and write a watchdog report.
`,

  demoStateJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: "2026-05-13T21:00:00Z",
    mode: "observer",
    requires_review: false,
    active_task_id: null,
    active_branch: null,
    tasks: [
      {
        task_id: "demo-monitor-exp-demo-001",
        status: "pending",
        allowed_runner: "report_only",
        description: "Read logs/train.log and summarize exp_demo_001 progress.",
        inputs: ["logs/train.log"],
        outputs: [
          "agent/reports/latest.md",
          "agent/RUNTIME_STATE.md",
          "agent/MORNING_BRIEF.md"
        ],
        evidence_paths: ["logs/train.log"],
        max_runtime_minutes: 5,
        success_gates: [
          "latest metric step/loss/psnr/status are summarized",
          "no code, process, GPU, dataset, checkpoint, or git state is modified"
        ],
        stop_conditions: [
          "one report-only demo monitoring pass is complete",
          "evidence is insufficient and a blocker is written"
        ],
        next_allowed_tasks: [],
        requires_review_after: false
      }
    ],
    latest_completed_job: null,
    latest_gate_result: null,
    allowed_next_action: "report_only",
    blocked_actions: [
      "launch_training",
      "kill_process",
      "delete_files",
      "modify_code",
      "change_git_state"
    ],
    important_paths: [
      "logs/train.log",
      "agent/PLAN.md",
      "agent/TODO.md",
      "agent/STATE.md",
      "agent/SAFETY.md"
    ]
  }, null, 2) + "\n",

  demoSafety: () => `# Safety Policy

## Execution Mode

Instantiated demo watcher mode: read-only reasoning.

## GPU Policy

- The watcher itself must run with CUDA_VISIBLE_DEVICES="".
- It must not allocate GPU memory.
- It must not run Python scripts that import torch with CUDA enabled.
- It must not launch training.
- It may inspect nvidia-smi output collected by agent/bin/collect_status.sh.

## Forbidden Commands

Never run or propose automatic execution of:

- rm, unlink, shred
- kill, pkill, killall
- git reset, git clean, git checkout, git switch, git pull, git push, git merge, git rebase
- sbatch, torchrun, accelerate launch, deepspeed, python train.py
- chmod/chown on project data or checkpoint directories

## Allowed Automatic Actions

For this demo only:

- read files under this project;
- read logs/train.log;
- summarize demo metrics;
- write reports under agent/reports/;
- write status files under agent/status/;
- write logs under agent/logs/;
- write review requests under agent/pending/;
- update agent/RUNTIME_STATE.md;
- update agent/MORNING_BRIEF.md.

## Demo Boundary

The watched experiment is exp_demo_001.

Do not modify source code, datasets, checkpoints, git state, processes, or environment variables.
`,

  safety: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Safety Policy

## Execution Mode

Default watcher mode: read-only reasoning.

## GPU Policy

- The watcher itself must run with CUDA_VISIBLE_DEVICES="".
- It must not allocate GPU memory.
- It must not run Python scripts that import torch with CUDA enabled.
- It must not launch training.
- It may inspect nvidia-smi output collected by agent/bin/collect_status.sh.

## Forbidden Commands

Never run or propose automatic execution of:

- rm, unlink, shred
- kill, pkill, killall
- git reset, git clean, git checkout, git switch, git pull, git push, git merge, git rebase
- sbatch, torchrun, accelerate launch, deepspeed, python train.py
- chmod/chown on project data or checkpoint directories

## Allowed Automatic Actions

In Level 1:

- read files;
- summarize logs;
- write report;
- write proposed state update.

In Level 2 only, after explicit implementation of a policy gate:

- run whitelisted postprocessing scripts with fixed arguments;
- run metric summarization scripts that do not use GPU;
- create review request files under agent/pending/.
`,

  workspaceWritePolicyExample: () => JSON.stringify({
    enabled: false,
    writable_paths: [
      "agent/tmp/",
      "outputs/probes/"
    ],
    allowed_commands: [
      "python3 tools/example_probe.py"
    ]
  }, null, 2) + "\n",

  secondarySkillsExample: () => JSON.stringify({
    schema_version: 1,
    skills: [
      {
        skill_id: "project-research-support",
        enabled: true,
        path: "agent/skills/project-secondary-example/SKILL.example.md",
        selectors: {
          primary_skills: ["watchdog-orchestrator", "watchdog-gate-evaluator"],
          roles: ["runner"],
          supervisor_modes: [],
          task_capabilities: ["report_only", "bounded_cpu_eval"]
        },
        notes: "Example project-local support skill: refine evidence hygiene, comparability checks, or reviewer packaging without changing runtime authority."
      }
    ]
  }, null, 2) + "\n",

  skillRouter: () => `# Watchdog Skill Router

Every watchdog wakeup must select exactly one primary skill, run one bounded action, apply report-curator rules, and stop.

Project-local secondary skills are optional support constraints. They may refine evidence discipline, reviewer triage, comparability checks, or research hygiene, but they never replace the routed primary skill or expand authority.

## Primary Skills

- watchdog-orchestrator
- watchdog-job-queue
- watchdog-gate-evaluator
- watchdog-report-curator
- watchdog-handoff-writer
- watchdog-cleanup-auditor

watchdog-permission-guardian is a mandatory gate before any action that writes, queues, executes, archives, or changes mechanism configuration. It may be reported as the primary skill only when the wakeup's main work is to block or explain an unsafe action.

## Routing Order

1. If agent/control/PAUSE exists: primary_skill = watchdog-handoff-writer; write paused status; stop.
2. If supervisor light/audit finds a target runner with a delegable stale_state, missing_profile, queue-draft, local-workspace-copy, report-only, or bounded non-mutating blocker: primary_skill = watchdog-orchestrator; write exactly one approval/reconciliation or explain why it is not safe; stop.
3. If gpu_running/, cpu_running/, or agent/queue/running/ contains a job: primary_skill = watchdog-job-queue; monitor exactly one running job; stop.
4. If gpu_done/, cpu_done/, or agent/queue/done/ contains fresh unprocessed output within WATCHDOG_QUEUE_RESULT_FRESH_MINUTES: primary_skill = watchdog-gate-evaluator; evaluate exactly one result; stop.
5. If a queued job exists: primary_skill = watchdog-job-queue; inspect queue state; stop.
6. If ROUTE_CANONICAL/TASK_BOX say the project is autonomous and route_epoch or compact state markers are stale: primary_skill = watchdog-orchestrator; reconcile local derived state and stop.
7. If one structured pending task exists in TASK_BOX.json or STATE.json and it is report-only, local workspace copy, local profile authorship, local queue-draft authorship, stale-state repair, state reconcile, or bounded CPU eval: primary_skill = watchdog-orchestrator; continue exactly one bounded action instead of waiting on stale review text.
8. If one pending task has explicit supervisor approval and passes \`agent/supervisor_capabilities.json\`: primary_skill = watchdog-orchestrator; execute or prepare exactly one task within that approval scope; stop.
9. If active structured review markers remain and the next step would change shared facts, enqueue controlled GPU work, run direct GPU commands, send externally, mutate data/checkpoints, or promote shared source: primary_skill = watchdog-handoff-writer; write one review item; stop.
10. If one legal pending task exists: primary_skill = watchdog-orchestrator; choose exactly one next action. Apply watchdog-permission-guardian only when the action truly writes shared state, enqueues controlled work, executes risky commands, or changes mechanism configuration.
11. If TODO has pending/unchecked work but no runnable structured task exists: primary_skill = watchdog-orchestrator; choose one bounded next step or ask daily mode to structure TASK_BOX.json/STATE.json; stop.
12. If agent/status/current.md says Compaction due this cycle and no higher-priority active work exists: primary_skill = watchdog-report-curator; compact active outputs; stop.
13. If only active review markers remain: primary_skill = watchdog-handoff-writer; write review-required handoff; stop.
14. If no runnable task exists: primary_skill = watchdog-handoff-writer; write idle/blocked status; stop.

The generated agent/bin/route_skill.py applies this route before Codex starts and writes agent/status/SKILL_ROUTE.json. Codex output must match that route.

## Invariants

- Select at most one primary skill per wakeup.
- Secondary skills may be attached deterministically, but they remain support-only and cannot override the primary skill.
- Do not chain multiple operational skills in one wakeup.
- Do not paste raw logs into core state.
- Do not queue duplicate jobs.
- Do not execute GPU work directly; use a queue/runner.
- Treat queue draft authoring and queue enqueue as different actions.
- Always finish with report-curator discipline: concise state, no duplicated history, evidence by path.
`,

  skillOrchestrator: () => `---
name: watchdog-orchestrator
description: Select the next legal watchdog action from compact project state without executing it directly.
---

# watchdog-orchestrator

Use when no job is running, no completed job needs gate evaluation, no pause file exists, and there may be one bounded task or local unblock action to advance.

Inputs:
- agent/STATE.md
- agent/TODO.md
- agent/PLAN.md
- agent/SAFETY.md
- agent/status/current.md

Allowed:
- Identify exactly one next safe action.
- Execute exactly one bounded local action when the route/task box allows it.
- Repair stale local watchdog state, missing task profiles, queue drafts, and route drift inside the project-local boundary.
- Mark missing evidence or blocked dependencies.
- Propose review when safety is unclear.

Forbidden:
- Start jobs directly from shell when the route requires queue execution.
- Edit project code.
- Change daily-mode files.
- Expand into multiple branches.

Stop after:
- Finishing one bounded local action, selecting one next action, or declaring no runnable task.
`,

  skillJobQueue: () => `---
name: watchdog-job-queue
description: Monitor or submit approved queued jobs while preventing duplicate unattended execution.
---

# watchdog-job-queue

Use when a queue/running directory indicates an active job, or when a pending task has already passed permission-guardian and must be queued.

Inputs:
- agent/status/current.md
- agent/queue/ if present
- gpu_queue/, gpu_running/, gpu_done/, gpu_failed/ if present
- cpu_queue/, cpu_running/, cpu_done/, cpu_failed/ if present

Allowed:
- Report one running job's state.
- Create one queue file only after permission-guardian passes and a queue contract exists.
- Update compact queue status.

Forbidden:
- Start GPU commands directly.
- Queue duplicate jobs for the same task_id.
- Kill or reprioritize processes.

Stop after:
- Observing one running job, queueing one approved job, or writing one blocker.
`,

  skillGateEvaluator: () => `---
name: watchdog-gate-evaluator
description: Evaluate completed outputs against declared gates and produce pass, reject, or block decisions.
---

# watchdog-gate-evaluator

Use when a completed job has outputs that have not been evaluated.

Inputs:
- one result summary path
- declared gates from PLAN/TODO/STATE or a project gate file
- relevant compact evidence

Allowed:
- Read summary JSON/CSV/Markdown.
- Compare observed values with declared gates.
- Write a compact pass/reject/block decision through structured output.

Forbidden:
- Change gate thresholds after seeing results.
- Launch follow-up jobs unless explicitly queued through permission-guardian in a later wakeup.
- Paste raw logs into state.

Stop after:
- One gate decision.
`,

  skillReportCurator: () => `---
name: watchdog-report-curator
description: Prevent report and context snowballing by compacting active state and handoff text.
---

# watchdog-report-curator

Use on scheduled compaction cycles, when current.md is large, or as the final discipline for every wakeup.

Inputs:
- agent/status/current.md
- agent/RUNTIME_STATE.md
- agent/MORNING_BRIEF.md
- latest report path

Allowed:
- Keep current facts, blockers, latest evidence paths, and next safe action.
- Suppress duplicate report content.
- Reference historical reports by path.

Forbidden:
- Copy long historical reports into new reports.
- Embed raw log tails in core state.
- Delete evidence.

Stop after:
- Writing one compact runtime state, one compact morning brief, and one concise report.
`,

  skillPermissionGuardian: () => `---
name: watchdog-permission-guardian
description: Enforce safety before any watchdog action writes, queues, executes, archives, or changes configuration.
---

# watchdog-permission-guardian

This is a gate before execution-oriented skills.

Inputs:
- agent/SAFETY.md
- agent/workspace_write_policy.json when workspace-write is requested
- proposed command/path/GPU/timeout details

Allowed:
- Approve only if the action is explicitly allowed.
- Block unclear or unsafe actions.
- Explain what approval is missing.

Forbidden:
- Infer permission from intent alone.
- Broaden writable paths or command profiles.
- Treat prompt text as stronger than machine-readable policy.

Stop after:
- Returning passed, blocked, or not_required.
`,

  skillHandoffWriter: () => `---
name: watchdog-handoff-writer
description: Write concise human-readable paused, idle, blocked, or review-required handoffs.
---

# watchdog-handoff-writer

Use when paused, blocked, idle, or review is required.

Inputs:
- current compact state
- blocker evidence paths
- pending review reason

Allowed:
- Write a morning brief.
- Write a review-required recommendation through structured output.
- Explain why no action was taken.
- In supervisor light mode, reconcile stale report-only/bookkeeping review markers and capability-policy-approved bounded tasks when the evidence shows no shared-state mutation beyond the configured policy.

Forbidden:
- Make operational decisions.
- Execute commands.
- Rewrite plan/state/safety directly.
- Approve training, GPU execution, queue enqueue, promotion, allowlist expansion, external reviewer sending, dataset mutation, package installation, or shared code changes unless the exact capability is explicitly enabled and bounded by policy.

Stop after:
- One handoff or review request.
`,

  skillCleanupAuditor: () => `---
name: watchdog-cleanup-auditor
description: Identify stale watchdog clutter and propose cleanup without deleting evidence by default.
---

# watchdog-cleanup-auditor

Use only when cleanup is explicitly requested or when a retention policy exists.

Inputs:
- agent/reports/
- agent/logs/
- agent/archive/
- retention policy if present

Allowed:
- List cleanup candidates.
- Propose archive actions.
- Execute only explicitly approved safe cleanup.

Forbidden:
- Delete datasets, checkpoints, user files, or evidence automatically.
- Remove latest report or active state.

Stop after:
- One audit/proposal.
`,

  projectSecondarySkillExample: () => `# Project Secondary Skill Example

This is a project-owned secondary skill example.

Use it to refine how a routed wakeup thinks, records evidence, packages reviewer material, or checks comparability.

Allowed:
- tighten evidence discipline;
- require explicit comparability notes;
- remind the wakeup to write reviewer-ready summaries;
- require uncertainty / risk labeling.

Forbidden:
- changing the routed primary skill;
- expanding write authority;
- expanding queue, GPU, training, or promotion authority;
- overriding TASK_BOX / ROUTE_CANONICAL truth.

When used:
- read this after the primary skill has already been selected;
- keep the primary skill authoritative;
- report this skill in secondary_skills_consulted.
`,

  todo: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Watcher TODO

Use statuses: pending, running, done, blocked, review_required.

| Status | Task | Evidence / Path |
| --- | --- | --- |
| pending | Replace this row with the first approved monitoring task. | agent/PLAN.md |
`,

  wakeup: () => `You are the scheduled Codex watcher for this research project.

You are being awakened by a timer. Treat this as a fresh handoff. Do not assume hidden chat context. Use only:

- agent/PLAN.md
- agent/STATE.md
- agent/STATE.json
- agent/TASK_BOX.json
- agent/ROUTE_CANONICAL.json
- agent/SECONDARY_SKILLS.json when present
- agent/PROGRESS_STATE.json
- agent/SAFETY.md
- agent/TODO.md
- agent/DAILY_HANDOFF.md
- agent/WATCHDOG_PROTOCOL.md
- agent/CURRENT_STATE.md
- agent/RUN_STATE.json
- agent/NEXT_ACTION.md
- agent/BLOCKERS.md
- agent/REVIEW_PENDING.md
- agent/ANTI_SNOWBALL.md
- agent/EXPERIMENT_LEDGER.md
- agent/EVIDENCE_LEDGER.jsonl
- agent/RUNTIME_STATE.md
- agent/MORNING_BRIEF.md
- agent/SKILL_ROUTER.md
- agent/status/SKILL_ROUTE.json
- agent/status/QUEUE_STATUS.md
- research/RESEARCH_LEDGER.md
- agent/skills/<selected-skill>/SKILL.md when needed
- agent/status/current.md
- relevant project files and logs if available in read-only mode

Mode boundary:

- Daily mode owns the intent and long-horizon policy in agent/PLAN.md, agent/TODO.md, agent/STATE.md, agent/SAFETY.md, and agent/DAILY_HANDOFF.md.
- Watchdog mode owns agent/CURRENT_STATE.md, agent/RUN_STATE.json, agent/NEXT_ACTION.md, agent/BLOCKERS.md, agent/REVIEW_PENDING.md, agent/ANTI_SNOWBALL.md, agent/EXPERIMENT_LEDGER.md, agent/RUNTIME_STATE.md, agent/MORNING_BRIEF.md, agent/status/, agent/reports/, agent/logs/, and agent/pending/.
- agent/TASK_BOX.json and agent/ROUTE_CANONICAL.json are the machine-readable route contract. When they drift from derived watchdog files, prefer reconciling the derived files instead of freezing.
- Project-local autonomous artifacts may also be written under agent/task_profiles/, workspace/, and runs/ when TASK_BOX/SAFETY explicitly allow that bounded action.
- Do not rewrite daily-mode files. Propose changes through state_update_markdown or review-required pending records.

Runner / supervisor cooperation:

- Read WATCHDOG_ROLE from the snapshot. If it is \`runner\`, perform one bounded project-local cycle and update the canonical handoff files through your structured output.
- If it is \`supervisor\`, also read WATCHDOG_SUPERVISOR_MODE from the snapshot:
  - \`light\`: perform a lightweight follow-up after a runner cycle. Repair only safe reviewer-pending markers, stale handoff markers, permission/allowlist notes, or blocker bookkeeping. Do not deep-audit the project.
  - \`audit\`: perform a heavier read-only health audit for leakage, anti-snowball, stale state, environment drift, queue hygiene, and repeated blocker repair. Do not become a runner.
  - \`standby\`: write a short heartbeat and stop.
- Supervisor mode is chosen deterministically by the runtime from runner cycle counts and marker files; do not silently change it. If the selected mode looks wrong, report it as a runtime blocker.
- If it is \`supervisor\`, do not launch training, change model code, delete files, interrupt active runner work, or bypass external-service approval.
- Prefer agent/TASK_BOX.json and agent/ROUTE_CANONICAL.json first, then agent/CURRENT_STATE.md, agent/RUN_STATE.json, agent/NEXT_ACTION.md, agent/BLOCKERS.md, and agent/REVIEW_PENDING.md over old reports when deciding what is currently true.
- Blockers must be classified as env, queue, permission, reviewer, model, data, stale_state, or none.

Runtime curation:

- agent/status/current.md contains watchdog runtime controls, including run count and whether this is a scheduled compaction cycle.
- If "Compaction due this cycle" is 1, apply watchdog-report-curator rules while finalizing. The deterministic route may still select a higher-priority primary skill such as job-queue or gate-evaluator. If no higher-priority work exists, route_skill.py may select watchdog-report-curator as the primary skill.
- During compaction, do not summarize every historical report. Preserve audit history by referencing paths, not by copying old text.
- Raw log tails are intentionally omitted from the core snapshot by default. Open a specific referenced log only when it is necessary for the current bounded action.

Watchdog skills layer:

- Start by reading agent/status/SKILL_ROUTE.json, which is produced deterministically by agent/bin/route_skill.py before Codex starts.
- Select exactly one primary_skill for this wakeup, and it must match agent/status/SKILL_ROUTE.json. If the deterministic route appears wrong, explain that as a blocker; do not silently choose a different primary skill.
- Read the selected skill's agent/skills/<primary_skill>/SKILL.md when the route is not obvious from the snapshot.
- If agent/status/SKILL_ROUTE.json lists secondary_skills, read those support-skill paths after the primary skill. Use them to tighten evidence discipline, comparability checks, reviewer packaging, or project-specific reasoning hygiene only; do not let them override the primary skill or broaden authority.
- If the action writes shared state, enqueues controlled work, executes risky commands, archives, or changes mechanism configuration, watchdog-permission-guardian must pass first. Local state reconcile, local queue-draft authorship, local profile authorship, local workspace copy preparation, stale-marker cleanup, and bounded CPU eval do not need to stop for review when they remain inside the project-local watchdog boundary and match TASK_BOX/SAFETY.
- Do not chain multiple operational skills in one wakeup. Run one bounded action and stop.

Your job:

1. Actively perform this work cycle. Do not merely restate or archive the prompt.
2. Use safe read-only inspection commands when the snapshot is insufficient, such as pwd, ls, find, rg, sed, tail, git status, and project-specific metric readers that do not write files or use GPUs.
3. Reconstruct the current project state.
4. Decide what has completed, what is still running, and what is blocked.
5. Compare the current state against the approved plan.
6. Choose the next safe action.
7. In autonomous mode, do not stop just because a stale marker exists. Continue with one bounded local action when TASK_BOX/ROUTE_CANONICAL say requires_review=false and the work stays inside the allowed local boundary.
8. A workspace-write coding probe is allowed only when all of these are true: agent/workspace_write_policy.json exists, is valid JSON, sets enabled to true, lists exact relative writable paths and exact allowed commands; agent/SAFETY.md documents the same probe; agent/PLAN.md, agent/TODO.md, or agent/TASK_BOX.json requests the probe; and the project is an isolated demo or explicitly approved workspace. If any condition is missing, create a review-required proposal instead of writing files.
9. If an explicit workspace-write coding probe is active, edit only the allowlisted paths, run only the allowlisted commands, and summarize every command and file change in the final structured output.
10. If the next action is safe and allowed by agent/SAFETY.md, perform it when it is read-only inspection, report generation through the final structured output, project-local state reconcile, local queue/profile/taskbox authoring, bounded CPU eval, or an explicitly allowlisted workspace-write coding probe. For actions that write shared files, enqueue controlled GPU work, send externally, or promote results, create a review-required proposal instead of executing them.
11. Produce a concise but useful phase report.
12. Produce a proposed update to agent/STATE.md.
13. Produce a compact runtime state update for agent/RUNTIME_STATE.md. Keep it shorter than the proposed state and focused on last wakeup time, active experiments, latest observed metrics, blockers, and the next safe watch task.
14. Produce a concise morning brief for daily mode to read when the human returns.
15. If a durable research ledger update is necessary, output a complete ledger_update_markdown that starts with "# Research Ledger"; otherwise leave it empty. Do not output fragments as ledger replacements.
16. If blocked work needs human approval, output a concise proposal_markdown with purpose, command/profile if any, expected outputs, safety boundary, and stop condition.
17. Classify the report_type as progress, blocked, heartbeat, error, or recommend_pause.
18. Track no_progress_cycles conservatively: increment only when there is no new evidence, no blocker change, and no completed action; reset to 0 when meaningful progress occurs.
19. If no_progress_cycles is high or the same blocker repeats, set recommend_pause=true and explain the human decision needed.
20. Mark only truly dangerous or shared-side-effect decisions as requires_human_review. Do not escalate purely local unblockers into human review.
21. If this wakeup identifies an exact successor route, exact successor task, or exact next queue/profile object, emit it structurally instead of leaving the next step broad.
22. Use successor_task_draft for the next runnable task, task_profile_draft for exact local profile/package content, queue_request_draft for exact queue draft content, and route_canonical_update when the canonical route itself changed.
23. Separate queue draft from queue enqueue. A local queue draft may be prepared autonomously; queue enqueue should only be emitted as automatically executable when the queue contract is exact and TASK_BOX queue_policy sets allow_conditional_enqueue=true.
24. If the current TASK_BOX contract is missing topic alignment, claim scope, fair comparability, or value-of-information details, repair it structurally through task_box_update instead of only mentioning the gap in prose.
25. For bounded research or queue tasks, prefer adding or refining project_question, decision_relevance, claim_scope, forbidden_conclusions, diagnosis_target, fair_comparability, and value_of_information before asking humans for help.
26. If a decision-bearing result changes the route but no explicit successor task was written yet, set route_canonical_update.successor_contract_required=true and either emit successor_task_draft yourself or emit task_box_update that makes the next exact object unambiguous.
27. Always report which routed secondary skills you actually consulted through secondary_skills_consulted. If none were routed, return an empty array.

Hard restrictions:

- Do not kill, suspend, restart, or interfere with running training.
- Do not delete files.
- Do not launch new training.
- Do not execute GPUs directly from the sandbox shell. GPU queue/host evidence may still exist; treat sandbox visibility failures as advisory unless host-side evidence confirms a real outage.
- Do not modify code unless an explicit workspace-write coding probe is enabled by agent/workspace_write_policy.json and documented in agent/SAFETY.md with the exact file paths and allowed commands. Otherwise, do not modify code.
- Do not make git changes.
- Do not use network.
- Do not install packages.
- If evidence is insufficient, say so.
- Prefer a conservative report over speculative action.

The final output must follow the JSON schema.
`,

  schema: () => JSON.stringify({
    type: "object",
    required: [
      "timestamp_utc",
      "overall_status",
      "supervisor_mode",
      "primary_skill",
      "secondary_skills_consulted",
      "skill_route_reason",
      "skill_stop_condition",
      "permission_guardian_result",
      "report_type",
      "progress_changed",
      "no_progress_cycles",
      "recommend_pause",
      "work_cycle_summary",
      "inspection_commands_run",
      "completed_items",
      "running_items",
      "blocked_items",
      "next_safe_action",
      "requires_human_review",
      "review_scope",
      "review_resolver",
      "human_review_reason",
      "forbidden_actions_not_taken",
      "evidence",
      "state_update_markdown",
      "runtime_state_markdown",
      "morning_brief_markdown",
      "ledger_update_markdown",
      "proposal_markdown",
      "report_markdown",
      "successor_task_draft",
      "task_profile_draft",
      "queue_request_draft",
      "route_canonical_update",
      "task_box_update"
    ],
    properties: {
      timestamp_utc: { type: "string" },
      overall_status: {
        type: "string",
        enum: ["healthy", "running", "completed", "blocked", "uncertain", "error"]
      },
      supervisor_mode: {
        type: "string",
        enum: ["runner", "light", "audit", "standby"]
      },
      primary_skill: {
        type: "string",
        enum: [
          "watchdog-orchestrator",
          "watchdog-job-queue",
          "watchdog-gate-evaluator",
          "watchdog-report-curator",
          "watchdog-permission-guardian",
          "watchdog-handoff-writer",
          "watchdog-cleanup-auditor"
        ]
      },
      secondary_skills_consulted: {
        type: "array",
        items: { type: "string" }
      },
      skill_route_reason: { type: "string" },
      skill_stop_condition: { type: "string" },
      permission_guardian_result: {
        type: "string",
        enum: ["not_required", "passed", "blocked", "error"]
      },
      report_type: {
        type: "string",
        enum: ["progress", "blocked", "heartbeat", "error", "recommend_pause"]
      },
      progress_changed: { type: "boolean" },
      no_progress_cycles: { type: "integer", minimum: 0 },
      recommend_pause: { type: "boolean" },
      work_cycle_summary: { type: "string" },
      inspection_commands_run: { type: "array", items: { type: "string" } },
      completed_items: { type: "array", items: { type: "string" } },
      running_items: { type: "array", items: { type: "string" } },
      blocked_items: { type: "array", items: { type: "string" } },
      next_safe_action: {
        type: "object",
        required: ["kind", "description", "can_execute_automatically", "reason"],
        properties: {
          kind: {
            type: "string",
            enum: ["none", "report_only", "propose_review", "safe_script_candidate"]
          },
          description: { type: "string" },
          can_execute_automatically: { type: "boolean" },
          reason: { type: "string" }
        },
        additionalProperties: false
      },
      requires_human_review: { type: "boolean" },
      review_scope: {
        type: "string",
        enum: ["none", "report_only", "bookkeeping", "external_review", "unsafe_operation"]
      },
      review_resolver: {
        type: "string",
        enum: ["none", "supervisor", "human", "external"]
      },
      human_review_reason: { type: "string" },
      forbidden_actions_not_taken: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      state_update_markdown: { type: "string" },
      runtime_state_markdown: { type: "string" },
      morning_brief_markdown: { type: "string" },
      ledger_update_markdown: { type: "string" },
      proposal_markdown: { type: "string" },
      report_markdown: { type: "string" },
      successor_task_draft: { type: ["object", "null"], additionalProperties: true },
      task_profile_draft: { type: ["object", "null"], additionalProperties: true },
      queue_request_draft: { type: ["object", "null"], additionalProperties: true },
      route_canonical_update: { type: ["object", "null"], additionalProperties: true },
      task_box_update: { type: ["object", "null"], additionalProperties: true }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  bootstrapConversationTurnSchema: () => JSON.stringify({
    type: "object",
    required: [
      "assistant_reply",
      "open_questions",
      "suggested_next_step"
    ],
    properties: {
      assistant_reply: { type: "string" },
      open_questions: {
        type: "array",
        items: { type: "string" }
      },
      suggested_next_step: { type: "string" }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  bootstrapInstantiationSchema: () => JSON.stringify({
    type: "object",
    required: [
      "assistant_reply",
      "plan_md",
      "todo_md",
      "state_md",
      "safety_md",
      "daily_handoff_md",
      "ready_for_start_guard",
      "open_questions",
      "suggested_next_step"
    ],
    properties: {
      assistant_reply: { type: "string" },
      plan_md: { type: "string" },
      todo_md: { type: "string" },
      state_md: { type: "string" },
      safety_md: { type: "string" },
      daily_handoff_md: { type: "string" },
      ready_for_start_guard: { type: "boolean" },
      open_questions: {
        type: "array",
        items: { type: "string" }
      },
      suggested_next_step: { type: "string" }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  stateSchema: () => JSON.stringify({
    type: "object",
    required: ["schema_version", "mode", "requires_review", "tasks", "blocked_actions", "important_paths"],
    properties: {
      schema_version: { type: "integer" },
      updated_utc: { type: ["string", "null"] },
      mode: { type: "string", enum: ["observer", "project-local-worker", "gpu-queue-worker", "maintainer"] },
      requires_review: { type: "boolean" },
      active_task_id: { type: ["string", "null"] },
      route_task_id: { type: ["string", "null"] },
      active_branch: { type: ["string", "null"] },
      tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["task_id", "status", "allowed_runner"],
          properties: {
            task_id: { type: "string" },
            status: { type: "string", enum: ["pending", "queued", "running", "done", "failed", "rejected", "blocked"] },
            allowed_runner: { type: "string", enum: ["cpu", "gpu", "report_only"] },
            inputs: { type: "array", items: { type: "string" } },
            outputs: { type: "array", items: { type: "string" } },
            success_gates: { type: "array" },
            stop_conditions: { type: "array", items: { type: "string" } },
            next_allowed_tasks: { type: "array", items: { type: "string" } },
            requires_review_after: { type: "boolean" }
          },
          additionalProperties: true
        }
      },
      latest_completed_job: { type: ["string", "null"] },
      latest_gate_result: { type: ["object", "null"] },
      allowed_next_action: { type: "string" },
      blocked_actions: { type: "array", items: { type: "string" } },
      exact_next_task_id: { type: ["string", "null"] },
      exact_profile_path: { type: ["string", "null"] },
      exact_queue_draft_path: { type: ["string", "null"] },
      exact_next_object_path: { type: ["string", "null"] },
      required_successor_exactness: { type: "string" },
      successor_materialization_status: { type: "string" },
      experiment_gate_status: { type: "string" },
      experiment_decision_gate_required: { type: "boolean" },
      experiment_decision_gate_blocking: { type: "boolean" },
      owner_mode: { type: ["string", "null"] },
      current_allowed_step: { type: ["string", "null"] },
      important_paths: { type: "array", items: { type: "string" } }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  taskBoxSchema: () => JSON.stringify({
    type: "object",
    required: [
      "schema_version",
      "task_box_id",
      "route_id",
      "route_epoch",
      "requires_review",
      "allowed_actions",
      "blocked_actions",
      "allowed_write_paths",
      "queue_policy",
      "tasks"
    ],
    properties: {
      schema_version: { type: "integer" },
      updated_utc: { type: ["string", "null"] },
      owner: { type: "string" },
      task_box_id: { type: "string" },
      route_id: { type: "string" },
      route_epoch: { type: "string" },
      owner_mode: { type: ["string", "null"] },
      current_allowed_step: { type: ["string", "null"] },
      successor_contract_required: { type: "boolean" },
      active_task_id: { type: ["string", "null"] },
      route_task_id: { type: ["string", "null"] },
      exact_next_task_id: { type: ["string", "null"] },
      exact_profile_path: { type: ["string", "null"] },
      exact_queue_draft_path: { type: ["string", "null"] },
      exact_next_object_path: { type: ["string", "null"] },
      required_successor_exactness: { type: "string" },
      successor_materialization_status: { type: "string" },
      experiment_gate_status: { type: "string" },
      experiment_decision_gate_required: { type: "boolean" },
      experiment_decision_gate_blocking: { type: "boolean" },
      active_target: { type: "string" },
      project_question: { type: "string" },
      decision_relevance: { type: "string" },
      uncertainty_reduced_if_success: { type: "string" },
      uncertainty_reduced_if_failure: { type: "string" },
      claim_scope: { type: "string" },
      forbidden_conclusions: { type: "array", items: { type: "string" } },
      diagnosis_target: { type: "string" },
      fair_comparability: { type: "object" },
      value_of_information: { type: "object" },
      gate_policy: { type: "object" },
      requires_review: { type: "boolean" },
      allowed_actions: { type: "array", items: { type: "string" } },
      blocked_actions: { type: "array", items: { type: "string" } },
      success_gates: { type: "array", items: { type: "string" } },
      stop_conditions: { type: "array", items: { type: "string" } },
      allowed_write_paths: { type: "array", items: { type: "string" } },
      allowed_commands: { type: "array", items: { type: "string" } },
      queue_policy: { type: "object" },
      review_required_when: { type: "array", items: { type: "string" } },
      morning_brief_questions: { type: "array", items: { type: "string" } },
      tasks: { type: "array", items: { type: "object" } }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  routeCanonicalSchema: () => JSON.stringify({
    type: "object",
    required: [
      "schema_version",
      "route_id",
      "route_epoch",
      "owner_mode",
      "requires_review"
    ],
    properties: {
      schema_version: { type: "integer" },
      updated_utc: { type: ["string", "null"] },
      route_id: { type: "string" },
      route_epoch: { type: "string" },
      macro_goal: { type: "string" },
      active_ladder: { type: ["array", "string"] },
      current_allowed_step: { type: ["string", "null"] },
      blocked_downstream_steps: { type: "array", items: { type: "string" } },
      current_budget_contract: { type: "string" },
      main_provider_contract: { type: "string" },
      promotion_gates: { type: "array", items: { type: "string" } },
      owner_mode: { type: "string" },
      successor_contract_required: { type: "boolean" },
      requires_review: { type: "boolean" },
      active_task_id: { type: ["string", "null"] },
      exact_next_task_id: { type: ["string", "null"] },
      exact_profile_path: { type: ["string", "null"] },
      exact_queue_draft_path: { type: ["string", "null"] },
      exact_next_object_path: { type: ["string", "null"] },
      required_successor_exactness: { type: "string" },
      successor_materialization_status: { type: "string" },
      experiment_gate_status: { type: "string" },
      experiment_decision_gate_required: { type: "boolean" },
      experiment_decision_gate_blocking: { type: "boolean" }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  secondarySkillsSchema: () => JSON.stringify({
    type: "object",
    required: ["schema_version", "skills"],
    properties: {
      schema_version: { type: "integer" },
      skills: {
        type: "array",
        items: {
          type: "object",
          required: ["skill_id", "path", "selectors"],
          properties: {
            skill_id: { type: "string" },
            enabled: { type: "boolean" },
            path: { type: "string" },
            notes: { type: "string" },
            selectors: {
              type: "object",
              properties: {
                primary_skills: { type: "array", items: { type: "string" } },
                roles: { type: "array", items: { type: "string" } },
                supervisor_modes: { type: "array", items: { type: "string" } },
                task_capabilities: { type: "array", items: { type: "string" } }
              },
              additionalProperties: false
            }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  jobSchema: () => JSON.stringify({
    type: "object",
    required: ["job_id", "task_id", "created_utc", "runner", "command_profile", "expected_outputs", "max_runtime_minutes"],
    properties: {
      job_id: { type: "string" },
      task_id: { type: "string" },
      created_utc: { type: "string" },
      runner: { type: "string", enum: ["cpu", "gpu", "report_only"] },
      requested_gpu: { type: ["string", "integer", "null"] },
      command_profile: { type: "string" },
      command: { type: ["string", "null"] },
      expected_outputs: { type: "array", items: { type: "string" } },
      max_runtime_minutes: { type: "integer", minimum: 1 },
      status: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"] },
      log_path: { type: ["string", "null"] }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  gateSchema: () => JSON.stringify({
    type: "object",
    required: ["gates"],
    properties: {
      gates: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "path", "field", "op", "value"],
          properties: {
            name: { type: "string" },
            path: { type: "string" },
            field: { type: "string" },
            op: { type: "string", enum: [">", ">=", "<", "<=", "==", "!="] },
            value: {}
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  collectStatus: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
cd "$PROJECT_ROOT"

mkdir -p agent/status
OUT="agent/status/current.md"

preview_file() {
  local file="$1"
  local missing="$2"
  local limit="\${WATCHDOG_PREVIEW_BYTES:-12000}"
  if [[ ! "$limit" =~ ^[0-9]+$ ]] || [ "$limit" -lt 1000 ]; then
    limit=12000
  fi
  if [ ! -f "$file" ]; then
    echo "$missing"
    return
  fi
  local bytes
  bytes="$(wc -c < "$file" | tr -d ' ')"
  echo "Path: $file"
  echo "Bytes: $bytes"
  echo "Preview bytes: $limit"
  echo '\`\`\`'
  head -c "$limit" "$file" || true
  if [ "$bytes" -gt "$limit" ]; then
    echo
    echo "[truncated: $((bytes - limit)) bytes omitted]"
  fi
  echo
  echo '\`\`\`'
}

count_files() {
  local dir="$1"
  if [ -d "$dir" ]; then
    find "$dir" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' '
  else
    printf '0\\n'
  fi
}

write_queue_status() {
  local out="agent/status/QUEUE_STATUS.md"
  mkdir -p agent/status
  {
    echo "# Queue Status"
    echo
    echo "Updated: $(date -Is)"
    echo
    echo "## Summary"
    echo
    echo "- agent/queue/queued: $(count_files agent/queue/queued)"
    echo "- agent/queue/running: $(count_files agent/queue/running)"
    echo "- agent/queue/done: $(count_files agent/queue/done)"
    echo "- agent/queue/failed: $(count_files agent/queue/failed)"
    echo "- gpu_queue: $(count_files gpu_queue)"
    echo "- gpu_running: $(count_files gpu_running)"
    echo "- gpu_done: $(count_files gpu_done)"
    echo "- gpu_failed: $(count_files gpu_failed)"
    echo "- cpu_queue: $(count_files cpu_queue)"
    echo "- cpu_running: $(count_files cpu_running)"
    echo "- cpu_done: $(count_files cpu_done)"
    echo "- cpu_failed: $(count_files cpu_failed)"
    echo
    echo "## Recent Queue Files"
    echo
    for dir in agent/queue/queued agent/queue/running agent/queue/done agent/queue/failed gpu_queue gpu_running gpu_done gpu_failed cpu_queue cpu_running cpu_done cpu_failed; do
      if [ -d "$dir" ]; then
        find "$dir" -maxdepth 1 -type f -printf "%T@ %p %s\\n" 2>/dev/null | sort -nr | head -5 | while read -r _ path size; do
          echo "- $path (\${size:-unknown} bytes)"
        done
      fi
    done
    echo
    echo "## Log Summary"
    echo
    echo "- Tail included: no"
  } > "$out"
}

write_queue_status

{
  echo "# Current Project Snapshot"
  echo
  echo "Generated at: $(date -Is)"
  echo "Host: $(hostname)"
  echo "User: $(whoami)"
  echo "Project root: $PROJECT_ROOT"
  echo

  echo "## Watchdog runtime controls"
  echo
  echo "- Run count: \${WATCHDOG_RUN_COUNT:-unknown}"
  echo "- Compact every runs: \${WATCHDOG_COMPACT_EVERY_RUNS:-6}"
  echo "- Compaction due this cycle: \${WATCHDOG_COMPACTION_DUE:-0}"
  echo "- Watchdog role: \${WATCHDOG_ROLE:-runner}"
  echo "- Phase offset minutes: \${WATCHDOG_PHASE_OFFSET_MINUTES:-10}"
  echo "- Supervisor mode: \${WATCHDOG_SUPERVISOR_MODE:-runner}"
  echo "- Runner completed count: \${WATCHDOG_RUNNER_COMPLETED_COUNT:-\${WATCHDOG_RUNNER_RUN_COUNT:-unknown}}"
  echo "- Runner started count: \${WATCHDOG_RUNNER_STARTED_COUNT:-unknown}"
  echo "- Runner failure drift: \${WATCHDOG_RUNNER_FAILURE_DRIFT:-unknown}"
  echo "- Supervisor audit every runner runs: \${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS:-4}"
  echo "- Supervisor light follow-up: \${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP:-1}"
  echo "- Raw log tails included: \${WATCHDOG_INCLUDE_LOG_TAILS:-0}"
  if [ -f agent/control/PAUSE ]; then
    echo "- Pause: active"
    echo "- Pause file: agent/control/PAUSE"
  else
    echo "- Pause: inactive"
  fi
  echo "- XDG_CACHE_HOME: \${XDG_CACHE_HOME:-unset}"
  echo

  echo "## Git"
  echo
  echo "HEAD:"
  git rev-parse HEAD 2>/dev/null || echo "Not a git repository"
  echo
  echo "Status:"
  git status --short 2>/dev/null || echo "Not a git repository"
  echo

  echo "## GPU snapshot"
  echo
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits || true
  else
    echo "nvidia-smi not found"
  fi
  echo

  echo "## Relevant processes"
  echo
  ps -eo pid,ppid,user,etime,pcpu,pmem,args \\
    | grep -E 'python|torchrun|accelerate|deepspeed|train|eval' \\
    | grep -v grep \\
    | head -80 || true
  echo

  echo "## Plan"
  echo
  cat agent/PLAN.md 2>/dev/null || true
  echo

  echo "## Safety"
  echo
  cat agent/SAFETY.md 2>/dev/null || true
  echo

  echo "## TODO"
  echo
  cat agent/TODO.md 2>/dev/null || true
  echo

  echo "## Daily handoff"
  echo
  cat agent/DAILY_HANDOFF.md 2>/dev/null || echo "No daily handoff yet."
  echo

  echo "## Previous state"
  echo
  cat agent/STATE.md 2>/dev/null || true
  echo

  echo "## Machine state"
  echo
  preview_file agent/STATE.json "No STATE.json yet."
  echo

  echo "## Progress state"
  echo
  preview_file agent/PROGRESS_STATE.json "No PROGRESS_STATE.json yet."
  echo

  echo "## Runtime state"
  echo
  cat agent/RUNTIME_STATE.md 2>/dev/null || echo "No runtime state yet."
  echo

  echo "## Cooperation protocol"
  echo
  preview_file agent/WATCHDOG_PROTOCOL.md "No watchdog cooperation protocol yet."
  echo

  echo "## Canonical current state"
  echo
  preview_file agent/CURRENT_STATE.md "No CURRENT_STATE.md yet."
  echo

  echo "## Canonical run state"
  echo
  preview_file agent/RUN_STATE.json "No RUN_STATE.json yet."
  echo

  echo "## Next action"
  echo
  preview_file agent/NEXT_ACTION.md "No NEXT_ACTION.md yet."
  echo

  echo "## Blockers"
  echo
  preview_file agent/BLOCKERS.md "No BLOCKERS.md yet."
  echo

  echo "## Review pending"
  echo
  preview_file agent/REVIEW_PENDING.md "No REVIEW_PENDING.md yet."
  echo

  echo "## Anti-snowball"
  echo
  preview_file agent/ANTI_SNOWBALL.md "No ANTI_SNOWBALL.md yet."
  echo

  echo "## Experiment ledger"
  echo
  preview_file agent/EXPERIMENT_LEDGER.md "No EXPERIMENT_LEDGER.md yet."
  echo

  echo "## Queue status"
  echo
  preview_file agent/status/QUEUE_STATUS.md "No queue status yet."
  echo

  echo "## Supervisor mode"
  echo
  preview_file agent/status/SUPERVISOR_MODE.json "No supervisor mode state yet."
  echo

  echo "## Research ledger"
  echo
  preview_file research/RESEARCH_LEDGER.md "No research ledger yet."
  echo

  echo "## Watchdog skill router"
  echo
  preview_file agent/SKILL_ROUTER.md "No skill router found."
  echo

  echo "## Deterministic skill route"
  echo
  preview_file agent/status/SKILL_ROUTE.json "No deterministic skill route found."
  echo

  echo "## Runtime validation"
  echo
  preview_file agent/status/RUNTIME_VALIDATION.json "No runtime validation report found."
  echo

  echo "## Previous proposed state"
  echo
  preview_file agent/STATE.proposed.md "No previous proposed state."
  echo

  echo "## Latest watchdog report"
  echo
  preview_file agent/reports/latest.md "No latest watchdog report yet."
  echo

  echo "## Previous morning brief"
  echo
  preview_file agent/MORNING_BRIEF.md "No previous morning brief yet."
  echo

  echo "## Recent experiment logs"
  echo

  log_roots=()
  for dir in runs logs outputs; do
    if [ -d "$dir" ]; then
      log_roots+=("$dir")
    fi
  done

  if [ "\${#log_roots[@]}" -eq 0 ]; then
    echo "No runs/, logs/, or outputs/ directories found."
  else
    find "\${log_roots[@]}" -type f \\( -name "*.log" -o -name "*.txt" -o -name "*.json" -o -name "*.jsonl" \\) 2>/dev/null \\
      -printf "%T@ %p\\n" \\
      | sort -nr \\
      | head -10 \\
      | while read -r _ path; do
          echo
          size="$(wc -c < "$path" 2>/dev/null | tr -d ' ' || echo unknown)"
          mtime="$(date -r "$path" -Is 2>/dev/null || echo unknown)"
          echo "### $path"
          echo
          echo "- Bytes: $size"
          echo "- Modified: $mtime"
          echo "- Tail included: \${WATCHDOG_INCLUDE_LOG_TAILS:-0}"
          if [ "\${WATCHDOG_INCLUDE_LOG_TAILS:-0}" = "1" ]; then
            echo
            echo '\`\`\`'
            tail -n 80 "$path" || true
            echo '\`\`\`'
          fi
        done || true
  fi
} > "$OUT"
`,

  makePrompt: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
cd "$PROJECT_ROOT"

cat agent/prompts/wakeup.md
echo
echo "---- BEGIN CURRENT SNAPSHOT ----"
cat agent/status/current.md
echo
echo "---- END CURRENT SNAPSHOT ----"
`,

  runWatchdog: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
ENV_CODEX_BIN="\${CODEX_BIN-}"
ENV_CODEX_HOME="\${CODEX_HOME-}"
ENV_CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE-}"
ENV_WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES-}"
ENV_WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES-}"
ENV_WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS-}"
ENV_WATCHDOG_ROLE="\${WATCHDOG_ROLE-}"
ENV_WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES-}"
ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP-}"
ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS-}"
ENV_WATCHDOG_INITIAL_DELAY_MINUTES="\${WATCHDOG_INITIAL_DELAY_MINUTES-}"
ENV_WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX-}"

if [ -f "$PROJECT_ROOT/agent/watchdog.env" ]; then
  set -a
  . "$PROJECT_ROOT/agent/watchdog.env"
  set +a
fi

[ -n "$ENV_CODEX_BIN" ] && CODEX_BIN="$ENV_CODEX_BIN"
[ -n "$ENV_CODEX_HOME" ] && CODEX_HOME="$ENV_CODEX_HOME"
[ -n "$ENV_CODEX_SANDBOX_MODE" ] && CODEX_SANDBOX_MODE="$ENV_CODEX_SANDBOX_MODE"
[ -n "$ENV_WATCHDOG_INTERVAL_MINUTES" ] && WATCHDOG_INTERVAL_MINUTES="$ENV_WATCHDOG_INTERVAL_MINUTES"
[ -n "$ENV_WATCHDOG_TIMEOUT_MINUTES" ] && WATCHDOG_TIMEOUT_MINUTES="$ENV_WATCHDOG_TIMEOUT_MINUTES"
[ -n "$ENV_WATCHDOG_COMPACT_EVERY_RUNS" ] && WATCHDOG_COMPACT_EVERY_RUNS="$ENV_WATCHDOG_COMPACT_EVERY_RUNS"
[ -n "$ENV_WATCHDOG_ROLE" ] && WATCHDOG_ROLE="$ENV_WATCHDOG_ROLE"
[ -n "$ENV_WATCHDOG_PHASE_OFFSET_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_PHASE_OFFSET_MINUTES"
[ -n "$ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" ] && WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="$ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP"
[ -n "$ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" ] && WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS"
[ -z "\${WATCHDOG_PHASE_OFFSET_MINUTES:-}" ] && [ -n "$ENV_WATCHDOG_INITIAL_DELAY_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_INITIAL_DELAY_MINUTES"
[ -n "$ENV_WATCHDOG_SERVICE_PREFIX" ] && WATCHDOG_SERVICE_PREFIX="$ENV_WATCHDOG_SERVICE_PREFIX"

CODEX_BIN="\${CODEX_BIN:-codex}"
CODEX_HOME="\${CODEX_HOME:-$HOME/.codex-watcher}"
CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE:-read-only}"
WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES:-30}"
WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES:-25}"
WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS:-6}"
WATCHDOG_ROLE="\${WATCHDOG_ROLE:-runner}"
WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES:-10}"
WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP:-1}"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS:-4}"
WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX:-codex-watchdog}"

export PATH="\${WATCHDOG_LOCAL_BIN:-$HOME/.local/bin}:$PATH"
export CODEX_HOME
export CUDA_VISIBLE_DEVICES=""

cd "$PROJECT_ROOT"

sanitize_minutes() {
  local name="$1"
  local value="$2"
  local min="$3"
  local fallback="$4"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt "$min" ]; then
    echo "warning: ignoring invalid $name=$value; using $fallback" >&2
    printf '%s\\n' "$fallback"
    return
  fi
  printf '%s\\n' "$value"
}

workspace_write_allowed() {
  python3 - <<'PY'
import json
from pathlib import Path
p = Path("agent/workspace_write_policy.json")
if not p.exists():
    raise SystemExit(1)
try:
    data = json.loads(p.read_text())
except Exception:
    raise SystemExit(1)
if data.get("enabled") is not True:
    raise SystemExit(1)
writable = data.get("writable_paths")
commands = data.get("allowed_commands")
if not isinstance(writable, list) or not writable or not isinstance(commands, list) or not commands:
    raise SystemExit(1)
for item in writable:
    if not isinstance(item, str) or not item.strip() or item.startswith("/") or ".." in item.replace("\\\\", "/").split("/"):
        raise SystemExit(1)
for item in commands:
    if not isinstance(item, str) or not item.strip():
        raise SystemExit(1)
PY
}

if [ "$CODEX_SANDBOX_MODE" = "workspace-write" ] && ! workspace_write_allowed; then
  echo "warning: workspace-write requested but agent/workspace_write_policy.json is missing or invalid; using read-only" >&2
  CODEX_SANDBOX_MODE="read-only"
fi
if [ "$CODEX_SANDBOX_MODE" != "read-only" ] && [ "$CODEX_SANDBOX_MODE" != "workspace-write" ]; then
  echo "warning: invalid CODEX_SANDBOX_MODE=$CODEX_SANDBOX_MODE; using read-only" >&2
  CODEX_SANDBOX_MODE="read-only"
fi
WATCHDOG_INTERVAL_MINUTES="$(sanitize_minutes WATCHDOG_INTERVAL_MINUTES "$WATCHDOG_INTERVAL_MINUTES" 5 30)"
WATCHDOG_TIMEOUT_MINUTES="$(sanitize_minutes WATCHDOG_TIMEOUT_MINUTES "$WATCHDOG_TIMEOUT_MINUTES" 1 25)"
WATCHDOG_COMPACT_EVERY_RUNS="$(sanitize_minutes WATCHDOG_COMPACT_EVERY_RUNS "$WATCHDOG_COMPACT_EVERY_RUNS" 0 6)"
WATCHDOG_PHASE_OFFSET_MINUTES="$(sanitize_minutes WATCHDOG_PHASE_OFFSET_MINUTES "$WATCHDOG_PHASE_OFFSET_MINUTES" 0 10)"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$(sanitize_minutes WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS "$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" 1 24)"
case "$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" in 1|true|yes|on) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="1" ;; *) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="0" ;; esac
case "$WATCHDOG_ROLE" in runner|supervisor) ;; *) WATCHDOG_ROLE="runner" ;; esac
export CODEX_BIN CODEX_HOME CODEX_SANDBOX_MODE WATCHDOG_INTERVAL_MINUTES WATCHDOG_TIMEOUT_MINUTES WATCHDOG_COMPACT_EVERY_RUNS WATCHDOG_ROLE WATCHDOG_PHASE_OFFSET_MINUTES WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS WATCHDOG_SERVICE_PREFIX

mkdir -p agent/reports agent/logs agent/status agent/pending/review_required "$CODEX_HOME"

LOCK_FILE="agent/.watchdog.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another watchdog run is active; exiting."
  exit 0
fi

RUN_COUNT_FILE="agent/status/run_count"
if [ -f "$RUN_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUN_COUNT_FILE"; then
  WATCHDOG_RUN_COUNT="$(cat "$RUN_COUNT_FILE")"
else
  WATCHDOG_RUN_COUNT="0"
fi
WATCHDOG_RUN_COUNT="$((WATCHDOG_RUN_COUNT + 1))"
printf '%s\\n' "$WATCHDOG_RUN_COUNT" > "$RUN_COUNT_FILE"
WATCHDOG_COMPACTION_DUE="0"
if [ "$WATCHDOG_COMPACT_EVERY_RUNS" -gt 0 ] && [ "$((WATCHDOG_RUN_COUNT % WATCHDOG_COMPACT_EVERY_RUNS))" -eq 0 ]; then
  WATCHDOG_COMPACTION_DUE="1"
fi

RUNNER_COUNT_FILE="agent/status/runner_run_count"
RUNNER_COMPLETED_COUNT_FILE="agent/status/runner_completed_count"
if [ "$WATCHDOG_ROLE" = "runner" ]; then
  if [ -f "$RUNNER_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUNNER_COUNT_FILE"; then
    WATCHDOG_RUNNER_RUN_COUNT="$(cat "$RUNNER_COUNT_FILE")"
  else
    WATCHDOG_RUNNER_RUN_COUNT="0"
  fi
  WATCHDOG_RUNNER_RUN_COUNT="$((WATCHDOG_RUNNER_RUN_COUNT + 1))"
  WATCHDOG_RUNNER_STARTED_COUNT="$WATCHDOG_RUNNER_RUN_COUNT"
  WATCHDOG_RUNNER_COMPLETED_COUNT=""
  WATCHDOG_RUNNER_FAILURE_DRIFT="0"
  printf '%s\\n' "$WATCHDOG_RUNNER_RUN_COUNT" > "$RUNNER_COUNT_FILE"
  WATCHDOG_SUPERVISOR_MODE="runner"
  SUPERVISOR_MODE_TMP="agent/status/SUPERVISOR_MODE.json.tmp"
  cat > "$SUPERVISOR_MODE_TMP" <<JSON
{
  "schema_version": 1,
  "updated_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "role": "runner",
  "mode": "runner",
  "runner_run_count": $WATCHDOG_RUNNER_RUN_COUNT,
  "reason": "runner wakeup increments the runner cycle counter"
}
JSON
  mv "$SUPERVISOR_MODE_TMP" agent/status/SUPERVISOR_MODE.json
else
  WATCHDOG_RUNNER_RUN_COUNT="0"
  WATCHDOG_RUNNER_COMPLETED_COUNT="0"
  WATCHDOG_RUNNER_STARTED_COUNT="0"
  if [ -f "$RUNNER_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUNNER_COUNT_FILE"; then
    WATCHDOG_RUNNER_STARTED_COUNT="$(cat "$RUNNER_COUNT_FILE")"
  fi
  if [ -f "$RUNNER_COMPLETED_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUNNER_COMPLETED_COUNT_FILE"; then
    WATCHDOG_RUNNER_COMPLETED_COUNT="$(cat "$RUNNER_COMPLETED_COUNT_FILE")"
  fi
  WATCHDOG_RUNNER_RUN_COUNT="$WATCHDOG_RUNNER_COMPLETED_COUNT"
  if [ "$WATCHDOG_RUNNER_STARTED_COUNT" -ge "$WATCHDOG_RUNNER_COMPLETED_COUNT" ]; then
    WATCHDOG_RUNNER_FAILURE_DRIFT="$((WATCHDOG_RUNNER_STARTED_COUNT - WATCHDOG_RUNNER_COMPLETED_COUNT))"
  else
    WATCHDOG_RUNNER_FAILURE_DRIFT="0"
  fi
  export WATCHDOG_RUNNER_RUN_COUNT WATCHDOG_RUNNER_COMPLETED_COUNT WATCHDOG_RUNNER_STARTED_COUNT WATCHDOG_RUNNER_FAILURE_DRIFT
  WATCHDOG_SUPERVISOR_MODE="$(python3 - <<'PY'
import json
import os
import hashlib
from datetime import datetime, timezone
from pathlib import Path

def int_env(name, fallback):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except Exception:
        return fallback
    return value if value >= 0 else fallback

def load_json(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return {}

def text(path):
    try:
        return Path(path).read_text(errors="ignore")
    except Exception:
        return ""

TRUE_VALUES = {"1", "true", "yes", "on", "required"}
REVIEW_STATES = {"pending_send", "review_required_no_bundle"}
BLOCKER_TYPES = {"permission", "reviewer", "allowlist", "stale_state"}

def field_value(raw_text, key):
    key = key.lower()
    for line in raw_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("-"):
            stripped = stripped[1:].strip()
        if ":" not in stripped:
            continue
        left, right = stripped.split(":", 1)
        if left.strip().lower() == key:
            return right.strip().lower()
    return ""

def is_true(value):
    return str(value or "").strip().lower() in TRUE_VALUES

def normalize_marker_text(raw_text):
    lines = []
    for line in raw_text.splitlines():
        lowered = line.lower()
        if "updated:" in lowered or "timestamp" in lowered or "run id" in lowered or "run_id" in lowered:
            continue
        if lowered.strip().startswith("#"):
            continue
        lines.append(" ".join(lowered.split()))
    return "\\n".join(lines)

def atomic_write_json(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\\n")
    tmp.replace(target)

def append_event(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\\n")

runner_completed_count = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
runner_started_count = int_env("WATCHDOG_RUNNER_STARTED_COUNT", runner_completed_count)
runner_failure_drift = max(0, runner_started_count - runner_completed_count)
audit_every = max(1, int_env("WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS", 4))
light_enabled = os.environ.get("WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP", "1") in {"1", "true", "yes", "on"}
state_path = Path("agent/status/supervisor_state.json")
state = load_json(state_path)
last_seen = int(state.get("last_seen_runner_completed_count") or state.get("last_seen_runner_run_count") or 0)
last_light = int(state.get("last_light_runner_completed_count") or 0)
last_audit = int(state.get("last_audit_runner_completed_count") or state.get("last_audit_runner_run_count") or 0)
run_state = load_json("agent/RUN_STATE.json")
review_text = text("agent/REVIEW_PENDING.md")
blockers_text = text("agent/BLOCKERS.md")
blocker = str(run_state.get("blocker_type") or "").lower()

review_state = field_value(review_text, "state")
review_requires = is_true(field_value(review_text, "requires_human_review"))
review_pending_send = is_true(field_value(review_text, "pending_send"))
review_marker = review_state in REVIEW_STATES or review_requires or review_pending_send
run_state_marker = blocker in {"permission", "reviewer", "stale_state"}
blocker_type = field_value(blockers_text, "blocker type")
blockers_required = is_true(field_value(blockers_text, "required"))
blockers_marker = blocker_type in BLOCKER_TYPES or blockers_required
marker_pending = review_marker or run_state_marker or blockers_marker
marker_basis = "\\n".join([blocker, normalize_marker_text(review_text)[:2000], normalize_marker_text(blockers_text)[:2000]])
marker_fingerprint = hashlib.sha256(marker_basis.encode("utf-8", errors="ignore")).hexdigest()[:16] if marker_pending else ""
last_actioned_marker_fingerprint = str(state.get("last_actioned_marker_fingerprint") or state.get("last_marker_fingerprint") or "")
marker_changed = marker_pending and marker_fingerprint != last_actioned_marker_fingerprint
new_runner_cycle = runner_completed_count > last_seen
audit_due = runner_completed_count > 0 and (runner_completed_count - last_audit) >= audit_every
drift_audit_due = runner_failure_drift >= 3

if drift_audit_due:
    mode = "audit"
    reason = f"runtime audit due: runner started/completed drift is {runner_failure_drift}"
elif audit_due:
    mode = "audit"
    reason = f"heavy audit due after {runner_completed_count - last_audit} completed runner cycle(s)"
elif light_enabled and (new_runner_cycle or marker_changed):
    mode = "light"
    if new_runner_cycle:
        reason = "light follow-up after a newly completed runner cycle"
    else:
        reason = "light follow-up for changed reviewer/blocker marker"
else:
    mode = "standby"
    if marker_pending:
        reason = "reviewer/blocker marker already seen; no new completed runner cycle and heavy audit cadence not due"
    else:
        reason = "no new completed runner cycle and heavy audit cadence not due"

updated_utc = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
decision_id = f"sup_{updated_utc.replace('-', '').replace(':', '').replace('T', '_').replace('Z', '')}_{runner_completed_count}_{mode}"
payload = {
    "schema_version": 2,
    "updated_utc": updated_utc,
    "role": "supervisor",
    "mode": mode,
    "runner_run_count": runner_completed_count,
    "runner_completed_count": runner_completed_count,
    "runner_started_count": runner_started_count,
    "runner_failure_drift": runner_failure_drift,
    "last_seen_runner_run_count": last_seen,
    "last_seen_runner_completed_count": last_seen,
    "last_light_runner_completed_count": last_light,
    "last_audit_runner_run_count": last_audit,
    "last_audit_runner_completed_count": last_audit,
    "audit_every_runner_runs": audit_every,
    "light_followup_enabled": light_enabled,
    "marker_pending": marker_pending,
    "marker_sources": {
        "REVIEW_PENDING.md": review_marker,
        "BLOCKERS.md": blockers_marker,
        "RUN_STATE.blocker_type": blocker if run_state_marker else "",
    },
    "marker_fingerprint": marker_fingerprint,
    "last_marker_fingerprint": last_actioned_marker_fingerprint,
    "last_actioned_marker_fingerprint": last_actioned_marker_fingerprint,
    "decision": {
        "decision_id": decision_id,
        "mode": mode,
        "status": "selected",
        "selected_at": updated_utc,
        "target_runner_completed_count": runner_completed_count,
        "reason": reason,
    },
    "reason": reason,
}
atomic_write_json(state_path, payload)
atomic_write_json("agent/status/SUPERVISOR_MODE.json", payload)
append_event("agent/status/SUPERVISOR_MODE.events.jsonl", {
    "event": "selected",
    "decision_id": decision_id,
    "timestamp": updated_utc,
    "mode": mode,
    "reason": reason,
    "runner_started_count": runner_started_count,
    "runner_completed_count": runner_completed_count,
    "runner_failure_drift": runner_failure_drift,
    "marker_pending": marker_pending,
    "marker_fingerprint": marker_fingerprint,
})
print(mode)
PY
)"
fi
export WATCHDOG_RUN_COUNT WATCHDOG_COMPACTION_DUE WATCHDOG_RUNNER_RUN_COUNT WATCHDOG_RUNNER_COMPLETED_COUNT WATCHDOG_RUNNER_STARTED_COUNT WATCHDOG_RUNNER_FAILURE_DRIFT WATCHDOG_SUPERVISOR_MODE

TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
JSON_OUT="agent/reports/\${TS}.json"
MD_OUT="agent/reports/\${TS}.md"
JSONL_OUT="agent/reports/\${TS}.events.jsonl"
STDERR_OUT="agent/reports/\${TS}.stderr.log"
RENDER_STDERR_OUT="agent/reports/\${TS}.render.stderr.log"
COLLECT_STDOUT_OUT="agent/reports/\${TS}.collect.stdout.log"
COLLECT_STDERR_OUT="agent/reports/\${TS}.collect.stderr.log"
PROMPT_OUT="agent/reports/\${TS}.prompt.md"
PROMPT_STDERR_OUT="agent/reports/\${TS}.prompt.stderr.log"
VALIDATE_STDOUT_OUT="agent/reports/\${TS}.validate.stdout.log"
VALIDATE_STDERR_OUT="agent/reports/\${TS}.validate.stderr.log"
ROUTE_STDOUT_OUT="agent/reports/\${TS}.route.stdout.log"
ROUTE_STDERR_OUT="agent/reports/\${TS}.route.stderr.log"

supervisor_reconciliation_changed() {
  python3 - <<'SUPRECONCILEPY'
import json
from pathlib import Path

path = Path("agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json")
try:
    payload = json.loads(path.read_text())
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if payload.get("changed") is True else 1)
SUPRECONCILEPY
}

write_supervisor_reconciliation_report() {
  TS="$TS" JSON_OUT="$JSON_OUT" MD_OUT="$MD_OUT" JSONL_OUT="$JSONL_OUT" python3 - <<'SUPRECONCILEREPORT'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

def read_json(path, fallback=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return fallback

def int_env(name, fallback):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except Exception:
        return fallback
    return value if value >= 0 else fallback

def atomic_write_json(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\\n")
    tmp.replace(target)

def append_jsonl(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\\n")

def utc_from_ts(ts):
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

ts = os.environ.get("TS", "")
updated = utc_from_ts(ts)
payload = read_json("agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json", {}) or {}
results = payload.get("results") if isinstance(payload.get("results"), list) else []
safety = payload.get("safety_boundary") if isinstance(payload.get("safety_boundary"), list) else []
json_out = Path(os.environ["JSON_OUT"])
md_out = Path(os.environ["MD_OUT"])
jsonl_out = Path(os.environ["JSONL_OUT"])

report = {
    "timestamp_utc": updated,
    "kind": "supervisor_stale_state_reconciliation",
    "overall_status": "completed" if payload.get("changed") is True else "uncertain",
    "primary_skill": "watchdog-handoff-writer",
    "work_cycle_summary": "Deterministic supervisor stale-state reconciliation completed before Codex reasoning.",
    "reconciliation": payload,
}
json_out.write_text(json.dumps(report, indent=2) + "\\n")

lines = [
    "# Supervisor Stale-State Reconciliation",
    "",
    f"Timestamp: {updated}",
    "",
    "Deterministic reconciliation helper reported changed=true; Codex reasoning was not launched for this wakeup.",
    "",
    "## Results",
    "",
]
if results:
    for item in results:
        if isinstance(item, dict):
            stage = item.get("stage") or item.get("target") or "unknown"
            changed = item.get("changed")
            note = item.get("status_note") or item.get("note") or ""
            lines.append(f"- {stage}: changed={changed}; note={note}")
else:
    lines.append("- changed=true")
lines.extend(["", "## Safety Boundary", ""])
if safety:
    lines.extend(f"- {item}" for item in safety)
else:
    lines.extend([
        "- No code edits approved.",
        "- No CPU/GPU execution approved.",
        "- No queue/training approved.",
        "- No dataset/checkpoint mutation approved.",
        "- No external send approved.",
        "- No model promotion claim approved.",
    ])
lines.extend(["", "## Source", "", "- agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json", ""])
md_out.write_text("\\n".join(lines))

append_jsonl(jsonl_out, {
    "event": "supervisor_stale_state_reconciliation",
    "timestamp": updated,
    "changed": payload.get("changed") is True,
})

state_path = Path("agent/status/supervisor_state.json")
state = read_json(state_path, {}) or {}
decision = dict(state.get("decision") or {})
mode = decision.get("mode") or state.get("mode") or os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")
target_count = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
try:
    target_count = int(decision.get("target_runner_completed_count", target_count))
except Exception:
    pass
decision["mode"] = mode
decision["target_runner_completed_count"] = target_count
decision["status"] = "completed"
decision["completed_at"] = updated
decision["completion_reason"] = "supervisor_stale_state_reconciliation"
state["schema_version"] = 2
state["updated_utc"] = updated
state["role"] = "supervisor"
state["mode"] = mode
state["runner_completed_count"] = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
state["runner_started_count"] = int_env("WATCHDOG_RUNNER_STARTED_COUNT", state["runner_completed_count"])
state["runner_failure_drift"] = int_env("WATCHDOG_RUNNER_FAILURE_DRIFT", max(0, state["runner_started_count"] - state["runner_completed_count"]))
state["last_seen_runner_completed_count"] = max(int(state.get("last_seen_runner_completed_count") or state.get("last_seen_runner_run_count") or 0), target_count)
state["last_seen_runner_run_count"] = state["last_seen_runner_completed_count"]
if mode == "light":
    state["last_light_runner_completed_count"] = max(int(state.get("last_light_runner_completed_count") or 0), target_count)
if mode == "audit":
    state["last_audit_runner_completed_count"] = max(int(state.get("last_audit_runner_completed_count") or state.get("last_audit_runner_run_count") or 0), target_count)
    state["last_audit_runner_run_count"] = state["last_audit_runner_completed_count"]
if mode in {"light", "audit"} and state.get("marker_pending") and state.get("marker_fingerprint"):
    state["last_actioned_marker_fingerprint"] = state.get("marker_fingerprint", "")
    state["last_marker_fingerprint"] = state.get("marker_fingerprint", "")
state["decision"] = decision
atomic_write_json(state_path, state)
atomic_write_json("agent/status/SUPERVISOR_MODE.json", state)
append_jsonl("agent/status/SUPERVISOR_MODE.events.jsonl", {
    "event": "completed",
    "decision_id": decision.get("decision_id", ""),
    "timestamp": updated,
    "mode": mode,
    "runner_completed_count": target_count,
    "completion_reason": "supervisor_stale_state_reconciliation",
})
SUPRECONCILEREPORT
}

if [ -f agent/control/PAUSE ]; then
  {
    echo "# Codex Watchdog Paused"
    echo
    echo "Timestamp: $TS"
    echo
    echo "The guard is paused because agent/control/PAUSE exists. No Codex reasoning cycle was started."
    echo
    echo "## Pause file"
    echo '\`\`\`'
    cat agent/control/PAUSE || true
    echo '\`\`\`'
    echo
    echo "To resume, remove agent/control/PAUSE or run:"
    echo
    echo '\`\`\`bash'
    echo "./agent/bin/watchdog resume"
    echo '\`\`\`'
  } > "$MD_OUT"
  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  echo "[$(date -Is)] watchdog is paused; report written to $MD_OUT"
  exit 0
fi

if [ "$WATCHDOG_ROLE" = "supervisor" ] && [ -f agent/bin/supervisor_reconcile_stale_state.py ]; then
  mkdir -p agent/status
  echo "[$(date -Is)] running supervisor stale-state reconciliation helper"
  cat > agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json <<'JSON'
{
  "schema_version": 1,
  "kind": "supervisor_stale_state_reconciliation",
  "changed": false,
  "reset_before_helper": true
}
JSON
  if ! python3 agent/bin/supervisor_reconcile_stale_state.py > agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.stdout.log 2> agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.stderr.log; then
    echo "warning: supervisor stale-state reconciliation helper failed; continuing to normal watchdog route" >&2
  elif supervisor_reconciliation_changed; then
    write_supervisor_reconciliation_report
    ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
    echo "[$(date -Is)] supervisor reconciliation changed state; report written to $MD_OUT"
    exit 0
  fi
fi

echo "[$(date -Is)] routing watchdog skill"
if ! python3 agent/bin/route_skill.py > "$ROUTE_STDOUT_OUT" 2> "$ROUTE_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Skill Route Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "route_skill.py failed before Codex reasoning started."
    echo
    echo "## stdout"
    echo '\`\`\`'
    tail -n 200 "$ROUTE_STDOUT_OUT" || true
    echo '\`\`\`'
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$ROUTE_STDERR_OUT" || true
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi

echo "[$(date -Is)] validating runtime"
if ! python3 agent/bin/validate_runtime.py > "$VALIDATE_STDOUT_OUT" 2> "$VALIDATE_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Runtime Validation Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "validate_runtime.py failed before Codex reasoning started."
    echo
    echo "## stdout"
    echo '\`\`\`'
    tail -n 200 "$VALIDATE_STDOUT_OUT" || true
    echo '\`\`\`'
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$VALIDATE_STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## Validation JSON"
    echo
    echo "See agent/status/RUNTIME_VALIDATION.json"
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi

echo "[$(date -Is)] collecting status"
if ! ./agent/bin/collect_status.sh > "$COLLECT_STDOUT_OUT" 2> "$COLLECT_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Collect Status Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "collect_status.sh failed before Codex reasoning started."
    echo
    echo "## stdout"
    echo '\`\`\`'
    tail -n 200 "$COLLECT_STDOUT_OUT" || true
    echo '\`\`\`'
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$COLLECT_STDERR_OUT" || true
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi

set +e
./agent/bin/make_prompt.sh > "$PROMPT_OUT" 2> "$PROMPT_STDERR_OUT"
PROMPT_STATUS="$?"
set -e

if [ "$PROMPT_STATUS" -ne 0 ]; then
  {
    echo "# Codex Watchdog Prompt Build Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "make_prompt.sh failed before Codex reasoning started."
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$PROMPT_STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## partial prompt preview"
    echo '\`\`\`markdown'
    head -c 4000 "$PROMPT_OUT" 2>/dev/null || true
    echo
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit "$PROMPT_STATUS"
fi

echo "[$(date -Is)] running Codex reasoning"

set +e
timeout "\${WATCHDOG_TIMEOUT_MINUTES}m" \\
  "$CODEX_BIN" --ask-for-approval never exec \\
    --cd "$PROJECT_ROOT" \\
    --skip-git-repo-check \\
    --sandbox "$CODEX_SANDBOX_MODE" \\
    --output-schema "agent/schemas/watch_decision.schema.json" \\
    --output-last-message "$JSON_OUT" \\
    --json \\
    - \\
  < "$PROMPT_OUT" \\
  > "$JSONL_OUT" \\
  2> "$STDERR_OUT"
CODEX_STATUS="$?"
set -e

if [ "$CODEX_STATUS" -ne 0 ]; then
  echo "[$(date -Is)] codex exec failed with status $CODEX_STATUS; building offline fallback report"
  export WATCHDOG_CODEX_STATUS="$CODEX_STATUS"
  export WATCHDOG_CODEX_FAILED_FALLBACK="1"
  if python3 agent/bin/build_fallback_report.py "$JSON_OUT" "$STDERR_OUT" \\
    && python3 agent/bin/render_report.py "$JSON_OUT" > "$MD_OUT" 2> "$RENDER_STDERR_OUT"; then
    ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
    echo "[$(date -Is)] fallback report written to $MD_OUT"
    exit 0
  fi

  {
    echo "# Codex Watchdog Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "Codex exited with status: $CODEX_STATUS, and fallback rendering also failed."
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## fallback render stderr"
    echo '\`\`\`'
    tail -n 200 "$RENDER_STDERR_OUT" || true
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit "$CODEX_STATUS"
fi

export WATCHDOG_CODEX_STATUS="$CODEX_STATUS"
export WATCHDOG_CODEX_FAILED_FALLBACK="0"
if ! python3 agent/bin/render_report.py "$JSON_OUT" > "$MD_OUT" 2> "$RENDER_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Render Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "Codex finished, but render_report.py failed."
    echo
    echo "## Render stderr"
    echo '\`\`\`'
    tail -n 200 "$RENDER_STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## JSON output path"
    echo
    echo "$JSON_OUT"
    echo
    echo "## JSON preview"
    echo '\`\`\`json'
    head -c 4000 "$JSON_OUT" 2>/dev/null || true
    echo
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi
ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md

echo "[$(date -Is)] report written to $MD_OUT"
`,

  watchdogGuard: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
ACTION="\${1:-status}"
ENV_CODEX_BIN="\${CODEX_BIN-}"
ENV_CODEX_HOME="\${CODEX_HOME-}"
ENV_CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE-}"
ENV_WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES-}"
ENV_WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES-}"
ENV_WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS-}"
ENV_WATCHDOG_ROLE="\${WATCHDOG_ROLE-}"
ENV_WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES-}"
ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP-}"
ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS-}"
ENV_WATCHDOG_INITIAL_DELAY_MINUTES="\${WATCHDOG_INITIAL_DELAY_MINUTES-}"
ENV_WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX-}"

if [ -f "$PROJECT_ROOT/agent/watchdog.env" ]; then
  set -a
  . "$PROJECT_ROOT/agent/watchdog.env"
  set +a
fi

[ -n "$ENV_CODEX_BIN" ] && CODEX_BIN="$ENV_CODEX_BIN"
[ -n "$ENV_CODEX_HOME" ] && CODEX_HOME="$ENV_CODEX_HOME"
[ -n "$ENV_CODEX_SANDBOX_MODE" ] && CODEX_SANDBOX_MODE="$ENV_CODEX_SANDBOX_MODE"
[ -n "$ENV_WATCHDOG_INTERVAL_MINUTES" ] && WATCHDOG_INTERVAL_MINUTES="$ENV_WATCHDOG_INTERVAL_MINUTES"
[ -n "$ENV_WATCHDOG_TIMEOUT_MINUTES" ] && WATCHDOG_TIMEOUT_MINUTES="$ENV_WATCHDOG_TIMEOUT_MINUTES"
[ -n "$ENV_WATCHDOG_COMPACT_EVERY_RUNS" ] && WATCHDOG_COMPACT_EVERY_RUNS="$ENV_WATCHDOG_COMPACT_EVERY_RUNS"
[ -n "$ENV_WATCHDOG_ROLE" ] && WATCHDOG_ROLE="$ENV_WATCHDOG_ROLE"
[ -n "$ENV_WATCHDOG_PHASE_OFFSET_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_PHASE_OFFSET_MINUTES"
[ -n "$ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" ] && WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="$ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP"
[ -n "$ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" ] && WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS"
[ -z "\${WATCHDOG_PHASE_OFFSET_MINUTES:-}" ] && [ -n "$ENV_WATCHDOG_INITIAL_DELAY_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_INITIAL_DELAY_MINUTES"
[ -n "$ENV_WATCHDOG_SERVICE_PREFIX" ] && WATCHDOG_SERVICE_PREFIX="$ENV_WATCHDOG_SERVICE_PREFIX"

CODEX_HOME="\${CODEX_HOME:-$HOME/.codex-watcher}"
CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE:-read-only}"
WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES:-30}"
WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES:-25}"
WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS:-6}"
WATCHDOG_ROLE="\${WATCHDOG_ROLE:-runner}"
WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES:-10}"
WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP:-1}"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS:-4}"
WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX:-codex-watchdog}"

export CUDA_VISIBLE_DEVICES=""

cd "$PROJECT_ROOT"

sanitize_minutes() {
  local name="$1"
  local value="$2"
  local min="$3"
  local fallback="$4"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt "$min" ]; then
    echo "warning: ignoring invalid $name=$value; using $fallback" >&2
    printf '%s\\n' "$fallback"
    return
  fi
  printf '%s\\n' "$value"
}

workspace_write_allowed() {
  python3 - <<'PY'
import json
from pathlib import Path
p = Path("agent/workspace_write_policy.json")
if not p.exists():
    raise SystemExit(1)
try:
    data = json.loads(p.read_text())
except Exception:
    raise SystemExit(1)
if data.get("enabled") is not True:
    raise SystemExit(1)
writable = data.get("writable_paths")
commands = data.get("allowed_commands")
if not isinstance(writable, list) or not writable or not isinstance(commands, list) or not commands:
    raise SystemExit(1)
for item in writable:
    if not isinstance(item, str) or not item.strip() or item.startswith("/") or ".." in item.replace("\\\\", "/").split("/"):
        raise SystemExit(1)
for item in commands:
    if not isinstance(item, str) or not item.strip():
        raise SystemExit(1)
PY
}

resolve_codex_bin() {
  if [ -n "\${CODEX_BIN:-}" ]; then
    printf '%s\\n' "$CODEX_BIN"
    return
  fi

  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return
  fi

  local found
  found="$(ls -1 "$HOME"/.vscode-server/extensions/openai.chatgpt-*/bin/linux-*/codex 2>/dev/null | sort | tail -n 1 || true)"
  if [ -n "$found" ]; then
    printf '%s\\n' "$found"
    return
  fi

  printf '%s\\n' "codex"
}

CODEX_BIN="$(resolve_codex_bin)"
WATCHDOG_INTERVAL_MINUTES="$(sanitize_minutes WATCHDOG_INTERVAL_MINUTES "$WATCHDOG_INTERVAL_MINUTES" 5 30)"
WATCHDOG_TIMEOUT_MINUTES="$(sanitize_minutes WATCHDOG_TIMEOUT_MINUTES "$WATCHDOG_TIMEOUT_MINUTES" 1 25)"
WATCHDOG_COMPACT_EVERY_RUNS="$(sanitize_minutes WATCHDOG_COMPACT_EVERY_RUNS "$WATCHDOG_COMPACT_EVERY_RUNS" 0 6)"
WATCHDOG_PHASE_OFFSET_MINUTES="$(sanitize_minutes WATCHDOG_PHASE_OFFSET_MINUTES "$WATCHDOG_PHASE_OFFSET_MINUTES" 0 10)"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$(sanitize_minutes WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS "$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" 1 4)"
case "$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" in 1|true|yes|on) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="1" ;; *) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="0" ;; esac
case "$WATCHDOG_ROLE" in runner|supervisor) ;; *) WATCHDOG_ROLE="runner" ;; esac
if [ "$CODEX_SANDBOX_MODE" = "workspace-write" ] && ! workspace_write_allowed; then
  echo "warning: workspace-write requested but agent/workspace_write_policy.json is missing or invalid; using read-only" >&2
  CODEX_SANDBOX_MODE="read-only"
fi
if [ "$CODEX_SANDBOX_MODE" != "read-only" ] && [ "$CODEX_SANDBOX_MODE" != "workspace-write" ]; then
  echo "warning: invalid CODEX_SANDBOX_MODE=$CODEX_SANDBOX_MODE; using read-only" >&2
  CODEX_SANDBOX_MODE="read-only"
fi
export CODEX_BIN CODEX_HOME CODEX_SANDBOX_MODE WATCHDOG_INTERVAL_MINUTES WATCHDOG_TIMEOUT_MINUTES WATCHDOG_COMPACT_EVERY_RUNS WATCHDOG_ROLE WATCHDOG_PHASE_OFFSET_MINUTES WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS WATCHDOG_SERVICE_PREFIX

print_header() {
  echo "Codex Watchdog Guard"
  echo "PROJECT_ROOT=$PROJECT_ROOT"
  echo "CODEX_BIN=$CODEX_BIN"
  echo "CODEX_HOME=$CODEX_HOME"
  echo "CODEX_SANDBOX_MODE=$CODEX_SANDBOX_MODE"
  echo "WATCHDOG_COMPACT_EVERY_RUNS=$WATCHDOG_COMPACT_EVERY_RUNS"
  echo "WATCHDOG_ROLE=$WATCHDOG_ROLE"
  echo "WATCHDOG_PHASE_OFFSET_MINUTES=$WATCHDOG_PHASE_OFFSET_MINUTES"
  echo "WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP"
  echo "WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS"
  echo
}

check_layout() {
  local missing=0
  local file
  for file in \\
    "README.codex-watchdog.md" \\
    "agent/CODEX_TAKEOVER.md" \\
    "agent/PLAN.md" \\
    "agent/TODO.md" \\
    "agent/STATE.md" \\
	    "agent/SAFETY.md" \\
	    "agent/DAILY_HANDOFF.md" \\
	    "agent/watchdog.env" \\
	    "agent/bin/run_watchdog.sh" \\
    "agent/bin/watchdog_timer.sh"; do
    if [ ! -e "$file" ]; then
      echo "missing: $file"
      missing=1
    fi
  done
  return "$missing"
}

login_status() {
  mkdir -p "$CODEX_HOME"
  CODEX_HOME="$CODEX_HOME" "$CODEX_BIN" login status 2>&1 || true
}

login_ready() {
  login_status | grep -Eiq 'logged[[:space:]]+in|authenticated'
}

require_login() {
  echo "Checking Codex login status..."
  local status
  status="$(login_status)"
  echo "$status"
  echo

  if printf '%s\\n' "$status" | grep -Eiq 'logged[[:space:]]+in|authenticated'; then
    return 0
  fi

	  echo "Codex login is not ready for guard mode." >&2
	  echo "Run: ./agent/bin/watchdog login" >&2
	  echo "Then rerun: ./agent/bin/watchdog start" >&2
  return 3
}

latest_report() {
  echo
  if [ -e "agent/reports/latest.md" ]; then
    local latest
    latest="$(readlink -f agent/reports/latest.md 2>/dev/null || printf '%s' "agent/reports/latest.md")"
    echo "LATEST_REPORT=$latest"
    echo
    sed -n '1,40p' agent/reports/latest.md || true
  else
    echo "LATEST_REPORT=none"
  fi
}

pause_guard() {
  mkdir -p agent/control
  {
    echo "Paused at: $(date -Is)"
    echo "Reason: paused from project-local watchdog CLI"
  } > agent/control/PAUSE
  echo "PAUSED=agent/control/PAUSE"
}

resume_guard() {
  rm -f agent/control/PAUSE
  echo "RESUMED"
}

show_queue() {
  if [ -f agent/status/QUEUE_STATUS.md ]; then
    sed -n '1,160p' agent/status/QUEUE_STATUS.md || true
  else
    echo "No queue status yet. Run ./agent/bin/watchdog run-once or wait for the next timer cycle."
  fi
}

route_skill() {
  python3 agent/bin/route_skill.py
}

validate_generated_manifest() {
  python3 - <<'PY'
import hashlib
import json
import sys
from pathlib import Path

manifest_path = Path("agent/status/generated_manifest.json")
if not manifest_path.exists():
    print("generated manifest missing: agent/status/generated_manifest.json", file=sys.stderr)
    sys.exit(1)

try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except Exception as exc:
    print(f"generated manifest invalid: {exc}", file=sys.stderr)
    sys.exit(1)

template_hashes = manifest.get("template_hashes")
if not isinstance(template_hashes, dict) or not template_hashes:
    print("generated manifest invalid: template_hashes must be a nonempty object", file=sys.stderr)
    sys.exit(1)

errors = []
for rel, expected in sorted(template_hashes.items()):
    if not isinstance(rel, str) or not isinstance(expected, str):
        errors.append(f"invalid manifest entry: {rel!r}")
        continue
    if not expected.startswith("sha256:"):
        errors.append(f"invalid hash format for {rel}")
        continue
    file_path = Path(rel)
    if file_path.is_absolute() or ".." in file_path.parts:
        errors.append(f"unsafe generated path in manifest: {rel}")
        continue
    if not file_path.exists():
        errors.append(f"generated file missing: {rel}")
        continue
    actual = "sha256:" + hashlib.sha256(file_path.read_bytes()).hexdigest()
    if actual != expected:
        errors.append(f"generated file drift: {rel}")

if errors:
    for error in errors:
        print(error, file=sys.stderr)
    print("Run: Codex Watchdog: Refresh Generated Watcher Files", file=sys.stderr)
    sys.exit(1)

version = manifest.get("control_plane_version", "unknown")
print(f"generated manifest ok: {len(template_hashes)} files, version={version}")
PY
}

validate_runtime() {
  python3 agent/bin/validate_runtime.py
  validate_generated_manifest
}

run_once() {
  print_header
  check_layout
  require_login
  ./agent/bin/run_watchdog.sh
  latest_report
}

start_guard() {
  print_header
  check_layout
  require_login
  echo "Running one immediate watchdog cycle before installing the timer..."
  ./agent/bin/run_watchdog.sh
  echo
  echo "Immediate cycle succeeded. Installing repeating timer..."
  ./agent/bin/watchdog_timer.sh install
  latest_report
}

status_guard() {
  print_header
  check_layout || true
  if [ -f agent/control/PAUSE ]; then
    echo "Control: paused"
    sed -n '1,20p' agent/control/PAUSE || true
  else
    echo "Control: live"
  fi
  echo
  echo "Login status:"
  login_status
  echo
  ./agent/bin/watchdog_timer.sh status
  echo
  show_queue
  latest_report
}

case "$ACTION" in
  start|takeover|stand-guard|guard)
    start_guard
    ;;
  run-once|once)
    run_once
    ;;
  check|status)
    status_guard
    ;;
  latest)
    latest_report
    ;;
  pause)
    pause_guard
    ;;
  resume)
    resume_guard
    ;;
  queue|show-queue)
    show_queue
    ;;
  route|show-route)
    route_skill
    ;;
  validate|doctor-runtime)
    validate_runtime
    ;;
  stop)
    ./agent/bin/watchdog_timer.sh stop
    ;;
  login)
    mkdir -p "$CODEX_HOME"
    CODEX_HOME="$CODEX_HOME" "$CODEX_BIN" login
    ;;
  *)
    echo "Usage: $0 {start|takeover|stand-guard|guard|run-once|check|status|latest|queue|route|validate|pause|resume|stop|login}" >&2
    exit 2
    ;;
esac
`,

  watchdogCli: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
ACTION="\${1:---help}"
shift || true

cd "$PROJECT_ROOT"

show_help() {
  cat <<'HELP_EOF'
Codex Watchdog project-local CLI

Usage:
  ./agent/bin/watchdog --help
  ./agent/bin/watchdog start
  ./agent/bin/watchdog status
  ./agent/bin/watchdog stop
  ./agent/bin/watchdog pause
  ./agent/bin/watchdog resume
  ./agent/bin/watchdog queue
  ./agent/bin/watchdog route
  ./agent/bin/watchdog validate
  ./agent/bin/watchdog run-once
  ./agent/bin/watchdog latest
	  ./agent/bin/watchdog login
  ./agent/bin/watchdog timer-install
  ./agent/bin/watchdog timer-status
  ./agent/bin/watchdog timer-units

Plain-language intent:
  If the user says "启动看护员", "接管 watchdog", "stand watch",
  "start the guard", or similar, run:

    ./agent/bin/watchdog start

What start does:
  1. Checks the project-local watchdog layout.
  2. Checks Codex login for CODEX_HOME, defaulting to ~/.codex-watcher.
  3. Runs one immediate wakeup.
  4. Starts the repeating systemd user timer only if the wakeup succeeds.
  5. Prints latest report and timer status.

Login rule:
  OpenAI login is the only manual authorization step. If login is missing,
  run "./agent/bin/watchdog login" and complete the browser/device login,
  then rerun "./agent/bin/watchdog start". Do not bypass login for normal use.

Important files:
  README.codex-watchdog.md       human/Codex overview
  agent/CODEX_TAKEOVER.md        instructions for daily Codex mode
  agent/SAFETY.md                hard safety rules and write allowlist
  agent/DAILY_HANDOFF.md         evening handoff
  agent/control/PAUSE            pause flag; if present, wakeups do not call Codex
  agent/status/SKILL_ROUTE.json  deterministic route chosen before Codex starts
  agent/status/QUEUE_STATUS.md   compact queue dashboard with no raw log tails
  agent/reports/latest.md        newest watchdog report
  agent/MORNING_BRIEF.md         morning handoff

Environment overrides:
  CODEX_BIN=/path/to/codex
  CODEX_HOME=$HOME/.codex-watcher
  CODEX_SANDBOX_MODE=read-only|workspace-write
  WATCHDOG_INTERVAL_MINUTES=30
  WATCHDOG_TIMEOUT_MINUTES=25
  WATCHDOG_COMPACT_EVERY_RUNS=6

Examples:
  ./agent/bin/watchdog status
  ./agent/bin/watchdog queue
  ./agent/bin/watchdog route
  ./agent/bin/watchdog validate
  ./agent/bin/watchdog login
  ./agent/bin/watchdog run-once
  ./agent/bin/watchdog pause
  ./agent/bin/watchdog resume
  CODEX_SANDBOX_MODE=workspace-write ./agent/bin/watchdog start
  ./agent/bin/watchdog stop

Safety:
  Default mode is read-only reasoning plus reports. workspace-write is forced
  back to read-only unless agent/workspace_write_policy.json exists, is valid,
  sets enabled=true, and lists exact relative writable paths and commands.
  Keep the same probe documented in agent/SAFETY.md for model guidance.
HELP_EOF
}

case "$ACTION" in
  -h|--help|help)
    show_help
    ;;
  start|takeover|guard|stand-guard)
    ./agent/bin/watchdog_guard.sh start "$@"
    ;;
  status|check|doctor)
    ./agent/bin/watchdog_guard.sh status "$@"
    ;;
  run-once|once)
    ./agent/bin/watchdog_guard.sh run-once "$@"
    ;;
  latest|report)
    ./agent/bin/watchdog_guard.sh latest "$@"
    ;;
  pause)
    ./agent/bin/watchdog_guard.sh pause "$@"
    ;;
  resume)
    ./agent/bin/watchdog_guard.sh resume "$@"
    ;;
  queue|show-queue)
    ./agent/bin/watchdog_guard.sh queue "$@"
    ;;
  route|show-route)
    ./agent/bin/watchdog_guard.sh route "$@"
    ;;
  validate|doctor-runtime)
    ./agent/bin/watchdog_guard.sh validate "$@"
    ;;
  stop)
    ./agent/bin/watchdog_guard.sh stop "$@"
    ;;
  login)
    ./agent/bin/watchdog_guard.sh login "$@"
    ;;
  timer-install|timer-start)
    ./agent/bin/watchdog_timer.sh install "$@"
    ;;
  timer-status)
    ./agent/bin/watchdog_timer.sh status "$@"
    ;;
  timer-stop)
    ./agent/bin/watchdog_timer.sh stop "$@"
    ;;
  timer-units|units)
    ./agent/bin/watchdog_timer.sh units "$@"
    ;;
  *)
    echo "Unknown watchdog command: $ACTION" >&2
    echo >&2
    show_help >&2
    exit 2
    ;;
esac
`,

  watchdogTimer: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
ACTION="\${1:-status}"

ENV_CODEX_BIN="\${CODEX_BIN-}"
ENV_CODEX_HOME="\${CODEX_HOME-}"
ENV_CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE-}"
ENV_WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES-}"
ENV_WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES-}"
ENV_WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS-}"
ENV_WATCHDOG_ROLE="\${WATCHDOG_ROLE-}"
ENV_WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES-}"
ENV_WATCHDOG_INITIAL_DELAY_MINUTES="\${WATCHDOG_INITIAL_DELAY_MINUTES-}"
ENV_WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX-}"

if [ -f "$PROJECT_ROOT/agent/watchdog.env" ]; then
  set -a
  . "$PROJECT_ROOT/agent/watchdog.env"
  set +a
fi

[ -n "$ENV_CODEX_BIN" ] && CODEX_BIN="$ENV_CODEX_BIN"
[ -n "$ENV_CODEX_HOME" ] && CODEX_HOME="$ENV_CODEX_HOME"
[ -n "$ENV_CODEX_SANDBOX_MODE" ] && CODEX_SANDBOX_MODE="$ENV_CODEX_SANDBOX_MODE"
[ -n "$ENV_WATCHDOG_INTERVAL_MINUTES" ] && WATCHDOG_INTERVAL_MINUTES="$ENV_WATCHDOG_INTERVAL_MINUTES"
[ -n "$ENV_WATCHDOG_TIMEOUT_MINUTES" ] && WATCHDOG_TIMEOUT_MINUTES="$ENV_WATCHDOG_TIMEOUT_MINUTES"
[ -n "$ENV_WATCHDOG_COMPACT_EVERY_RUNS" ] && WATCHDOG_COMPACT_EVERY_RUNS="$ENV_WATCHDOG_COMPACT_EVERY_RUNS"
[ -n "$ENV_WATCHDOG_ROLE" ] && WATCHDOG_ROLE="$ENV_WATCHDOG_ROLE"
[ -n "$ENV_WATCHDOG_PHASE_OFFSET_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_PHASE_OFFSET_MINUTES"
[ -z "\${WATCHDOG_PHASE_OFFSET_MINUTES:-}" ] && [ -n "$ENV_WATCHDOG_INITIAL_DELAY_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_INITIAL_DELAY_MINUTES"
[ -n "$ENV_WATCHDOG_SERVICE_PREFIX" ] && WATCHDOG_SERVICE_PREFIX="$ENV_WATCHDOG_SERVICE_PREFIX"

WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX:-codex-watchdog}"
WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES:-30}"
WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES:-25}"
WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS:-6}"
WATCHDOG_ROLE="\${WATCHDOG_ROLE:-runner}"
WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES:-10}"
WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP:-1}"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS:-4}"
CODEX_BIN="\${CODEX_BIN:-codex}"
CODEX_HOME="\${CODEX_HOME:-$HOME/.codex-watcher}"
CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE:-read-only}"
UNIT_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

slugify() {
  local value="\${1:-project}"
  local slug
  slug="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  if [ -z "$slug" ]; then
    slug="project"
  fi
  printf '%s' "$slug"
}

project_hash() {
  if command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | sha1sum | awk '{print substr($1, 1, 8)}'
  else
    printf '%s' "$PROJECT_ROOT" | shasum | awk '{print substr($1, 1, 8)}'
  fi
}

systemd_value() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/%/%%/g; s/ /\\\\x20/g'
}

sanitize_minutes() {
  local name="$1"
  local value="$2"
  local min="$3"
  local fallback="$4"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt "$min" ]; then
    echo "warning: ignoring invalid $name=$value; using $fallback" >&2
    printf '%s\\n' "$fallback"
    return
  fi
  printf '%s\\n' "$value"
}

workspace_write_allowed() {
  (
    cd "$PROJECT_ROOT"
    python3 - <<'PY'
import json
from pathlib import Path
p = Path("agent/workspace_write_policy.json")
if not p.exists():
    raise SystemExit(1)
try:
    data = json.loads(p.read_text())
except Exception:
    raise SystemExit(1)
if data.get("enabled") is not True:
    raise SystemExit(1)
writable = data.get("writable_paths")
commands = data.get("allowed_commands")
if not isinstance(writable, list) or not writable or not isinstance(commands, list) or not commands:
    raise SystemExit(1)
for item in writable:
    if not isinstance(item, str) or not item.strip() or item.startswith("/") or ".." in item.replace("\\\\", "/").split("/"):
        raise SystemExit(1)
for item in commands:
    if not isinstance(item, str) or not item.strip():
        raise SystemExit(1)
PY
  )
}

validate_service_prefix() {
  if [[ ! "$WATCHDOG_SERVICE_PREFIX" =~ ^[A-Za-z0-9_.@-]+$ ]] || [[ "$WATCHDOG_SERVICE_PREFIX" == *..* ]]; then
    echo "Invalid WATCHDOG_SERVICE_PREFIX: $WATCHDOG_SERVICE_PREFIX" >&2
    echo "Use only A-Z, a-z, 0-9, _, ., @, and -, without '..'." >&2
    exit 4
  fi
}

validate_unit_name() {
  local name="$1"
  if [[ "$name" == */* ]] || [[ "$name" == *\\\\* ]] || [[ "$name" == *..* ]] || ! [[ "$name" =~ ^[A-Za-z0-9_.@-]+\\.(service|timer)$ ]]; then
    echo "Unsafe generated systemd unit name: $name" >&2
    exit 4
  fi
}

timer_units() {
  local slug hash
  validate_service_prefix
  slug="$(slugify "$(basename "$PROJECT_ROOT")")"
  hash="$(project_hash)"
  SERVICE="\${WATCHDOG_SERVICE_PREFIX}-\${slug}-\${hash}.service"
  TIMER="\${WATCHDOG_SERVICE_PREFIX}-\${slug}-\${hash}.timer"
  validate_unit_name "$SERVICE"
  validate_unit_name "$TIMER"
}

write_units() {
  WATCHDOG_INTERVAL_MINUTES="$(sanitize_minutes WATCHDOG_INTERVAL_MINUTES "$WATCHDOG_INTERVAL_MINUTES" 5 30)"
  WATCHDOG_TIMEOUT_MINUTES="$(sanitize_minutes WATCHDOG_TIMEOUT_MINUTES "$WATCHDOG_TIMEOUT_MINUTES" 1 25)"
  WATCHDOG_COMPACT_EVERY_RUNS="$(sanitize_minutes WATCHDOG_COMPACT_EVERY_RUNS "$WATCHDOG_COMPACT_EVERY_RUNS" 0 6)"
  WATCHDOG_PHASE_OFFSET_MINUTES="$(sanitize_minutes WATCHDOG_PHASE_OFFSET_MINUTES "$WATCHDOG_PHASE_OFFSET_MINUTES" 0 10)"
  WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$(sanitize_minutes WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS "$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" 1 4)"
  case "$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" in 1|true|yes|on) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="1" ;; *) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="0" ;; esac
  case "$WATCHDOG_ROLE" in runner|supervisor) ;; *) WATCHDOG_ROLE="runner" ;; esac
  if [ "$CODEX_SANDBOX_MODE" = "workspace-write" ] && ! workspace_write_allowed; then
    echo "warning: workspace-write requested but agent/workspace_write_policy.json is missing or invalid; using read-only" >&2
    CODEX_SANDBOX_MODE="read-only"
  fi
  if [ "$CODEX_SANDBOX_MODE" != "read-only" ] && [ "$CODEX_SANDBOX_MODE" != "workspace-write" ]; then
    echo "warning: invalid CODEX_SANDBOX_MODE=$CODEX_SANDBOX_MODE; using read-only" >&2
    CODEX_SANDBOX_MODE="read-only"
  fi
  timer_units
  mkdir -p "$UNIT_DIR" "$CODEX_HOME"

  cat > "$UNIT_DIR/$SERVICE" <<SERVICE_EOF
[Unit]
Description=Codex project watcher for $(basename "$PROJECT_ROOT")

[Service]
Type=oneshot
WorkingDirectory=$(systemd_value "$PROJECT_ROOT")
ExecStart=/usr/bin/env bash $(systemd_value "$PROJECT_ROOT/agent/bin/run_watchdog.sh")
Environment=CODEX_BIN=$(systemd_value "$CODEX_BIN")
Environment=CODEX_HOME=$(systemd_value "$CODEX_HOME")
Environment=CODEX_SANDBOX_MODE=$(systemd_value "$CODEX_SANDBOX_MODE")
Environment=WATCHDOG_TIMEOUT_MINUTES=$WATCHDOG_TIMEOUT_MINUTES
Environment=WATCHDOG_COMPACT_EVERY_RUNS=$WATCHDOG_COMPACT_EVERY_RUNS
Environment=WATCHDOG_ROLE=$(systemd_value "$WATCHDOG_ROLE")
Environment=WATCHDOG_PHASE_OFFSET_MINUTES=$WATCHDOG_PHASE_OFFSET_MINUTES
Environment=WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP
Environment=WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS
Environment=CUDA_VISIBLE_DEVICES=
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
TimeoutStartSec=\${WATCHDOG_TIMEOUT_MINUTES}min
SERVICE_EOF

  cat > "$UNIT_DIR/$TIMER" <<TIMER_EOF
[Unit]
Description=Run Codex project watcher every $WATCHDOG_INTERVAL_MINUTES minutes for $(basename "$PROJECT_ROOT")

[Timer]
OnActiveSec=\${WATCHDOG_PHASE_OFFSET_MINUTES}min
OnUnitActiveSec=\${WATCHDOG_INTERVAL_MINUTES}min
AccuracySec=1min
Unit=$SERVICE

[Install]
WantedBy=timers.target
TIMER_EOF
}

show_units() {
  timer_units
  echo "PROJECT_ROOT=$PROJECT_ROOT"
  echo "SERVICE=$SERVICE"
  echo "TIMER=$TIMER"
}

show_status() {
  timer_units
  show_units
  echo
  echo "active:  $(systemctl --user is-active "$TIMER" 2>/dev/null || true)"
  echo "enabled: $(systemctl --user is-enabled "$TIMER" 2>/dev/null || true)"
  echo
  systemctl --user list-timers "$TIMER" --no-pager 2>/dev/null || true
}

case "$ACTION" in
  install|start)
    write_units
    systemctl --user daemon-reload
    systemctl --user enable --now "$TIMER"
    show_status
    ;;
  stop)
    timer_units
    systemctl --user disable --now "$TIMER" || true
    show_status
    ;;
  status)
    show_status
    ;;
  units)
    show_units
    ;;
  *)
    echo "Usage: $0 {install|start|stop|status|units}" >&2
    exit 2
    ;;
esac
`,

  routeSkill: () => `#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(".")
OUT = ROOT / "agent" / "status" / "SKILL_ROUTE.json"

def int_env(name, default):
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default

RESULT_FRESH_MINUTES = int_env("WATCHDOG_QUEUE_RESULT_FRESH_MINUTES", 240)

def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default

def load_task_box(root=ROOT):
    data = load_json(root / "agent" / "TASK_BOX.json", {})
    return data if isinstance(data, dict) else {}

def load_route_canonical(root=ROOT):
    data = load_json(root / "agent" / "ROUTE_CANONICAL.json", {})
    return data if isinstance(data, dict) else {}

def load_next_task_draft(root=ROOT):
    data = load_json(root / "agent" / "status" / "NEXT_TASK_DRAFT.json", {})
    return data if isinstance(data, dict) else {}

def normalize_string_list(values):
    if not isinstance(values, list):
        return []
    result = []
    for value in values:
        text = str(value or "").strip()
        if text:
            result.append(text)
    return result

def load_secondary_skills_config(root=ROOT):
    data = load_json(root / "agent" / "SECONDARY_SKILLS.json", {})
    if not isinstance(data, dict):
        return {"skills": []}
    skills = data.get("skills")
    if not isinstance(skills, list):
        return {"skills": []}
    normalized = []
    for raw in skills:
        if not isinstance(raw, dict):
            continue
        skill_id = str(raw.get("skill_id") or "").strip()
        rel_path = str(raw.get("path") or "").strip()
        if not skill_id or not rel_path or Path(rel_path).is_absolute():
            continue
        target_path = root / rel_path
        if not target_path.exists() or not target_path.is_file():
            continue
        selectors = raw.get("selectors") if isinstance(raw.get("selectors"), dict) else {}
        normalized.append({
            "skill_id": skill_id,
            "path": rel_path,
            "enabled": raw.get("enabled") is not False,
            "selectors": {
                "primary_skills": normalize_string_list(selectors.get("primary_skills")),
                "roles": normalize_string_list(selectors.get("roles")),
                "supervisor_modes": normalize_string_list(selectors.get("supervisor_modes")),
                "task_capabilities": normalize_string_list(selectors.get("task_capabilities")),
            }
        })
    return {
        "schema_version": data.get("schema_version"),
        "skills": normalized,
    }

def has_files(*dirs, freshness_minutes=None):
    cutoff = None
    if freshness_minutes is not None:
        cutoff = datetime.now(timezone.utc).timestamp() - (max(0, int(freshness_minutes)) * 60)
    for dirname in dirs:
        d = ROOT / dirname
        if d.is_dir():
            for item in d.iterdir():
                if item.is_file() and not item.name.startswith("."):
                    if cutoff is not None:
                        try:
                            if item.stat().st_mtime < cutoff:
                                continue
                        except OSError:
                            continue
                    return True
    return False

TRUE_VALUES = {"1", "true", "yes", "on", "required"}
REVIEW_STATES = {"pending_send", "review_required_no_bundle"}
BLOCKER_TYPES = {"permission", "reviewer", "allowlist", "stale_state"}

def read_text_path(p):
    if not p.exists():
        return ""
    try:
        return p.read_text(errors="ignore")
    except Exception:
        return ""

def read_text(rel):
    return read_text_path(ROOT / rel)

def field_value(raw_text, key):
    key = key.lower()
    for line in raw_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("-"):
            stripped = stripped[1:].strip()
        if ":" not in stripped:
            continue
        left, right = stripped.split(":", 1)
        if left.strip().lower() == key:
            return right.strip().lower()
    return ""

def is_true(value):
    return str(value or "").strip().lower() in TRUE_VALUES

def active_review_marker(state):
    if isinstance(state, dict) and state.get("requires_review") is True:
        return True, "STATE.json requires_review=true."

    review_text = read_text("agent/REVIEW_PENDING.md")
    review_state = field_value(review_text, "state")
    if review_state in REVIEW_STATES:
        return True, f"REVIEW_PENDING.md state={review_state}."
    if is_true(field_value(review_text, "requires_human_review")):
        return True, "REVIEW_PENDING.md requires_human_review=true."
    if is_true(field_value(review_text, "pending_send")):
        return True, "REVIEW_PENDING.md pending_send=true."

    blockers_text = read_text("agent/BLOCKERS.md")
    blocker_type = field_value(blockers_text, "blocker type")
    if blocker_type in BLOCKER_TYPES:
        return True, f"BLOCKERS.md blocker type={blocker_type}."
    if is_true(field_value(blockers_text, "required")):
        return True, "BLOCKERS.md review required."

    run_state = load_json(ROOT / "agent" / "RUN_STATE.json", {})
    blocker = str(run_state.get("blocker_type") or "").strip().lower() if isinstance(run_state, dict) else ""
    if blocker in {"permission", "reviewer", "stale_state"}:
        return True, f"RUN_STATE.json blocker_type={blocker}."

    return False, ""

def todo_has_pending():
    p = ROOT / "agent" / "TODO.md"
    if not p.exists():
        return False
    text = p.read_text(errors="ignore").lower()
    return "pending" in text or "- [ ]" in text or "| pending |" in text

def pending_tasks(state):
    tasks = state.get("tasks") if isinstance(state, dict) else []
    if not isinstance(tasks, list):
        return []
    return [t for t in tasks if isinstance(t, dict) and t.get("status") == "pending"]

def autonomous_mode(state, task_box, route_canonical):
    for source in (task_box, route_canonical, state):
        if isinstance(source, dict) and isinstance(source.get("requires_review"), bool):
            return source.get("requires_review") is False
    return False

def task_box_pending_tasks(task_box):
    tasks = task_box.get("tasks") if isinstance(task_box, dict) else []
    if not isinstance(tasks, list):
        return []
    pending = []
    for raw in tasks:
        if not isinstance(raw, dict):
            continue
        task = dict(raw)
        if not task.get("status"):
            task["status"] = "pending"
        if task.get("status") != "pending":
            continue
        if not task.get("task_id"):
            task["task_id"] = task_box.get("task_box_id") or "task-box-pending-task"
        pending.append(task)
    return pending

def next_task_draft_pending_task(next_task_draft, route_canonical):
    if not isinstance(next_task_draft, dict):
        return []
    task_id = str(next_task_draft.get("task_id") or "").strip()
    if not task_id:
        return []
    expected_task_id = str(route_canonical.get("exact_next_task_id") or "").strip() if isinstance(route_canonical, dict) else ""
    if expected_task_id and task_id != expected_task_id:
        return []
    task = dict(next_task_draft)
    if not task.get("status"):
        task["status"] = "pending"
    if task.get("status") != "pending":
        return []
    return [task]

def canonical_exact_pending_task(route_canonical):
    if not isinstance(route_canonical, dict):
        return []
    exact_task_id = str(route_canonical.get("exact_next_task_id") or "").strip()
    if not exact_task_id:
        return []

    queue_draft = load_exact_queue_draft(route_canonical)
    if queue_draft:
        return [{
            "task_id": exact_task_id,
            "status": "pending",
            "allowed_runner": str(queue_draft.get("runner") or "gpu").strip().lower() or "gpu",
            "kind": "queue_enqueue",
            "queue_target": str(queue_draft.get("queue_target") or "").strip(),
            "command_profile": str(queue_draft.get("command_profile") or "").strip(),
            "expected_outputs": queue_draft.get("expected_outputs") if isinstance(queue_draft.get("expected_outputs"), list) else [],
            "max_runtime_minutes": queue_draft.get("max_runtime_minutes"),
            "budget_contract": str(queue_draft.get("budget_contract") or "").strip(),
            "derived_from_route_canonical": True,
        }]

    profile = load_exact_profile_draft(route_canonical)
    if not profile:
        return []

    profile_kind = str(profile.get("profile_kind") or "").strip().lower()
    task = {
        "task_id": exact_task_id,
        "status": "pending",
        "allowed_runner": str(profile.get("allowed_runner") or "cpu").strip().lower() or "cpu",
        "derived_from_route_canonical": True,
    }
    if profile_kind == "local_workspace_copy":
        task.update({
            "kind": "local_workspace_copy",
            "workspace_mode": str(profile.get("workspace_mode") or "project_local_copy"),
            "workspace_root": str(profile.get("workspace_root") or f"workspace/{safe_name(exact_task_id)}/"),
            "allowed_write_paths": profile.get("allowed_write_paths") if isinstance(profile.get("allowed_write_paths"), list) else [],
            "expected_outputs": profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else [],
            "max_runtime_minutes": profile.get("max_runtime_minutes"),
            "budget_contract": str(profile.get("budget_contract") or "").strip(),
        })
        return [task]
    if profile_kind in {"cpu_followup", "bounded_cpu_eval"}:
        task.update({
            "kind": "bounded_cpu_eval",
            "expected_outputs": profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else [],
            "max_runtime_minutes": profile.get("max_runtime_minutes"),
            "budget_contract": str(profile.get("budget_contract") or "").strip(),
        })
        return [task]
    if profile_kind == "gpu_queue_followup":
        task.update({
            "kind": "queue_enqueue",
            "queue_target": "gpu_queue",
            "command_profile": str(profile.get("command_profile") or safe_name(exact_task_id)),
            "expected_outputs": profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else [],
        })
        return [task]
    return []

def matching_pending_tasks(tasks, exact_task_id):
    if not exact_task_id:
        return tasks
    return [
        task for task in tasks
        if isinstance(task, dict) and str(task.get("task_id") or "").strip() == exact_task_id
    ]

def preferred_pending_tasks(state, task_box, next_task_draft, route_canonical):
    exact_task_id = str(route_canonical.get("exact_next_task_id") or "").strip() if isinstance(route_canonical, dict) else ""
    canonical_tasks = canonical_exact_pending_task(route_canonical)
    task_box_tasks = task_box_pending_tasks(task_box)
    task_box_matches = matching_pending_tasks(task_box_tasks, exact_task_id)
    if task_box_matches:
        return task_box_matches, "TASK_BOX.json"
    draft_tasks = next_task_draft_pending_task(next_task_draft, route_canonical)
    if draft_tasks:
        return draft_tasks, "NEXT_TASK_DRAFT.json"
    if canonical_tasks:
        return canonical_tasks, "ROUTE_CANONICAL.json"
    state_tasks = pending_tasks(state)
    state_matches = matching_pending_tasks(state_tasks, exact_task_id)
    if state_matches:
        return state_matches, "STATE.json"
    if task_box_tasks:
        return task_box_tasks, "TASK_BOX.json"
    if state_tasks:
        return state_tasks, "STATE.json"
    return [], ""

def route_epoch_mismatch(route_canonical, state, progress, run_state):
    if not isinstance(route_canonical, dict):
        return ""
    canonical_epoch = str(route_canonical.get("route_epoch") or "").strip()
    if not canonical_epoch:
        return ""
    mismatches = []
    for label, record in (
        ("STATE.json", state),
        ("PROGRESS_STATE.json", progress),
        ("RUN_STATE.json", run_state),
    ):
        if not isinstance(record, dict):
            continue
        record_epoch = str(record.get("route_epoch") or "").strip()
        if record_epoch and record_epoch != canonical_epoch:
            mismatches.append(f"{label} route_epoch={record_epoch}")
    if mismatches:
        return f"Canonical route_epoch={canonical_epoch} differs from " + ", ".join(mismatches) + "."
    return ""

def task_is_report_only(task):
    runner = str(task.get("allowed_runner") or "").strip().lower()
    kind = str(task.get("kind") or "").strip().lower()
    task_id = str(task.get("task_id") or "").strip().lower()
    text = " ".join(str(task.get(key) or "") for key in ("description", "title", "summary")).lower()
    return runner == "report_only" or kind == "report_only" or "report-only" in text or "report_only" in text or "report" in task_id

DEFAULT_SUPERVISOR_CAPABILITIES = {
    "report_only": True,
    "state_reconcile": True,
    "stale_marker_cleanup": True,
    "local_workspace_copy": True,
    "local_profile_authoring": True,
    "local_queue_draft_authoring": True,
    "bounded_cpu_eval": True,
    "bounded_gpu_probe": False,
    "bounded_training_canary": False,
    "queue_enqueue": False,
    "promotion_prepare": False,
    "promotion_apply": False,
    "external_send": False,
}

CAPABILITY_ALIASES = {
    "report": "report_only",
    "report-only": "report_only",
    "report_only": "report_only",
    "state-reconcile": "state_reconcile",
    "state_reconcile": "state_reconcile",
    "stale-marker-cleanup": "stale_marker_cleanup",
    "stale_marker_cleanup": "stale_marker_cleanup",
    "local-workspace-copy": "local_workspace_copy",
    "local_workspace_copy": "local_workspace_copy",
    "project-local-copy": "local_workspace_copy",
    "project_local_copy": "local_workspace_copy",
    "local-profile-authoring": "local_profile_authoring",
    "local_profile_authoring": "local_profile_authoring",
    "missing-profile": "local_profile_authoring",
    "missing_profile": "local_profile_authoring",
    "local-queue-draft-authoring": "local_queue_draft_authoring",
    "local_queue_draft_authoring": "local_queue_draft_authoring",
    "queue-draft": "local_queue_draft_authoring",
    "queue_draft": "local_queue_draft_authoring",
    "bounded-cpu": "bounded_cpu_eval",
    "bounded_cpu": "bounded_cpu_eval",
    "bounded-cpu-eval": "bounded_cpu_eval",
    "bounded_cpu_eval": "bounded_cpu_eval",
    "cpu32": "bounded_cpu_eval",
    "bounded-gpu": "bounded_gpu_probe",
    "bounded_gpu": "bounded_gpu_probe",
    "bounded-gpu-probe": "bounded_gpu_probe",
    "bounded_gpu_probe": "bounded_gpu_probe",
    "bounded-training-canary": "bounded_training_canary",
    "bounded_training_canary": "bounded_training_canary",
    "queue": "queue_enqueue",
    "queue_enqueue": "queue_enqueue",
    "promotion-prepare": "promotion_prepare",
    "promotion_prepare": "promotion_prepare",
    "promotion-apply": "promotion_apply",
    "promotion_apply": "promotion_apply",
    "external-send": "external_send",
    "external_send": "external_send",
}

def normalize_capability(value):
    key = str(value or "").strip().lower().replace(" ", "_")
    return CAPABILITY_ALIASES.get(key, key if key in DEFAULT_SUPERVISOR_CAPABILITIES else "")

def load_supervisor_capability_policy(root=ROOT):
    policy = {"capabilities": dict(DEFAULT_SUPERVISOR_CAPABILITIES)}
    config = load_json(root / "agent" / "supervisor_capabilities.json", {})
    caps = config.get("capabilities") if isinstance(config, dict) else None
    if isinstance(caps, dict):
        for raw_name, raw_value in caps.items():
            name = normalize_capability(raw_name)
            if not name:
                continue
            if isinstance(raw_value, dict):
                policy["capabilities"][name] = raw_value.get("enabled") is True
            else:
                policy["capabilities"][name] = raw_value is True
    return policy

def capability_enabled(policy, capability):
    return policy.get("capabilities", {}).get(capability) is True

def task_policy_text(task, approval=None):
    parts = []
    for key in (
        "task_id",
        "kind",
        "title",
        "summary",
        "description",
        "allowed_runner",
        "workspace_mode",
        "workspace_path",
    ):
        parts.append(str(task.get(key) or ""))
    if isinstance(approval, dict):
        for key in (
            "approval_class",
            "capability",
            "scope",
            "allowed_runner",
            "workspace_mode",
            "workspace_path",
            "reason",
        ):
            parts.append(str(approval.get(key) or ""))
        for key in ("allowed_write_paths",):
            value = approval.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value)
    return "\\n".join(parts).lower()

def classify_supervisor_capability(task, approval=None):
    if isinstance(approval, dict):
        for key in ("approval_class", "capability", "class"):
            explicit = normalize_capability(approval.get(key))
            if explicit:
                return explicit
    explicit = normalize_capability(task.get("supervisor_approval_class") or task.get("capability"))
    if explicit:
        return explicit

    runner = str(task.get("allowed_runner") or "").strip().lower()
    kind = str(task.get("kind") or "").strip().lower()
    text = task_policy_text(task, approval)

    if task_is_report_only(task):
        return "report_only"
    if kind in {"state_reconcile", "state-reconcile"} or "state reconcile" in text:
        return "state_reconcile"
    if "stale marker" in text or "marker cleanup" in text or "stale_marker_cleanup" in text:
        return "stale_marker_cleanup"
    if (
        "project_local_copy" in text
        or "project-local-copy" in text
        or "local workspace" in text
        or "workspace/<task_id>" in text
        or "workspace/" in text
    ):
        return "local_workspace_copy"
    if (
        "missing_profile" in text
        or "missing profile" in text
        or "task profile" in text
        or "profile package" in text
        or "package object" in text
        or "local profile" in text
    ):
        return "local_profile_authoring"
    if (
        "queue draft" in text
        or "draft queue" in text
        or "queue taskbox draft" in text
        or "prepare queue request" in text
        or "prepare taskbox" in text
        or "author queue request" in text
    ):
        return "local_queue_draft_authoring"
    if (
        "queue_enqueue" in text
        or "queue enqueue" in text
        or "enqueue" in text
        or "agent/queue" in text
        or "gpu_queue" in text
        or "queue request" in text
        or "queue taskbox" in text
    ):
        return "queue_enqueue"
    if "external send" in text or "deep research send" in text or "reviewer send" in text:
        return "external_send"
    if "promotion" in text or "shared_model" in text or "deployment" in text:
        if "proposal" in text or "prepare" in text or "review packet" in text:
            return "promotion_prepare"
        return "promotion_apply"
    if "training" in text or "train " in text or "queue training" in text:
        return "bounded_training_canary" if ("bounded" in text or "canary" in text or "smoke" in text) else "training"
    if runner == "gpu" or "gpu" in text:
        return "bounded_gpu_probe" if ("bounded" in text or "probe" in text or "smoke" in text or "eval" in text or "sample" in text) else "gpu"
    if runner == "cpu" or "cpu32" in text or "cpu-only" in text or "cpu smoke" in text or "cpu eval" in text:
        return "bounded_cpu_eval"
    return ""

def text_has_any(text, terms):
    return any(term in text for term in terms)

def supervisor_policy_rejection(policy, capability, text):
    normalized_text = text
    for phrase in (
        "no promotion",
        "without promotion",
        "promotion blocked",
        "promotion_blocked",
        "no external send",
        "without external send",
        "does not externally send",
        "no dataset mutation",
        "without dataset mutation",
        "does not mutate dataset",
        "does not mutate datasets",
        "no checkpoint mutation",
        "without checkpoint mutation",
        "does not mutate checkpoint",
        "does not mutate checkpoints",
        "no direct gpu execution",
        "without direct gpu execution",
        "does not execute gpu directly",
        "will not execute gpu directly",
        "not execute gpu directly",
        "runner will not execute gpu directly",
        "does not run gpu directly",
        "will not run gpu directly",
        "not run gpu directly",
    ):
        normalized_text = normalized_text.replace(phrase, "")
    always_forbidden = (
        ".env",
        "secret",
        "token",
        "private key",
        "delete original",
        "delete shared",
        "dataset mutation",
        "checkpoint mutation",
        "package install",
        "install package",
        "network fetch",
        "systemd restart",
        "systemctl restart",
        "kill service",
        "restart service",
        "chmod",
        "chown",
        "sudo",
    )
    if text_has_any(normalized_text, always_forbidden):
        return "contains always-forbidden supervisor delegated approval term"

    if capability == "queue_enqueue":
        if not text_has_any(normalized_text, ("queue", "enqueue", "agent/queue", "gpu_queue", "queue request", "queue taskbox")):
            return "queue_enqueue approval requires an explicit controlled queue target"
        direct_execution_terms = (
            "direct gpu",
            "direct_gpu",
            "execute gpu directly",
            "run gpu directly",
            "launch gpu directly",
            "manual gpu execution",
            "bypass queue",
            "without queue",
        )
        if text_has_any(normalized_text, direct_execution_terms):
            return "queue_enqueue cannot approve direct GPU execution or queue bypass"
        return ""

    if capability in {"local_queue_draft_authoring", "local_profile_authoring"}:
        direct_execution_terms = (
            "direct gpu",
            "direct_gpu",
            "execute gpu directly",
            "run gpu directly",
            "launch gpu directly",
            "manual gpu execution",
            "bypass queue",
            "without queue",
            "promotion",
            "external send",
        )
        if text_has_any(normalized_text, direct_execution_terms):
            return f"{capability} cannot approve direct execution, promotion, or external send"
        return ""

    dangerous_by_capability = {
        "bounded_gpu_probe": ("gpu", "gpu0", "gpu1", "run gpu", "execute gpu"),
        "bounded_training_canary": ("training", "train ", "launch training", "start training"),
        "promotion_apply": ("promotion", "promote", "shared_model", "deployment", "public docs"),
        "external_send": ("external send", "deep research send", "reviewer send"),
    }

    for cap_name, terms in dangerous_by_capability.items():
        if text_has_any(normalized_text, terms):
            if capability != cap_name:
                return f"mentions {cap_name} terms but classified as {capability or 'unknown'}"
            if not capability_enabled(policy, cap_name):
                return f"capability {cap_name} is disabled by supervisor_capabilities policy"

    if ("implementation" in normalized_text or "code edit" in normalized_text or "modify source" in normalized_text) and capability != "local_workspace_copy":
        return "code/source edits require local_workspace_copy capability"

    if capability == "bounded_training_canary" and not ("bounded" in normalized_text or "canary" in normalized_text or "smoke" in normalized_text):
        return "training capability requires bounded/canary/smoke scope"

    return ""

def task_is_supervisor_approved(task):
    if task.get("supervisor_approved") is not True:
        return False
    approval = task.get("supervisor_approval")
    if not isinstance(approval, dict):
        return False
    approved_by = str(approval.get("approved_by") or "").lower()
    if "supervisor" not in approved_by:
        return False
    policy = load_supervisor_capability_policy()
    capability = classify_supervisor_capability(task, approval)
    if not capability_enabled(policy, capability):
        return False
    text = task_policy_text(task, approval)
    if supervisor_policy_rejection(policy, capability, text):
        return False
    return capability in DEFAULT_SUPERVISOR_CAPABILITIES

def classify_task_capability(task):
    capability = classify_supervisor_capability(task, task.get("supervisor_approval") if isinstance(task, dict) else None)
    if capability:
        return capability
    if task_is_report_only(task):
        return "report_only"
    runner = str(task.get("allowed_runner") or "").strip().lower()
    if runner == "cpu":
        return "bounded_cpu_eval"
    if runner == "gpu":
        return "bounded_gpu_probe"
    return ""

def permission_guardian_needed(task):
    if task_is_supervisor_approved(task):
        return False
    capability = classify_task_capability(task)
    if capability in {
        "report_only",
        "state_reconcile",
        "stale_marker_cleanup",
        "local_workspace_copy",
        "local_profile_authoring",
        "local_queue_draft_authoring",
        "bounded_cpu_eval",
    }:
        return False
    if capability in {
        "bounded_gpu_probe",
        "bounded_training_canary",
        "queue_enqueue",
        "promotion_prepare",
        "promotion_apply",
        "external_send",
    }:
        return True
    return str(task.get("allowed_runner") or "").strip().lower() in {"cpu", "gpu"}

def safe_autonomous_capability(capability):
    return capability in {
        "report_only",
        "state_reconcile",
        "stale_marker_cleanup",
        "local_workspace_copy",
        "local_profile_authoring",
        "local_queue_draft_authoring",
        "bounded_cpu_eval",
    }

def route_task_lookup(state, task_box, next_task_draft, route_canonical):
    candidates = []
    state_tasks = state.get("tasks") if isinstance(state, dict) else []
    if isinstance(state_tasks, list):
        candidates.extend(task for task in state_tasks if isinstance(task, dict))
    task_box_tasks = task_box.get("tasks") if isinstance(task_box, dict) else []
    if isinstance(task_box_tasks, list):
        for raw in task_box_tasks:
            if not isinstance(raw, dict):
                continue
            task = dict(raw)
            if not task.get("task_id"):
                task["task_id"] = task_box.get("task_box_id") or "task-box-pending-task"
            candidates.append(task)
    if isinstance(next_task_draft, dict) and str(next_task_draft.get("task_id") or "").strip():
        candidates.append(dict(next_task_draft))
    candidates.extend(canonical_exact_pending_task(route_canonical))
    by_id = {}
    for task in candidates:
        task_id = str(task.get("task_id") or "").strip()
        if task_id and task_id not in by_id:
            by_id[task_id] = task
    return by_id

def route_capability_from_result(result, role, supervisor_mode, state, task_box, next_task_draft, route_canonical, run_state, progress):
    if not isinstance(result, dict):
        return ""
    if role == "supervisor" and str(result.get("task_id") or "") == "supervisor-delegated-runner-blocker-approval":
        reason = str(result.get("reason") or "")
        marker = "capability="
        if marker in reason:
            capability = reason.split(marker, 1)[1].split(".", 1)[0].strip().strip(" ,)")
            return normalize_capability(capability)
    lookup = route_task_lookup(state, task_box, next_task_draft, route_canonical)
    task_id = str(result.get("task_id") or "").strip()
    if task_id and task_id in lookup:
        return classify_task_capability(lookup[task_id])
    local_capability, _ = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
    if local_capability:
        return local_capability
    return ""

def selector_matches(selectors, key, actual, normalizer=None):
    values = selectors.get(key) if isinstance(selectors, dict) else None
    if not values:
        return True
    normalized = []
    for value in values:
        candidate = normalizer(value) if normalizer else str(value or "").strip().lower()
        if candidate:
            normalized.append(candidate)
    if not normalized:
        return True
    actual_value = normalizer(actual) if normalizer else str(actual or "").strip().lower()
    if not actual_value:
        return False
    return actual_value in normalized

def selected_secondary_skills(result, role, supervisor_mode, capability):
    config = load_secondary_skills_config(ROOT)
    selected = []
    seen = set()
    for skill in config.get("skills", []):
        if not isinstance(skill, dict) or skill.get("enabled") is not True:
            continue
        selectors = skill.get("selectors") if isinstance(skill.get("selectors"), dict) else {}
        if not selector_matches(selectors, "primary_skills", result.get("primary_skill")):
            continue
        if not selector_matches(selectors, "roles", role):
            continue
        if not selector_matches(selectors, "supervisor_modes", supervisor_mode):
            continue
        if not selector_matches(selectors, "task_capabilities", capability, normalize_capability):
            continue
        skill_id = str(skill.get("skill_id") or "").strip()
        if not skill_id or skill_id in seen:
            continue
        seen.add(skill_id)
        selected.append({
            "skill_id": skill_id,
            "path": str(skill.get("path") or "").strip(),
        })
    return selected

def research_gate_policy(task_box):
    policy = task_box.get("gate_policy") if isinstance(task_box, dict) else {}
    if not isinstance(policy, dict):
        policy = {}
    return {
        "topic_alignment_check": policy.get("topic_alignment_check") is True,
        "claim_scope_gate": policy.get("claim_scope_gate") is True,
        "fair_comparability_gate": policy.get("fair_comparability_gate") is True,
        "value_of_information_gate": policy.get("value_of_information_gate") is True,
        "successor_contract_gate": policy.get("successor_contract_gate") is True,
        "causal_path_verification": str(policy.get("causal_path_verification") or "disabled"),
        "enforcement": str(policy.get("enforcement") or "disabled"),
    }

def task_contract_value(task, task_box, key):
    if isinstance(task, dict):
        value = task.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if isinstance(task_box, dict):
        value = task_box.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

def task_contract_list(task, task_box, key):
    if isinstance(task, dict):
        value = task.get(key)
        if isinstance(value, list) and value:
            return value
    if isinstance(task_box, dict):
        value = task_box.get(key)
        if isinstance(value, list) and value:
            return value
    return []

def task_contract_object(task, task_box, key):
    if isinstance(task, dict):
        value = task.get(key)
        if isinstance(value, dict) and value:
            return value
    if isinstance(task_box, dict):
        value = task_box.get(key)
        if isinstance(value, dict) and value:
            return value
    return {}

def research_gate_applicable(capability):
    return capability in {
        "bounded_cpu_eval",
        "bounded_gpu_probe",
        "queue_enqueue",
        "local_workspace_copy",
        "bounded_training_canary",
    }

def task_research_gate_gaps(task, task_box, route_canonical=None):
    capability = classify_task_capability(task)
    policy = research_gate_policy(task_box)
    if policy.get("enforcement") == "disabled" or not research_gate_applicable(capability):
        return []

    gaps = []
    if policy.get("topic_alignment_check"):
        if not task_contract_value(task, task_box, "project_question"):
            gaps.append("project_question")
        if not task_contract_value(task, task_box, "decision_relevance"):
            gaps.append("decision_relevance")

    if policy.get("claim_scope_gate"):
        if not task_contract_value(task, task_box, "claim_scope"):
            gaps.append("claim_scope")
        if not task_contract_value(task, task_box, "diagnosis_target"):
            gaps.append("diagnosis_target")
        if not task_contract_list(task, task_box, "forbidden_conclusions"):
            gaps.append("forbidden_conclusions")

    if policy.get("fair_comparability_gate"):
        fair = task_contract_object(task, task_box, "fair_comparability")
        for key in (
            "same_family_or_not",
            "same_budget_or_not",
            "same_training_contract_or_not",
            "same_eval_contract_or_not",
        ):
            if not isinstance(fair.get(key), str) or not str(fair.get(key) or "").strip():
                gaps.append(key)

    if policy.get("value_of_information_gate"):
        voi = task_contract_object(task, task_box, "value_of_information")
        for key in (
            "expected_information_gain",
            "decision_change_if_positive",
            "decision_change_if_negative",
        ):
            if not isinstance(voi.get(key), str) or not str(voi.get(key) or "").strip():
                gaps.append(key)
        if "cheaper_alternative_exists" not in voi or not isinstance(voi.get("cheaper_alternative_exists"), bool):
            gaps.append("cheaper_alternative_exists")

    return sorted(set(gaps))

def successor_contract_gap(route_canonical, next_task_draft):
    if not isinstance(route_canonical, dict):
        return False
    if route_canonical.get("successor_contract_required") is not True:
        return False
    required_exactness = str(route_canonical.get("required_successor_exactness") or "").strip()
    experiment_gate_status = str(route_canonical.get("experiment_gate_status") or "").strip().lower()
    if experiment_gate_status == "blocked":
        return False
    exact_task = str(route_canonical.get("exact_next_task_id") or "").strip()
    exact_profile = str(route_canonical.get("exact_profile_path") or "").strip()
    exact_queue = str(route_canonical.get("exact_queue_draft_path") or "").strip()
    exact_object = str(route_canonical.get("exact_next_object_path") or "").strip()
    draft_task = str((next_task_draft or {}).get("task_id") or "").strip() if isinstance(next_task_draft, dict) else ""
    if required_exactness == "queue_exact":
        return not (exact_task and exact_queue and exact_object)
    if required_exactness == "profile_exact":
        return not (exact_task and exact_profile and exact_object)
    return not any((exact_task, exact_profile, exact_queue, exact_object, draft_task))

def load_exact_queue_draft(route_canonical):
    if not isinstance(route_canonical, dict):
        return {}
    rel_path = str(route_canonical.get("exact_queue_draft_path") or "").strip()
    if not rel_path:
        return {}
    target = ROOT / rel_path
    if not target.exists() or not target.is_file():
        return {}
    try:
        data = json.loads(target.read_text())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}

def infer_experiment_gate_status(route_canonical, task_box):
    for source in (task_box, route_canonical):
        if not isinstance(source, dict):
            continue
        gate = source.get("experiment_decision_gate")
        if isinstance(gate, dict):
            if gate.get("blocking") is True:
                return "blocked"
            if gate.get("required") is True:
                return "required_ready"
            if gate:
                return "not_required"
        if source.get("experiment_decision_gate_blocking") is True:
            return "blocked"
        if source.get("experiment_decision_gate_required") is True:
            return "required_ready"
        status = str(source.get("experiment_gate_status") or "").strip()
        if status:
            return status
    return "not_required"

def load_exact_profile_draft(route_canonical):
    if not isinstance(route_canonical, dict):
        return {}
    rel_path = str(route_canonical.get("exact_profile_path") or "").strip()
    if not rel_path:
        return {}
    target = ROOT / rel_path
    if not target.exists() or not target.is_file():
        return {}
    try:
        data = json.loads(target.read_text())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}

def exact_profile_followup_allowed(task, task_box, route_canonical):
    capability = classify_task_capability(task)
    if capability not in {"bounded_cpu_eval", "local_workspace_copy"}:
        return False, ""
    if infer_experiment_gate_status(route_canonical, task_box) == "blocked":
        return False, ""
    if task_research_gate_gaps(task, task_box, route_canonical):
        return False, ""

    profile = load_exact_profile_draft(route_canonical)
    if not profile:
        return False, ""

    exact_task_id = str(route_canonical.get("exact_next_task_id") or "").strip() if isinstance(route_canonical, dict) else ""
    profile_task_id = str(profile.get("task_id") or "").strip()
    task_id = str(task.get("task_id") or "").strip()
    if exact_task_id and profile_task_id and profile_task_id != exact_task_id:
        return False, ""
    if exact_task_id and task_id and task_id != exact_task_id:
        return False, ""

    budget_contract = str(
        task.get("budget_contract")
        or profile.get("budget_contract")
        or (route_canonical.get("current_budget_contract") if isinstance(route_canonical, dict) else "")
        or ""
    ).strip()
    timeout_value = (
        task.get("max_runtime_minutes")
        or task.get("timeout_minutes")
        or profile.get("max_runtime_minutes")
        or profile.get("timeout_minutes")
    )
    expected_outputs = task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else task.get("outputs")
    if not isinstance(expected_outputs, list):
        expected_outputs = profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else profile.get("outputs")

    if capability == "bounded_cpu_eval":
        profile_kind = str(profile.get("profile_kind") or "").strip().lower()
        allowed_runner = str(profile.get("allowed_runner") or task.get("allowed_runner") or "").strip().lower()
        if profile_kind not in {"cpu_followup", "bounded_cpu_eval"}:
            return False, ""
        if allowed_runner and allowed_runner != "cpu":
            return False, ""
        if not budget_contract or not timeout_value or not isinstance(expected_outputs, list) or not any(str(item or "").strip() for item in expected_outputs):
            return False, ""
        return True, "Autonomous route allows one bounded CPU follow-up because the exact profile already defines budget, timeout, and expected outputs."

    profile_kind = str(profile.get("profile_kind") or "").strip().lower()
    workspace_mode = str(profile.get("workspace_mode") or task.get("workspace_mode") or "").strip().lower()
    workspace_root = str(profile.get("workspace_root") or task.get("workspace_root") or "").strip()
    allowed_write_paths = profile.get("allowed_write_paths") if isinstance(profile.get("allowed_write_paths"), list) else task.get("allowed_write_paths")
    if profile_kind != "local_workspace_copy":
        return False, ""
    if workspace_mode not in {"project_local_copy", "local_workspace_copy"}:
        return False, ""
    if not workspace_root:
        return False, ""
    if not isinstance(allowed_write_paths, list) or not any(str(item or "").strip() for item in allowed_write_paths):
        return False, ""
    if not budget_contract or not timeout_value or not isinstance(expected_outputs, list) or not any(str(item or "").strip() for item in expected_outputs):
        return False, ""
    return True, "Autonomous route allows one bounded local workspace follow-up because the exact profile already defines workspace root, write paths, budget, timeout, and expected outputs."

def conditional_queue_enqueue_allowed(task, task_box, route_canonical):
    if classify_task_capability(task) != "queue_enqueue":
        return False, ""
    policy = task_box.get("queue_policy") if isinstance(task_box, dict) else {}
    if not isinstance(policy, dict) or policy.get("allow_conditional_enqueue") is not True:
        return False, ""
    if task_research_gate_gaps(task, task_box, route_canonical):
        return False, ""

    queue_draft = load_exact_queue_draft(route_canonical)
    queue_target = str(
        task.get("queue_target")
        or task.get("queue_name")
        or task.get("queue")
        or queue_draft.get("queue_target")
        or queue_draft.get("queue_name")
        or queue_draft.get("queue")
        or ""
    ).strip()
    command_profile = str(
        task.get("command_profile")
        or task.get("task_profile")
        or task.get("profile_path")
        or queue_draft.get("command_profile")
        or queue_draft.get("task_profile")
        or queue_draft.get("profile_path")
        or ""
    ).strip()
    budget_contract = str(task.get("budget_contract") or policy.get("budget_contract") or (route_canonical.get("current_budget_contract") if isinstance(route_canonical, dict) else "") or "").strip()
    if not budget_contract:
        budget_contract = str(queue_draft.get("budget_contract") or "").strip()
    expected_outputs = task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else task.get("outputs")
    if not isinstance(expected_outputs, list):
        expected_outputs = queue_draft.get("expected_outputs") if isinstance(queue_draft.get("expected_outputs"), list) else queue_draft.get("outputs")
    timeout_value = task.get("max_runtime_minutes") or task.get("timeout_minutes") or queue_draft.get("max_runtime_minutes") or queue_draft.get("timeout_minutes")

    if not queue_target or not command_profile or not budget_contract or not expected_outputs or not timeout_value:
        return False, ""
    if not isinstance(expected_outputs, list) or not any(str(item or "").strip() for item in expected_outputs):
        return False, ""

    text = task_policy_text(task, task.get("supervisor_approval") if isinstance(task, dict) else None)
    queue_only_policy = {"capabilities": {"queue_enqueue": True}}
    rejection = supervisor_policy_rejection(queue_only_policy, "queue_enqueue", text)
    if rejection:
        return False, ""
    if queue_draft:
        return True, "Autonomous queue policy allows one controlled queue enqueue because the exact queue draft already defines queue target, profile, budget, timeout, and expected outputs."
    return True, "Autonomous queue policy allows one controlled queue enqueue because exact queue target, profile, budget, timeout, and expected outputs are all defined."

def local_unblock_reason(state, task_box, route_canonical, run_state=None, progress=None):
    review_text = read_text("agent/REVIEW_PENDING.md")
    blockers_text = read_text("agent/BLOCKERS.md")
    run_summary = {
        "blocker_type": str((run_state or {}).get("blocker_type") or ""),
        "requires_human_review": bool((run_state or {}).get("requires_human_review")),
        "next_action": (run_state or {}).get("next_action") or {},
        "exact_next_task_id": str((run_state or {}).get("exact_next_task_id") or ""),
        "exact_profile_path": str((run_state or {}).get("exact_profile_path") or ""),
        "exact_queue_draft_path": str((run_state or {}).get("exact_queue_draft_path") or ""),
        "exact_next_object_path": str((run_state or {}).get("exact_next_object_path") or ""),
        "required_successor_exactness": str((run_state or {}).get("required_successor_exactness") or ""),
        "successor_materialization_status": str((run_state or {}).get("successor_materialization_status") or ""),
        "experiment_gate_status": str((run_state or {}).get("experiment_gate_status") or ""),
    }
    progress_summary = {
        "current_blocker": str((progress or {}).get("current_blocker") or ""),
        "requires_human_review": bool((progress or {}).get("requires_human_review")),
        "next_safe_action": (progress or {}).get("next_safe_action") or {},
        "exact_next_task_id": str((progress or {}).get("exact_next_task_id") or ""),
        "exact_profile_path": str((progress or {}).get("exact_profile_path") or ""),
        "exact_queue_draft_path": str((progress or {}).get("exact_queue_draft_path") or ""),
        "exact_next_object_path": str((progress or {}).get("exact_next_object_path") or ""),
        "required_successor_exactness": str((progress or {}).get("required_successor_exactness") or ""),
        "successor_materialization_status": str((progress or {}).get("successor_materialization_status") or ""),
        "experiment_gate_status": str((progress or {}).get("experiment_gate_status") or ""),
    }
    combined = "\\n".join([
        review_text,
        blockers_text,
        json.dumps(run_summary, sort_keys=True),
        json.dumps(progress_summary, sort_keys=True),
    ]).lower()
    scope = field_value(review_text, "scope")
    resolver = field_value(review_text, "resolver")
    autonomous = autonomous_mode(state, task_box, route_canonical)
    exact_profile_exists = bool(load_exact_profile_draft(route_canonical))
    exact_queue_exists = bool(load_exact_queue_draft(route_canonical))

    mismatch = route_epoch_mismatch(route_canonical, state, progress or {}, run_state or {})
    if mismatch:
        return "state_reconcile", mismatch

    exact_task_id = str((route_canonical or {}).get("exact_next_task_id") or "").strip()
    if autonomous and exact_task_id:
        task_box_ids = [str(task.get("task_id") or "").strip() for task in task_box_pending_tasks(task_box)]
        state_ids = [str(task.get("task_id") or "").strip() for task in pending_tasks(state)]
        draft_id = str(load_next_task_draft(ROOT).get("task_id") or "").strip()
        if task_box_ids and exact_task_id not in task_box_ids:
            return "state_reconcile", f"Canonical route exact_next_task_id={exact_task_id} but TASK_BOX.json pending tasks still point at {', '.join(task_box_ids)}; reconcile derived task mirrors before continuing."
        if draft_id and draft_id != exact_task_id:
            return "state_reconcile", f"Canonical route exact_next_task_id={exact_task_id} but NEXT_TASK_DRAFT.json still points at {draft_id}; reconcile derived task mirrors before continuing."
        if state_ids and exact_task_id not in state_ids:
            return "state_reconcile", f"Canonical route exact_next_task_id={exact_task_id} but STATE.json pending tasks still point at {', '.join(state_ids)}; reconcile derived task mirrors before continuing."

    if autonomous and infer_experiment_gate_status(route_canonical, task_box) == "blocked" and str(route_canonical.get("exact_next_task_id") or "").strip():
        return "state_reconcile", "Experiment decision gate is explicitly blocked; keep the exact successor contract synchronized, but do not execute the successor until the gate clears."

    if autonomous and isinstance(state, dict) and state.get("requires_review") is True:
        return "state_reconcile", "Canonical autonomy says requires_review=false but STATE.json still says requires_review=true; reconcile the stale derived state locally."

    if autonomous and (
        field_value(blockers_text, "blocker type") in {"stale_state", "stale_route_text"}
        or str((run_state or {}).get("blocker_type") or "").strip().lower() in {"stale_state", "stale_route_text"}
    ):
        return "state_reconcile", "Autonomous route is blocked only by stale local watchdog state; reconcile derived files locally."

    if autonomous and field_value(review_text, "state") in REVIEW_STATES:
        if scope in {"", "none", "report_only", "bookkeeping"} and resolver in {"", "none", "supervisor"}:
            return "stale_marker_cleanup", "Autonomous route is blocked by a stale bookkeeping review marker; clear the stale marker and continue."

    if autonomous and (
        "missing_profile" in combined
        or "missing profile" in combined
        or "profile package" in combined
        or "task profile" in combined
    ) and not exact_profile_exists:
        return "local_profile_authoring", "Autonomous route is blocked only by a missing local task/profile package; author it locally and continue."

    if autonomous and (
        "queue draft" in combined
        or "draft queue" in combined
        or "prepare queue request" in combined
        or "prepare taskbox" in combined
    ) and not exact_queue_exists:
        return "local_queue_draft_authoring", "Autonomous route can prepare a local queue draft/taskbox without performing a controlled enqueue yet."

    next_task_draft = load_next_task_draft(ROOT)
    if autonomous and successor_contract_gap(route_canonical, next_task_draft):
        return "state_reconcile", "Canonical route says a successor contract is required, but no exact next task/profile/queue object exists yet; repair the successor contract locally before continuing."

    if autonomous and (
        "nvidia-smi" in combined
        or "sandbox visibility" in combined
        or "unknown_in_current_environment" in combined
        or "sandbox_visibility_limited" in combined
    ) and not (
        "host_has_no_gpu" in combined
        or "real gpu outage" in combined
        or "queue runner failed" in combined
    ):
        return "state_reconcile", "Only sandbox-local GPU visibility is failing; treat it as advisory and continue via queue-aware local reconciliation."

    return "", ""

def supervisor_targets():
    targets = []
    raw_targets = os.environ.get("WATCHDOG_SUPERVISOR_TARGETS", "")
    for item in raw_targets.split(":"):
        item = item.strip()
        if item:
            targets.append(Path(item))
    config = load_json(ROOT / "agent" / "supervisor_targets.json", {})
    config_targets = config.get("targets") if isinstance(config, dict) else None
    if isinstance(config_targets, list):
        for item in config_targets:
            if isinstance(item, str) and item.strip():
                targets.append(ROOT / item.strip())
    return targets

def classify_delegable_next_action(next_action):
    kind = str(next_action.get("kind") or "").lower()
    desc = str(next_action.get("description") or "").lower()
    reason = str(next_action.get("reason") or "").lower()
    text = f"{kind}\\n{desc}\\n{reason}"
    if kind != "propose_review":
        return "", text
    if "report-only" in text or "report_only" in text or "static audit" in text or "proposal" in text or "inventory" in text:
        return "report_only", text
    if (
        "project_local_copy" in text
        or "project-local-copy" in text
        or "local workspace" in text
        or "workspace/<task_id>" in text
        or "copy into workspace" in text
    ):
        return "local_workspace_copy", text
    if "missing_profile" in text or "missing profile" in text or "task profile" in text or "profile package" in text:
        return "local_profile_authoring", text
    if "queue draft" in text or "draft queue" in text or "prepare taskbox" in text or "prepare queue request" in text:
        return "local_queue_draft_authoring", text
    if ("cpu-only" in text or "cpu32" in text or "bounded cpu" in text or "32-sample" in text or "sample_count=32" in text) and (
        "eval" in text or "smoke" in text or "helper" in text or "probe" in text
    ):
        return "bounded_cpu_eval", text
    if "queue" in text or "enqueue" in text or "agent/queue" in text or "gpu_queue" in text:
        return "queue_enqueue", text
    if "gpu" in text and ("bounded" in text or "probe" in text or "smoke" in text or "eval" in text or "sample" in text):
        return "bounded_gpu_probe", text
    if ("training" in text or "train " in text) and ("bounded" in text or "canary" in text or "smoke" in text):
        return "bounded_training_canary", text
    return "", text

def supervisor_delegable_blocker():
    for target in supervisor_targets():
        target_policy = load_supervisor_capability_policy(target)
        target_state = load_json(target / "agent" / "STATE.json", {})
        target_task_box = load_task_box(target)
        target_route = load_route_canonical(target)
        target_run_state = load_json(target / "agent" / "RUN_STATE.json", {})
        target_progress = load_json(target / "agent" / "PROGRESS_STATE.json", {})
        target_review_text = read_text_path(target / "agent" / "REVIEW_PENDING.md").lower()
        target_blockers_text = read_text_path(target / "agent" / "BLOCKERS.md").lower()
        combined = "\\n".join([
            target_review_text,
            target_blockers_text,
            json.dumps(target_run_state or {}, sort_keys=True),
            json.dumps(target_progress or {}, sort_keys=True),
        ])
        if "missing_profile" in combined or "missing profile" in combined or "task profile" in combined:
            if capability_enabled(target_policy, "local_profile_authoring"):
                return {"target": str(target), "capability": "local_profile_authoring"}
        if field_value(target_blockers_text, "blocker type") in {"stale_state", "stale_route_text"} or str((target_run_state or {}).get("blocker_type") or "").strip().lower() in {"stale_state", "stale_route_text"}:
            if capability_enabled(target_policy, "state_reconcile"):
                return {"target": str(target), "capability": "state_reconcile"}
        if field_value(target_review_text, "state") in REVIEW_STATES and field_value(target_review_text, "scope") in {"", "none", "report_only", "bookkeeping"}:
            if capability_enabled(target_policy, "stale_marker_cleanup"):
                return {"target": str(target), "capability": "stale_marker_cleanup"}
        if "queue draft" in combined or "draft queue" in combined or "prepare queue request" in combined or "prepare taskbox" in combined:
            if capability_enabled(target_policy, "local_queue_draft_authoring"):
                return {"target": str(target), "capability": "local_queue_draft_authoring"}

        progress = load_json(target / "agent" / "PROGRESS_STATE.json", {})
        if not isinstance(progress, dict) or progress.get("requires_human_review") is not True:
            continue
        next_action = progress.get("next_safe_action")
        if not isinstance(next_action, dict):
            continue
        capability, text = classify_delegable_next_action(next_action)
        if not capability:
            continue
        if not capability_enabled(target_policy, capability):
            continue
        if supervisor_policy_rejection(target_policy, capability, text):
            continue
        return {"target": str(target), "capability": capability}
    return ""

def route():
    state = load_json(ROOT / "agent" / "STATE.json", {})
    task_box = load_task_box(ROOT)
    route_canonical = load_route_canonical(ROOT)
    next_task_draft = load_next_task_draft(ROOT)
    progress = load_json(ROOT / "agent" / "PROGRESS_STATE.json", {})
    run_state = load_json(ROOT / "agent" / "RUN_STATE.json", {})
    paused = (ROOT / "agent" / "control" / "PAUSE").exists()
    compaction_due = os.environ.get("WATCHDOG_COMPACTION_DUE") == "1"
    role = os.environ.get("WATCHDOG_ROLE", "runner")
    supervisor_mode = os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")

    if paused:
        return {
            "primary_skill": "watchdog-handoff-writer",
            "reason": "agent/control/PAUSE exists; no Codex work should be started.",
            "stop_condition": "Write paused status and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if role == "supervisor":
        delegable = supervisor_delegable_blocker()
        if supervisor_mode in ("audit", "light") and delegable:
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"Supervisor delegated runner blocker found in {delegable.get('target')} with capability={delegable.get('capability')}.",
                "stop_condition": "Resolve one safe local runner blocker by writing compact approval/status notes, a reconciliation patch, or a bounded local package/draft, then stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": "supervisor-delegated-runner-blocker-approval"
            }
        if supervisor_mode == "audit":
            return {
                "primary_skill": "watchdog-cleanup-auditor",
                "reason": "Supervisor heavy audit is due by runner-cycle cadence.",
                "stop_condition": "Run one read-only audit for anti-snowball, leakage, environment, stale state, and blocker hygiene; write compact handoff outputs and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        if supervisor_mode == "light":
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": "Supervisor lightweight follow-up is due after a runner cycle or reviewer/blocker marker.",
                "stop_condition": "Repair only safe stale-state, stale-marker, missing-profile, queue-draft, or blocker-bookkeeping issues and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        return {
            "primary_skill": "watchdog-handoff-writer",
            "reason": "Supervisor standby: no new runner cycle and heavy audit cadence is not due.",
            "stop_condition": "Write a short heartbeat and stop without operational changes.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if has_files("agent/queue/running", "gpu_running", "cpu_running"):
        return {
            "primary_skill": "watchdog-job-queue",
            "reason": "A running job is present; monitor exactly one running job.",
            "stop_condition": "Update queue status and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if has_files("agent/queue/done", "gpu_done", "cpu_done", freshness_minutes=RESULT_FRESH_MINUTES):
        return {
            "primary_skill": "watchdog-gate-evaluator",
            "reason": "A completed job/result is present and may need gate evaluation.",
            "stop_condition": "Evaluate one completed result or write a blocker, then stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if has_files("agent/queue/queued", "gpu_queue", "cpu_queue"):
        return {
            "primary_skill": "watchdog-job-queue",
            "reason": "A queued job is present; inspect queue state and avoid duplicate submission.",
            "stop_condition": "Update queue status and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    pending, pending_source = preferred_pending_tasks(state, task_box, next_task_draft, route_canonical)
    if pending:
        local_capability, local_reason = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
        if local_capability:
            task = pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": local_reason,
                "stop_condition": "Perform exactly one safe local unblock or derived-state reconcile, refresh compact state, and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        research_gap_pending = []
        for task in pending:
            gaps = task_research_gate_gaps(task, task_box, route_canonical)
            if gaps:
                research_gap_pending.append((task, gaps))
        if research_gap_pending:
            task, gaps = research_gap_pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected task is missing research-contract fields: {', '.join(gaps)}. Repair TASK_BOX/task metadata locally before executing the bounded step.",
                "stop_condition": "Add the missing topic/claim/fairness/value-of-information fields to the structured task contract, refresh compact state, and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        report_only_pending = [t for t in pending if task_is_report_only(t)]
        if report_only_pending:
            task = report_only_pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected report-only task can proceed without human-review handoff.",
                "stop_condition": "Choose one report-only next safe action or write a blocker, then stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        supervisor_approved_pending = [t for t in pending if task_is_supervisor_approved(t)]
        if supervisor_approved_pending:
            task = supervisor_approved_pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected bounded task has explicit supervisor approval.",
                "stop_condition": "Execute or prepare exactly one supervisor-approved bounded task within its approval scope; write outputs/provenance or a blocker, then stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        if autonomous_mode(state, task_box, route_canonical):
            for task in pending:
                capability = classify_task_capability(task)
                if capability == "queue_enqueue":
                    queue_allowed, queue_reason = conditional_queue_enqueue_allowed(task, task_box, route_canonical)
                    if queue_allowed:
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; {queue_reason}",
                            "stop_condition": "Perform exactly one controlled queue enqueue inside the declared queue boundary, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                    queue_draft = load_exact_queue_draft(route_canonical)
                    if queue_draft:
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; exact queue draft is already materialized, but autonomous enqueue is still disabled by queue policy, so keep the draft explicit and refresh NEXT_ACTION instead of stalling.",
                            "stop_condition": "Do not enqueue yet; keep the exact queue/profile draft coherent, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                    queue_text = task_policy_text(task, task.get("supervisor_approval") if isinstance(task, dict) else None)
                    queue_only_policy = {"capabilities": {"queue_enqueue": True}}
                    if not supervisor_policy_rejection(queue_only_policy, "queue_enqueue", queue_text):
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; queue enqueue is not yet executable, so prepare the exact queue/profile draft locally and refresh NEXT_ACTION instead of stalling.",
                            "stop_condition": "Author or repair exactly one local queue draft/profile package, do not enqueue yet, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                if capability in {"bounded_cpu_eval", "local_workspace_copy"}:
                    profile_allowed, profile_reason = exact_profile_followup_allowed(task, task_box, route_canonical)
                    if profile_allowed:
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; {profile_reason}",
                            "stop_condition": "Execute or prepare exactly one bounded local follow-up inside the exact profile contract, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                if safe_autonomous_capability(capability):
                    return {
                        "primary_skill": "watchdog-orchestrator",
                        "reason": f"{len(pending)} pending task(s) exist in {pending_source}; autonomous mode allows one bounded {capability} step without waiting on unrelated review markers.",
                        "stop_condition": "Execute or prepare exactly one bounded local autonomous task, refresh compact state, and stop.",
                        "permission_guardian_required": False,
                        "permission_guardian_result": "not_required",
                        "route_locked": True,
                        "task_id": task.get("task_id")
                    }
        review_blocked, review_reason = active_review_marker(state)
        if review_blocked:
            return {
                "primary_skill": "watchdog-handoff-writer",
                "reason": review_reason,
                "stop_condition": "Write one review-required handoff and stop; do not auto-approve executable or mutation work.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        selected = pending[0]
        guardian_needed = permission_guardian_needed(selected)
        return {
            "primary_skill": "watchdog-orchestrator",
            "reason": f"{len(pending)} pending task(s) exist in {pending_source}.",
            "stop_condition": "Choose one next safe bounded action or write a blocker, then stop.",
            "permission_guardian_required": guardian_needed,
            "permission_guardian_result": "not_required" if not guardian_needed else "pending",
            "route_locked": True,
            "task_id": selected.get("task_id")
        }

    if todo_has_pending():
        local_capability, local_reason = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
        if local_capability:
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": local_reason,
                "stop_condition": "Perform one safe local unblock, refresh compact state, and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        return {
            "primary_skill": "watchdog-orchestrator",
            "reason": "agent/TODO.md contains a pending or unchecked task but STATE/TASK_BOX has no runnable structured task; continue with one bounded next step while asking daily mode to structure the task box if needed.",
            "stop_condition": "Choose one bounded next step or write a blocker asking daily mode to structure TASK_BOX.json/STATE.json, then stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if compaction_due:
        return {
            "primary_skill": "watchdog-report-curator",
            "reason": "Scheduled compaction cycle is due and no higher-priority active work was found.",
            "stop_condition": "Refresh compact state/report outputs and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    review_blocked, review_reason = active_review_marker(state)
    local_capability, local_reason = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
    if local_capability:
        return {
            "primary_skill": "watchdog-orchestrator",
            "reason": local_reason,
            "stop_condition": "Perform one safe local unblock or state reconcile and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }
    if review_blocked:
        return {
            "primary_skill": "watchdog-handoff-writer",
            "reason": review_reason,
            "stop_condition": "Write one review-required handoff and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    return {
        "primary_skill": "watchdog-handoff-writer",
        "reason": "No paused state, running job, completed result, review request, queued job, or pending STATE/TASK_BOX task was found.",
        "stop_condition": "Write idle/blocked status and stop.",
        "permission_guardian_required": False,
        "permission_guardian_result": "not_required",
        "route_locked": True
    }

state = load_json(ROOT / "agent" / "STATE.json", {})
task_box = load_task_box(ROOT)
route_canonical = load_route_canonical(ROOT)
next_task_draft = load_next_task_draft(ROOT)
progress = load_json(ROOT / "agent" / "PROGRESS_STATE.json", {})
run_state = load_json(ROOT / "agent" / "RUN_STATE.json", {})
role = os.environ.get("WATCHDOG_ROLE", "runner")
supervisor_mode = os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")

result = route()
route_capability = route_capability_from_result(result, role, supervisor_mode, state, task_box, next_task_draft, route_canonical, run_state, progress)
result["secondary_skills"] = selected_secondary_skills(result, role, supervisor_mode, route_capability)
result["route_capability"] = route_capability or None
payload = {
    "route_version": 1,
    "updated_utc": now_utc(),
    **result
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(payload, indent=2) + "\\n")
print(json.dumps(payload, indent=2))
`,

  validateRuntime: () => `#!/usr/bin/env python3
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(".")
OUT = ROOT / "agent" / "status" / "RUNTIME_VALIDATION.json"

VALID_SKILLS = {
    "watchdog-orchestrator",
    "watchdog-job-queue",
    "watchdog-gate-evaluator",
    "watchdog-report-curator",
    "watchdog-permission-guardian",
    "watchdog-handoff-writer",
    "watchdog-cleanup-auditor",
}
VALID_TASK_STATUS = {"pending", "queued", "running", "done", "failed", "rejected", "blocked"}
VALID_JOB_STATUS = {"queued", "running", "done", "failed", "cancelled"}
VALID_RUNNERS = {"cpu", "gpu", "report_only"}

errors = []
warnings = []

def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def load_json(path, required=False):
    p = ROOT / path
    if not p.exists():
        if required:
            errors.append(f"missing required JSON file: {path}")
        return None
    try:
        return json.loads(p.read_text())
    except Exception as exc:
        errors.append(f"invalid JSON in {path}: {exc}")
        return None

def require_type(value, expected, label):
    if not isinstance(value, expected):
        errors.append(f"{label} has wrong type")
        return False
    return True

def validate_state():
    state = load_json("agent/STATE.json", required=True)
    if not isinstance(state, dict):
        return
    if not isinstance(state.get("schema_version"), int):
        errors.append("agent/STATE.json schema_version must be an integer")
    if state.get("mode") not in {"observer", "project-local-worker", "gpu-queue-worker", "maintainer"}:
        errors.append("agent/STATE.json mode is invalid")
    if not isinstance(state.get("requires_review"), bool):
        errors.append("agent/STATE.json requires_review must be boolean")
    for key in ("updated_utc", "route_id", "route_epoch", "active_task_id", "route_task_id", "active_branch", "allowed_next_action", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status", "task_box_id", "owner_mode", "current_allowed_step", "project_question", "decision_relevance", "claim_scope", "diagnosis_target"):
        if key in state and state.get(key) is not None and not isinstance(state.get(key), str):
            errors.append(f"agent/STATE.json {key} must be string or null")
    for key in ("successor_contract_required", "experiment_decision_gate_required", "experiment_decision_gate_blocking", "derived_from_route_canonical"):
        if key in state and not isinstance(state.get(key), bool):
            errors.append(f"agent/STATE.json {key} must be boolean")
    if "important_paths" in state and not isinstance(state.get("important_paths"), list):
        errors.append("agent/STATE.json important_paths must be an array")
    tasks = state.get("tasks")
    if not isinstance(tasks, list):
        errors.append("agent/STATE.json tasks must be an array")
        return
    seen = set()
    active = []
    for idx, task in enumerate(tasks):
        label = f"agent/STATE.json tasks[{idx}]"
        if not isinstance(task, dict):
            errors.append(f"{label} must be an object")
            continue
        tid = task.get("task_id")
        if not isinstance(tid, str) or not tid.strip():
            errors.append(f"{label}.task_id must be a nonempty string")
        elif tid in seen:
            errors.append(f"duplicate task_id in STATE.json: {tid}")
        else:
            seen.add(tid)
        if task.get("status") not in VALID_TASK_STATUS:
            errors.append(f"{label}.status is invalid")
        if task.get("allowed_runner") not in VALID_RUNNERS:
            errors.append(f"{label}.allowed_runner is invalid")
        if task.get("status") in {"queued", "running"} and tid:
            active.append(tid)
    for tid in set(active):
        if active.count(tid) > 1:
            errors.append(f"task_id has multiple active STATE entries: {tid}")

def validate_progress():
    progress = load_json("agent/PROGRESS_STATE.json", required=True)
    if not isinstance(progress, dict):
        return
    if "no_progress_cycles" in progress and not isinstance(progress.get("no_progress_cycles"), int):
        errors.append("agent/PROGRESS_STATE.json no_progress_cycles must be integer")
    if "recommend_pause" in progress and not isinstance(progress.get("recommend_pause"), bool):
        errors.append("agent/PROGRESS_STATE.json recommend_pause must be boolean")
    if "route_epoch" in progress and progress.get("route_epoch") is not None and not isinstance(progress.get("route_epoch"), str):
        errors.append("agent/PROGRESS_STATE.json route_epoch must be string or null")
    for key in ("active_task_id", "route_task_id", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status", "owner_mode", "current_allowed_step"):
        if key in progress and progress.get(key) is not None and not isinstance(progress.get(key), str):
            errors.append(f"agent/PROGRESS_STATE.json {key} must be string or null")
    if "successor_contract_required" in progress and not isinstance(progress.get("successor_contract_required"), bool):
        errors.append("agent/PROGRESS_STATE.json successor_contract_required must be boolean")
    for key in ("experiment_decision_gate_required", "experiment_decision_gate_blocking"):
        if key in progress and not isinstance(progress.get(key), bool):
            errors.append(f"agent/PROGRESS_STATE.json {key} must be boolean")

def validate_task_box():
    task_box = load_json("agent/TASK_BOX.json", required=False)
    if task_box is None:
        return
    if not isinstance(task_box, dict):
        errors.append("agent/TASK_BOX.json must be an object")
        return
    tasks = task_box.get("tasks")
    if tasks is not None and not isinstance(tasks, list):
        errors.append("agent/TASK_BOX.json tasks must be an array")
    queue_policy = task_box.get("queue_policy")
    if queue_policy is not None and not isinstance(queue_policy, dict):
        errors.append("agent/TASK_BOX.json queue_policy must be an object")
    for key in ("project_question", "decision_relevance", "uncertainty_reduced_if_success", "uncertainty_reduced_if_failure", "claim_scope", "diagnosis_target"):
        if key in task_box and task_box.get(key) is not None and not isinstance(task_box.get(key), str):
            errors.append(f"agent/TASK_BOX.json {key} must be string or null")
    forbidden = task_box.get("forbidden_conclusions")
    if forbidden is not None and not isinstance(forbidden, list):
        errors.append("agent/TASK_BOX.json forbidden_conclusions must be an array")
    fair = task_box.get("fair_comparability")
    if fair is not None and not isinstance(fair, dict):
        errors.append("agent/TASK_BOX.json fair_comparability must be an object")
    voi = task_box.get("value_of_information")
    if voi is not None and not isinstance(voi, dict):
        errors.append("agent/TASK_BOX.json value_of_information must be an object")
    gate_policy = task_box.get("gate_policy")
    if gate_policy is not None and not isinstance(gate_policy, dict):
        errors.append("agent/TASK_BOX.json gate_policy must be an object")
    for key in ("owner_mode", "current_allowed_step", "active_task_id", "route_task_id", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status"):
        if key in task_box and task_box.get(key) is not None and not isinstance(task_box.get(key), str):
            errors.append(f"agent/TASK_BOX.json {key} must be string or null")
    for key in ("successor_contract_required", "experiment_decision_gate_required", "experiment_decision_gate_blocking"):
        if key in task_box and not isinstance(task_box.get(key), bool):
            errors.append(f"agent/TASK_BOX.json {key} must be boolean")

def validate_route_canonical():
    route = load_json("agent/ROUTE_CANONICAL.json", required=False)
    if route is None:
        return
    if not isinstance(route, dict):
        errors.append("agent/ROUTE_CANONICAL.json must be an object")
        return
    if "route_epoch" in route and route.get("route_epoch") is not None and not isinstance(route.get("route_epoch"), str):
        errors.append("agent/ROUTE_CANONICAL.json route_epoch must be string or null")
    if "owner_mode" in route and route.get("owner_mode") is not None and not isinstance(route.get("owner_mode"), str):
        errors.append("agent/ROUTE_CANONICAL.json owner_mode must be string or null")
    if "successor_contract_required" in route and not isinstance(route.get("successor_contract_required"), bool):
        errors.append("agent/ROUTE_CANONICAL.json successor_contract_required must be boolean")
    for key in ("exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status"):
        if key in route and route.get(key) is not None and not isinstance(route.get(key), str):
            errors.append(f"agent/ROUTE_CANONICAL.json {key} must be string or null")
    for key in ("experiment_decision_gate_required", "experiment_decision_gate_blocking"):
        if key in route and not isinstance(route.get(key), bool):
            errors.append(f"agent/ROUTE_CANONICAL.json {key} must be boolean")

def validate_next_task_draft():
    draft = load_json("agent/status/NEXT_TASK_DRAFT.json", required=False)
    if draft is None:
        return
    if not isinstance(draft, dict):
        errors.append("agent/status/NEXT_TASK_DRAFT.json must be an object")
        return
    if not isinstance(draft.get("task_id"), str) or not str(draft.get("task_id") or "").strip():
        errors.append("agent/status/NEXT_TASK_DRAFT.json task_id must be a nonempty string")
    if "status" in draft and draft.get("status") not in VALID_TASK_STATUS:
        errors.append("agent/status/NEXT_TASK_DRAFT.json status is invalid")
    if "allowed_runner" in draft and draft.get("allowed_runner") not in VALID_RUNNERS:
        errors.append("agent/status/NEXT_TASK_DRAFT.json allowed_runner is invalid")

def validate_schema_files():
    for rel in (
        "agent/schemas/watch_decision.schema.json",
        "agent/schemas/bootstrap_conversation_turn.schema.json",
        "agent/schemas/bootstrap_instantiation.schema.json",
        "agent/schemas/state.schema.json",
        "agent/schemas/task_box.schema.json",
        "agent/schemas/route_canonical.schema.json",
        "agent/schemas/secondary_skills.schema.json",
        "agent/schemas/job.schema.json",
        "agent/schemas/gate.schema.json",
    ):
        data = load_json(rel, required=True)
        if not isinstance(data, dict):
            continue
        if data.get("type") != "object":
            warnings.append(f"{rel} does not declare top-level type=object")

def validate_job_file(path, expected_status=None):
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        errors.append(f"invalid job JSON in {path}: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"job file must be an object: {path}")
        return None
    for key in ("job_id", "task_id", "created_utc", "runner", "command_profile", "expected_outputs", "max_runtime_minutes"):
        if key not in data:
            errors.append(f"{path} missing required job key: {key}")
    if data.get("runner") not in VALID_RUNNERS:
        errors.append(f"{path} runner is invalid")
    status = data.get("status")
    if status not in VALID_JOB_STATUS:
        errors.append(f"{path} status is invalid")
    if expected_status and status != expected_status:
        warnings.append(f"{path} status={status!r} does not match directory status={expected_status!r}")
    if not isinstance(data.get("expected_outputs", []), list):
        errors.append(f"{path} expected_outputs must be an array")
    if not isinstance(data.get("max_runtime_minutes", 1), int):
        errors.append(f"{path} max_runtime_minutes must be integer")
    return data

def validate_jobs():
    running_task_ids = []
    for dirname, expected in (
        ("agent/queue/queued", "queued"),
        ("agent/queue/running", "running"),
        ("agent/queue/done", "done"),
        ("agent/queue/failed", "failed"),
    ):
        d = ROOT / dirname
        if not d.exists():
            continue
        for item in d.iterdir():
            if item.name.startswith(".") or not item.is_file():
                continue
            if item.suffix != ".json":
                warnings.append(f"non-json queue file ignored by validator: {item}")
                continue
            data = validate_job_file(item, expected)
            if data and expected == "running":
                running_task_ids.append(data.get("task_id"))
    for tid in set(t for t in running_task_ids if t):
        if running_task_ids.count(tid) > 1:
            errors.append(f"task_id has multiple running job files: {tid}")

def validate_gates():
    for dirname in ("agent/gates/pending", "agent/gates/passed", "agent/gates/failed", "agent/gates/review_required"):
        d = ROOT / dirname
        if not d.exists():
            continue
        for item in d.glob("*.json"):
            data = load_json(str(item), required=False)
            if data is None:
                continue
            if not isinstance(data, dict):
                errors.append(f"gate file must be an object: {item}")
                continue
            if "job_id" not in data and "gates" not in data:
                warnings.append(f"gate file has no job_id/gates key: {item}")

def validate_secondary_skills_config():
    config = load_json("agent/SECONDARY_SKILLS.json", required=False)
    if config is None:
        return
    if not isinstance(config, dict):
        errors.append("agent/SECONDARY_SKILLS.json must be an object")
        return
    if not isinstance(config.get("schema_version"), int):
        errors.append("agent/SECONDARY_SKILLS.json schema_version must be an integer")
    skills = config.get("skills")
    if not isinstance(skills, list):
        errors.append("agent/SECONDARY_SKILLS.json skills must be an array")
        return
    seen = set()
    for idx, item in enumerate(skills):
        label = f"agent/SECONDARY_SKILLS.json skills[{idx}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        skill_id = item.get("skill_id")
        if not isinstance(skill_id, str) or not skill_id.strip():
            errors.append(f"{label}.skill_id must be a nonempty string")
        elif skill_id in seen:
            errors.append(f"duplicate secondary skill_id: {skill_id}")
        else:
            seen.add(skill_id)
        rel_path = item.get("path")
        if not isinstance(rel_path, str) or not rel_path.strip():
            errors.append(f"{label}.path must be a nonempty string")
        else:
            skill_path = ROOT / rel_path
            if Path(rel_path).is_absolute():
                errors.append(f"{label}.path must stay project-relative")
            elif not skill_path.exists():
                errors.append(f"{label}.path does not exist: {rel_path}")
        if "enabled" in item and not isinstance(item.get("enabled"), bool):
            errors.append(f"{label}.enabled must be boolean when present")
        selectors = item.get("selectors")
        if not isinstance(selectors, dict):
            errors.append(f"{label}.selectors must be an object")
            continue
        for key in ("primary_skills", "roles", "supervisor_modes", "task_capabilities"):
            value = selectors.get(key, [])
            if not isinstance(value, list) or not all(isinstance(entry, str) for entry in value):
                errors.append(f"{label}.selectors.{key} must be an array of strings")

def validate_skill_route():
    route = load_json("agent/status/SKILL_ROUTE.json", required=False)
    if route is None:
        return
    if not isinstance(route, dict):
        errors.append("agent/status/SKILL_ROUTE.json must be an object")
        return
    if route.get("primary_skill") not in VALID_SKILLS:
        errors.append("agent/status/SKILL_ROUTE.json primary_skill is invalid")
    secondary = route.get("secondary_skills", [])
    if not isinstance(secondary, list):
        errors.append("agent/status/SKILL_ROUTE.json secondary_skills must be an array")
    else:
        seen = set()
        for idx, item in enumerate(secondary):
            label = f"agent/status/SKILL_ROUTE.json secondary_skills[{idx}]"
            if not isinstance(item, dict):
                errors.append(f"{label} must be an object")
                continue
            skill_id = item.get("skill_id")
            if not isinstance(skill_id, str) or not skill_id.strip():
                errors.append(f"{label}.skill_id must be a nonempty string")
            elif skill_id in seen:
                errors.append(f"duplicate routed secondary skill_id: {skill_id}")
            else:
                seen.add(skill_id)
            rel_path = item.get("path")
            if not isinstance(rel_path, str) or not rel_path.strip():
                errors.append(f"{label}.path must be a nonempty string")
            else:
                skill_path = ROOT / rel_path
                if Path(rel_path).is_absolute():
                    errors.append(f"{label}.path must stay project-relative")
                elif not skill_path.exists():
                    errors.append(f"{label}.path does not exist: {rel_path}")
    if "route_capability" in route and route.get("route_capability") is not None and not isinstance(route.get("route_capability"), str):
        errors.append("agent/status/SKILL_ROUTE.json route_capability must be string or null")

validate_state()
validate_progress()
validate_task_box()
validate_route_canonical()
validate_next_task_draft()
validate_schema_files()
validate_jobs()
validate_gates()
validate_secondary_skills_config()
validate_skill_route()

payload = {
    "ok": not errors,
    "updated_utc": now_utc(),
    "errors": errors,
    "warnings": warnings
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(payload, indent=2) + "\\n")
print(json.dumps(payload, indent=2))
if errors:
    sys.exit(1)
`,

  renderReport: () => `#!/usr/bin/env python3
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())

def safe_name(value):
    raw = str(value or "unknown")
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", raw).strip("._-")[:80] or "unknown"

route_path = Path("agent/status/SKILL_ROUTE.json")
if route_path.exists():
    route = json.loads(route_path.read_text())
    expected_skill = route.get("primary_skill")
    actual_skill = data.get("primary_skill")
    if expected_skill and actual_skill != expected_skill:
        raise SystemExit(f"primary_skill mismatch: expected {expected_skill!r} from SKILL_ROUTE.json, got {actual_skill!r}")
else:
    route = {}

def normalized_secondary_skill_ids(items):
    result = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict):
            value = str(item.get("skill_id") or "").strip()
        else:
            value = str(item or "").strip()
        if value and value not in result:
            result.append(value)
    return result

expected_secondary_skills = normalized_secondary_skill_ids(route.get("secondary_skills", []))
actual_secondary_skills = normalized_secondary_skill_ids(data.get("secondary_skills_consulted", []))
if expected_secondary_skills != actual_secondary_skills:
    raise SystemExit(
        f"secondary_skills_consulted mismatch: expected {expected_secondary_skills!r} from SKILL_ROUTE.json, got {actual_secondary_skills!r}"
    )

task_box_path = Path("agent/TASK_BOX.json")
try:
    task_box = json.loads(task_box_path.read_text()) if task_box_path.exists() else {}
except Exception:
    task_box = {}
route_canonical_path = Path("agent/ROUTE_CANONICAL.json")
try:
    route_canonical = json.loads(route_canonical_path.read_text()) if route_canonical_path.exists() else {}
except Exception:
    route_canonical = {}

def atomic_write_text(path, text):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(target)

def atomic_write_json(path, payload):
    atomic_write_text(path, json.dumps(payload, indent=2) + "\\n")

def append_jsonl(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\\n")

def int_env(name, fallback=0):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except Exception:
        return fallback
    return value if value >= 0 else fallback

def clean_object(value):
    return value if isinstance(value, dict) else {}

def normalize_successor_task(value):
    if not isinstance(value, dict):
        return {}
    task_id = str(value.get("task_id") or "").strip()
    if not task_id:
        return {}
    task = dict(value)
    task["task_id"] = task_id
    if not task.get("status"):
        task["status"] = "pending"
    return task

def merge_route_canonical(existing, update, updated_utc):
    merged = dict(existing) if isinstance(existing, dict) else {}
    clearable_keys = {
        "active_task_id",
        "exact_next_task_id",
        "exact_profile_path",
        "exact_queue_draft_path",
        "exact_next_object_path",
        "required_successor_exactness",
        "successor_materialization_status",
        "experiment_gate_status",
    }
    if isinstance(update, dict):
        for key, value in update.items():
            if value is None and key not in clearable_keys:
                continue
            merged[key] = value
    if merged:
        merged.setdefault("schema_version", 1)
        merged["updated_utc"] = updated_utc
    return merged

def ensure_task_box(existing, route_canonical):
    if isinstance(existing, dict) and existing:
        box = dict(existing)
    else:
        box = {
            "schema_version": 1,
            "task_box_id": str((route_canonical or {}).get("route_id") or "runtime-task-box"),
            "route_id": str((route_canonical or {}).get("route_id") or "runtime-route"),
            "route_epoch": str((route_canonical or {}).get("route_epoch") or "runtime-000"),
            "requires_review": bool((route_canonical or {}).get("requires_review", False)),
            "allowed_actions": [],
            "blocked_actions": [],
            "allowed_write_paths": [
                "agent/status/",
                "agent/reports/",
                "agent/pending/",
                "agent/task_profiles/",
                "workspace/",
                "runs/"
            ],
            "queue_policy": {
                "gpu": "queue_only",
                "max_new_jobs_per_wakeup": 1,
                "allow_conditional_enqueue": False
            },
            "tasks": []
        }
    if isinstance(route_canonical, dict) and route_canonical:
        if route_canonical.get("route_id"):
            box["route_id"] = route_canonical.get("route_id")
        if route_canonical.get("route_epoch"):
            box["route_epoch"] = route_canonical.get("route_epoch")
        if isinstance(route_canonical.get("requires_review"), bool):
            box["requires_review"] = route_canonical.get("requires_review")
        for key in ("owner_mode", "current_allowed_step", "active_task_id", "route_task_id", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status"):
            if key in route_canonical:
                box[key] = route_canonical.get(key)
        for key in ("successor_contract_required", "experiment_decision_gate_required", "experiment_decision_gate_blocking"):
            if isinstance(route_canonical.get(key), bool):
                box[key] = route_canonical.get(key)
    box.setdefault("schema_version", 1)
    if not isinstance(box.get("tasks"), list):
        box["tasks"] = []
    if not isinstance(box.get("queue_policy"), dict):
        box["queue_policy"] = {}
    box["queue_policy"].setdefault("allow_conditional_enqueue", False)
    return box

def upsert_task_box_task(task_box, task):
    if not task:
        return task_box
    tasks = []
    replaced = False
    for existing in task_box.get("tasks", []):
        if not isinstance(existing, dict):
            continue
        if str(existing.get("task_id") or "") == task["task_id"]:
            merged = dict(existing)
            merged.update(task)
            tasks.append(merged)
            replaced = True
        else:
            tasks.append(existing)
    if not replaced:
        tasks.append(task)
    task_box["tasks"] = tasks
    return task_box

def merge_task_box(existing, update):
    box = ensure_task_box(existing, route_canonical)
    if not isinstance(update, dict):
        return box
    for key, value in update.items():
        if key == "tasks":
            continue
        if value is None:
            continue
        box[key] = value
    for task in update.get("tasks", []) if isinstance(update.get("tasks"), list) else []:
        if isinstance(task, dict) and str(task.get("task_id") or "").strip():
            box = upsert_task_box_task(box, task)
    return box

def prune_previous_exact_task_from_task_box(task_box, previous_exact_task_id, current_exact_task_id):
    if not isinstance(task_box, dict):
        return task_box
    previous_exact_task_id = str(previous_exact_task_id or "").strip()
    current_exact_task_id = str(current_exact_task_id or "").strip()
    if not previous_exact_task_id or not current_exact_task_id or previous_exact_task_id == current_exact_task_id:
        return task_box
    tasks = task_box.get("tasks")
    if not isinstance(tasks, list):
        return task_box
    task_box["tasks"] = [
        task for task in tasks
        if not (
            isinstance(task, dict)
            and str(task.get("task_id") or "").strip() == previous_exact_task_id
            and str(task.get("status") or "").strip().lower() == "pending"
        )
    ]
    return task_box

def infer_successor_allowed_runner(next_action, route_canonical, queue_request_draft, task_profile_draft):
    candidates = []
    if isinstance(queue_request_draft, dict):
        candidates.extend([
            queue_request_draft.get("allowed_runner"),
            queue_request_draft.get("runner"),
            "gpu" if str(queue_request_draft.get("queue_target") or "").strip() else "",
        ])
    if isinstance(task_profile_draft, dict):
        candidates.extend([
            task_profile_draft.get("allowed_runner"),
            task_profile_draft.get("runner"),
        ])
    if isinstance(route_canonical, dict):
        candidates.append(route_canonical.get("preferred_runner"))
        candidates.append("gpu" if str(route_canonical.get("exact_queue_draft_path") or "").strip() else "")
        step = str(route_canonical.get("current_allowed_step") or "").strip().lower()
        if any(term in step for term in ("local_workspace_copy", "local-workspace-copy", "workspace_copy", "local copy", "project_local_copy")):
            candidates.append("cpu")
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
        if "gpu" in text or "queue" in text:
            candidates.append("gpu")
        elif "local workspace" in text or "project-local" in text or "project local" in text or "local copy" in text:
            candidates.append("cpu")
        elif "cpu" in text or "smoke" in text or "eval" in text or "probe" in text:
            candidates.append("cpu")
    for candidate in candidates:
        value = str(candidate or "").strip().lower()
        if value in {"cpu", "gpu", "report_only"}:
            return value
    return "report_only"

def infer_successor_workspace_mode(next_action, route_canonical):
    text = ""
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
    step = str((route_canonical or {}).get("current_allowed_step") or "").lower()
    if "local workspace" in text or "project local" in text or "local copy" in text:
        return "project_local_copy"
    if "workspace" in step or "local_copy" in step or "local-copy" in step or "copy" in step:
        return "project_local_copy"
    return "readonly"

def infer_successor_queue_mode(task_box, route_canonical, next_action, allowed_runner):
    if allowed_runner != "gpu":
        return False
    policy = task_box.get("queue_policy") if isinstance(task_box, dict) else {}
    policy_gpu = str(policy.get("gpu") or "").strip().lower() if isinstance(policy, dict) else ""
    text = ""
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
    step = str((route_canonical or {}).get("current_allowed_step") or "").lower()
    if policy_gpu == "queue_only":
        return True
    if any(term in text for term in ("queue", "enqueue", "gpu_queue")):
        return True
    return any(term in step for term in ("queue", "enqueue", "gpu"))

def infer_successor_output_paths(task_id, allowed_runner, workspace_mode, queue_request_draft):
    if isinstance(queue_request_draft, dict):
        outputs = queue_request_draft.get("expected_outputs") if isinstance(queue_request_draft.get("expected_outputs"), list) else queue_request_draft.get("outputs")
        if isinstance(outputs, list) and any(str(item or "").strip() for item in outputs):
            return [str(item).strip() for item in outputs if str(item or "").strip()]
    slug = safe_name(task_id or "next-task")
    if workspace_mode == "project_local_copy":
        return [f"workspace/{slug}/", f"agent/reports/{slug}.md"]
    if allowed_runner in {"cpu", "gpu"}:
        return [f"runs/{slug}/metrics.json"]
    return [f"agent/reports/{slug}.md"]

def infer_successor_allowed_write_paths(task_box, workspace_mode):
    allowed = task_box.get("allowed_write_paths") if isinstance(task_box, dict) else None
    if isinstance(allowed, list) and any(str(item or "").strip() for item in allowed):
        return [str(item).strip() for item in allowed if str(item or "").strip()]
    if workspace_mode == "project_local_copy":
        return ["workspace/", "runs/", "agent/status/", "agent/reports/", "agent/task_profiles/"]
    return ["runs/", "agent/status/", "agent/reports/", "agent/task_profiles/"]

def infer_successor_budget_contract(route_canonical, queue_mode, allowed_runner):
    budget = str((route_canonical or {}).get("current_budget_contract") or "").strip()
    if budget:
        return budget
    if queue_mode:
        return "one bounded queue job"
    if allowed_runner == "cpu":
        return "one bounded cpu follow-up"
    if allowed_runner == "gpu":
        return "one bounded gpu follow-up"
    return "one bounded report-only follow-up"

def infer_successor_runtime_minutes(route_canonical, queue_mode, allowed_runner):
    for key in ("max_runtime_minutes", "bounded_runtime_minutes", "timeout_minutes"):
        value = (route_canonical or {}).get(key)
        if isinstance(value, int) and value > 0:
            return value
    if queue_mode or allowed_runner == "gpu":
        return 45
    if allowed_runner == "cpu":
        return 20
    return 10

def infer_successor_queue_target(task_box, route_canonical):
    for source in ((route_canonical or {}), (task_box.get("queue_policy") if isinstance(task_box, dict) else {})):
        if not isinstance(source, dict):
            continue
        for key in ("queue_target", "queue_name", "default_queue_target"):
            value = str(source.get(key) or "").strip()
            if value:
                return value
    return "gpu_queue"

def infer_required_successor_exactness(route_canonical, task_box, successor_task_draft, next_action):
    step = str((route_canonical or {}).get("current_allowed_step") or "").strip().lower()
    if isinstance(successor_task_draft, dict):
        kind = str(successor_task_draft.get("kind") or "").strip().lower()
        if kind == "queue_enqueue":
            return "queue_exact"
        if kind in {"bounded_cpu_eval", "local_workspace_copy"}:
            return "profile_exact"
    if any(term in step for term in ("queue", "enqueue", "gpu")):
        return "queue_exact"
    if any(term in step for term in ("local_workspace_copy", "local-workspace-copy", "workspace_copy", "local copy", "cpu")):
        return "profile_exact"
    text = ""
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
    if any(term in text for term in ("queue", "enqueue", "gpu_queue", "gpu follow-up", "gpu followup")):
        return "queue_exact"
    if any(term in text for term in ("local workspace", "project-local", "project local", "local copy", "cpu", "smoke", "eval", "probe")):
        return "profile_exact"
    allowed = task_box.get("allowed_actions") if isinstance(task_box, dict) else []
    if isinstance(allowed, list):
        normalized = {str(item or "").strip().lower() for item in allowed}
        if "queue_enqueue" in normalized:
            return "queue_exact"
        if normalized.intersection({"bounded_cpu_eval", "local_workspace_copy"}):
            return "profile_exact"
    return "task_only"

def infer_experiment_gate_status(route_canonical, task_box):
    for source in (task_box, route_canonical):
        if not isinstance(source, dict):
            continue
        gate = source.get("experiment_decision_gate")
        if isinstance(gate, dict):
            if gate.get("blocking") is True:
                return "blocked"
            if gate.get("required") is True:
                return "required_ready"
            if gate:
                return "not_required"
        if source.get("experiment_decision_gate_blocking") is True:
            return "blocked"
        if source.get("experiment_decision_gate_required") is True:
            return "required_ready"
        status = str(source.get("experiment_gate_status") or "").strip()
        if status:
            return status
    return "not_required"

def infer_successor_materialization_status(route_canonical, task_box, successor_task_draft, task_profile_path, queue_request_draft_path, next_task_draft_path, next_action):
    gate_status = infer_experiment_gate_status(route_canonical, task_box)
    required_exactness = infer_required_successor_exactness(route_canonical, task_box, successor_task_draft, next_action)
    if gate_status == "blocked":
        return "blocked_by_experiment_gate"
    if required_exactness == "queue_exact":
        return "queue_exact" if queue_request_draft_path else ("task_only" if next_task_draft_path else "missing")
    if required_exactness == "profile_exact":
        return "profile_exact" if task_profile_path else ("task_only" if next_task_draft_path else "missing")
    return "task_only" if next_task_draft_path else "missing"

def successor_path_matches_task_id(path_text, task_id):
    path_text = str(path_text or "").strip()
    task_id = str(task_id or "").strip()
    if not path_text or not task_id:
        return False
    try:
        return Path(path_text).stem == safe_name(task_id)
    except Exception:
        return False

def first_matching_successor_path(paths, task_id):
    for item in paths:
        text = str(item or "").strip()
        if successor_path_matches_task_id(text, task_id):
            return text
    return ""

def infer_successor_materialization_status_from_resolved(required_exactness, gate_status, exact_profile_path, exact_queue_draft_path, next_task_draft_path):
    if gate_status == "blocked":
        return "blocked_by_experiment_gate"
    if required_exactness == "queue_exact":
        return "queue_exact" if exact_queue_draft_path else ("task_only" if next_task_draft_path else "missing")
    if required_exactness == "profile_exact":
        return "profile_exact" if exact_profile_path else ("task_only" if next_task_draft_path else "missing")
    return "task_only" if next_task_draft_path else "missing"

def resolve_exact_successor_contract(route_canonical, task_box, successor_task_draft, task_profile_path, queue_request_draft_path, next_task_draft_path, next_action):
    required_exactness = infer_required_successor_exactness(route_canonical, task_box, successor_task_draft, next_action)
    gate_status = infer_experiment_gate_status(route_canonical, task_box)
    exact_next_task_id = str(
        (route_canonical or {}).get("exact_next_task_id")
        or (successor_task_draft or {}).get("task_id")
        or (task_box or {}).get("exact_next_task_id")
        or ""
    ).strip()

    exact_profile_path = first_matching_successor_path([
        task_profile_path,
        (route_canonical or {}).get("exact_profile_path"),
        (task_box or {}).get("exact_profile_path"),
    ], exact_next_task_id)
    exact_queue_draft_path = first_matching_successor_path([
        queue_request_draft_path,
        (route_canonical or {}).get("exact_queue_draft_path"),
        (task_box or {}).get("exact_queue_draft_path"),
    ], exact_next_task_id)

    matching_next_task_draft_path = ""
    if isinstance(successor_task_draft, dict) and str(successor_task_draft.get("task_id") or "").strip() == exact_next_task_id:
        matching_next_task_draft_path = str(next_task_draft_path or "").strip()

    if required_exactness == "queue_exact":
        exact_next_object_path = exact_queue_draft_path or ""
    elif required_exactness == "profile_exact":
        exact_next_object_path = exact_profile_path or ""
        exact_queue_draft_path = ""
    else:
        exact_next_object_path = matching_next_task_draft_path or ""
        exact_profile_path = ""
        exact_queue_draft_path = ""

    successor_materialization_status = infer_successor_materialization_status_from_resolved(
        required_exactness,
        gate_status,
        exact_profile_path,
        exact_queue_draft_path,
        matching_next_task_draft_path,
    )

    successor_contract_required = False
    if required_exactness == "queue_exact":
        successor_contract_required = successor_materialization_status != "queue_exact"
    elif required_exactness == "profile_exact":
        successor_contract_required = successor_materialization_status != "profile_exact"
    elif not matching_next_task_draft_path and exact_next_task_id:
        successor_contract_required = True

    return {
        "exact_next_task_id": exact_next_task_id or None,
        "exact_profile_path": exact_profile_path or None,
        "exact_queue_draft_path": exact_queue_draft_path or None,
        "exact_next_object_path": exact_next_object_path or None,
        "required_successor_exactness": required_exactness,
        "successor_materialization_status": successor_materialization_status,
        "experiment_gate_status": gate_status,
        "experiment_decision_gate_required": gate_status in {"required_ready", "blocked"},
        "experiment_decision_gate_blocking": gate_status == "blocked",
        "successor_contract_required": successor_contract_required,
    }

def resolve_route_task_id(route, exact_next_task_id):
    route_task_id = str((route or {}).get("task_id") or "").strip() if isinstance(route, dict) else ""
    exact_next_task_id = str(exact_next_task_id or "").strip()
    if not route_task_id:
        return exact_next_task_id or None
    if not exact_next_task_id or route_task_id == exact_next_task_id:
        return route_task_id
    capability = str((route or {}).get("route_capability") or "").strip().lower() if isinstance(route, dict) else ""
    if capability in {"state_reconcile", "stale_marker_cleanup", "local_profile_authoring", "local_queue_draft_authoring"}:
        return route_task_id
    return exact_next_task_id or route_task_id

def synthesize_successor_task(route_canonical, task_box, next_action, queue_request_draft, task_profile_draft):
    if not isinstance(route_canonical, dict):
        return {}
    task_id = str(route_canonical.get("exact_next_task_id") or "").strip()
    if not task_id:
        route_hint = safe_name(route_canonical.get("route_id") or "successor-route")
        step_hint = safe_name(route_canonical.get("current_allowed_step") or "next")
        task_id = f"{route_hint}_{step_hint}"
    title = ""
    if isinstance(next_action, dict):
        title = str(next_action.get("description") or "").strip()
    if not title:
        title = f"Continue with exact successor route {route_canonical.get('route_id') or 'next-step'}."
    allowed_runner = infer_successor_allowed_runner(next_action, route_canonical, queue_request_draft, task_profile_draft)
    workspace_mode = infer_successor_workspace_mode(next_action, route_canonical)
    queue_mode = infer_successor_queue_mode(task_box, route_canonical, next_action, allowed_runner)
    outputs = infer_successor_output_paths(task_id, allowed_runner, workspace_mode, queue_request_draft)
    task = {
        "task_id": task_id,
        "status": "pending",
        "allowed_runner": allowed_runner,
        "title": title,
        "successor_contract_inferred": True,
        "outputs": outputs,
    }
    if workspace_mode == "project_local_copy":
        task["workspace_mode"] = workspace_mode
        task["kind"] = "local_workspace_copy"
        task["allowed_write_paths"] = infer_successor_allowed_write_paths(task_box, workspace_mode)
        task["expected_outputs"] = outputs
        task["workspace_root"] = f"workspace/{safe_name(task_id)}/"
        task["max_runtime_minutes"] = infer_successor_runtime_minutes(route_canonical, False, "cpu")
        task["budget_contract"] = infer_successor_budget_contract(route_canonical, False, "cpu")
    elif allowed_runner == "cpu":
        task["kind"] = "bounded_cpu_eval"
        task["expected_outputs"] = outputs
        task["max_runtime_minutes"] = infer_successor_runtime_minutes(route_canonical, False, allowed_runner)
        task["budget_contract"] = infer_successor_budget_contract(route_canonical, False, allowed_runner)
    if queue_mode:
        task["kind"] = "queue_enqueue"
        task["queue_target"] = infer_successor_queue_target(task_box, route_canonical)
        task["command_profile"] = safe_name(task_id)
        task["expected_outputs"] = outputs
        task["max_runtime_minutes"] = infer_successor_runtime_minutes(route_canonical, queue_mode, allowed_runner)
        task["budget_contract"] = infer_successor_budget_contract(route_canonical, queue_mode, allowed_runner)
    return task

def should_synthesize_successor_profile(task):
    if not isinstance(task, dict):
        return False
    kind = str(task.get("kind") or "").strip().lower()
    return kind in {"queue_enqueue", "bounded_cpu_eval", "local_workspace_copy"}

def synthesize_successor_profile_draft(route_canonical, task):
    if not should_synthesize_successor_profile(task):
        return {}
    task_id = str(task.get("task_id") or "").strip()
    if not task_id:
        return {}
    kind = str(task.get("kind") or "").strip().lower()
    if kind == "bounded_cpu_eval":
        return {
            "task_id": task_id,
            "profile_kind": "cpu_followup",
            "allowed_runner": "cpu",
            "route_id": str((route_canonical or {}).get("route_id") or ""),
            "route_epoch": str((route_canonical or {}).get("route_epoch") or ""),
            "budget_contract": str(task.get("budget_contract") or ""),
            "max_runtime_minutes": int(task.get("max_runtime_minutes") or 20),
            "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else [],
        }
    if kind == "local_workspace_copy":
        return {
            "task_id": task_id,
            "profile_kind": "local_workspace_copy",
            "allowed_runner": str(task.get("allowed_runner") or "").strip().lower() or "cpu",
            "workspace_mode": "project_local_copy",
            "workspace_root": str(task.get("workspace_root") or f"workspace/{safe_name(task_id)}/"),
            "allowed_write_paths": task.get("allowed_write_paths") if isinstance(task.get("allowed_write_paths"), list) else [],
            "route_id": str((route_canonical or {}).get("route_id") or ""),
            "route_epoch": str((route_canonical or {}).get("route_epoch") or ""),
            "budget_contract": str(task.get("budget_contract") or ""),
            "max_runtime_minutes": int(task.get("max_runtime_minutes") or 20),
            "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else [],
        }
    return {
        "task_id": task_id,
        "profile_kind": "gpu_queue_followup",
        "allowed_runner": str(task.get("allowed_runner") or "").strip().lower() or "gpu",
        "command_profile": str(task.get("command_profile") or safe_name(task_id)),
        "route_id": str((route_canonical or {}).get("route_id") or ""),
        "route_epoch": str((route_canonical or {}).get("route_epoch") or ""),
        "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else [],
    }

def should_synthesize_successor_queue_request(task):
    return isinstance(task, dict) and str(task.get("kind") or "").strip().lower() == "queue_enqueue"

def synthesize_successor_queue_request(route_canonical, task_box, task):
    if not should_synthesize_successor_queue_request(task):
        return {}
    task_id = str(task.get("task_id") or "").strip()
    if not task_id:
        return {}
    return {
        "task_id": task_id,
        "runner": str(task.get("allowed_runner") or "").strip().lower() or "gpu",
        "queue_target": str(task.get("queue_target") or infer_successor_queue_target(task_box, route_canonical)),
        "command_profile": str(task.get("command_profile") or safe_name(task_id)),
        "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else infer_successor_output_paths(task_id, str(task.get("allowed_runner") or "").strip().lower() or "gpu", str(task.get("workspace_mode") or "readonly"), {}),
        "max_runtime_minutes": int(task.get("max_runtime_minutes") or infer_successor_runtime_minutes(route_canonical, True, str(task.get("allowed_runner") or "").strip().lower() or "gpu")),
        "budget_contract": str(task.get("budget_contract") or infer_successor_budget_contract(route_canonical, True, str(task.get("allowed_runner") or "").strip().lower() or "gpu")),
    }

def rehydrate_successor_task_from_exact_contract(route_canonical, task_box, next_action, task_profile_draft, queue_request_draft):
    if not isinstance(route_canonical, dict):
        return {}
    exact_next_task_id = str(route_canonical.get("exact_next_task_id") or "").strip()
    if not exact_next_task_id:
        return {}
    required_exactness = str(route_canonical.get("required_successor_exactness") or "").strip().lower()
    if required_exactness == "missing":
        return {}

    def load_exact_object(rel_path):
        rel_path = str(rel_path or "").strip()
        if not rel_path:
            return {}
        target = Path(rel_path)
        if not target.exists() or not target.is_file():
            return {}
        try:
            payload = json.loads(target.read_text())
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    loaded_profile = {}
    if isinstance(task_profile_draft, dict) and str(task_profile_draft.get("task_id") or "").strip() == exact_next_task_id:
        loaded_profile = dict(task_profile_draft)
    else:
        loaded_profile = load_exact_object(route_canonical.get("exact_profile_path"))

    loaded_queue = {}
    if isinstance(queue_request_draft, dict) and str(queue_request_draft.get("task_id") or "").strip() == exact_next_task_id:
        loaded_queue = dict(queue_request_draft)
    else:
        loaded_queue = load_exact_object(route_canonical.get("exact_queue_draft_path"))

    if required_exactness == "queue_exact" and not loaded_queue:
        return {}
    if required_exactness == "profile_exact" and not loaded_profile:
        return {}

    task = synthesize_successor_task(route_canonical, task_box, next_action, loaded_queue, loaded_profile)
    if not isinstance(task, dict) or not str(task.get("task_id") or "").strip():
        return {}
    task["task_id"] = exact_next_task_id
    task["exact_contract_rehydrated"] = True
    return task

def derive_runtime_state_json(route_canonical, task_box, successor_task_draft, next_action, route_task_id, existing_state, exact_next_object_path, task_profile_path, queue_request_draft_path, updated, requires_review):
    state = dict(existing_state) if isinstance(existing_state, dict) else {}
    tasks = []
    current_exact_task_id = str((route_canonical or {}).get("exact_next_task_id") or (successor_task_draft or {}).get("task_id") or "").strip()
    previous_exact_task_id = str(state.get("exact_next_task_id") or "").strip() if isinstance(state, dict) else ""
    for raw in task_box.get("tasks", []) if isinstance(task_box, dict) else []:
        if isinstance(raw, dict) and str(raw.get("task_id") or "").strip():
            tasks.append(dict(raw))
    if not tasks and isinstance(successor_task_draft, dict) and str(successor_task_draft.get("task_id") or "").strip():
        tasks.append(dict(successor_task_draft))
    if not tasks:
        fallback_tasks = existing_state.get("tasks") if isinstance(existing_state, dict) else []
        if isinstance(fallback_tasks, list):
            tasks = [
                dict(raw) for raw in fallback_tasks
                if isinstance(raw, dict)
                and str(raw.get("task_id") or "").strip()
                and not (
                    current_exact_task_id
                    and previous_exact_task_id
                    and current_exact_task_id != previous_exact_task_id
                    and str(raw.get("task_id") or "").strip() == previous_exact_task_id
                )
            ]

    blocked_actions = task_box.get("blocked_actions") if isinstance(task_box, dict) and isinstance(task_box.get("blocked_actions"), list) else state.get("blocked_actions", [])
    if not isinstance(blocked_actions, list):
        blocked_actions = []

    important_paths = []
    for candidate in (
        *(task.get("expected_outputs", []) for task in tasks if isinstance(task.get("expected_outputs"), list)),
        *(task.get("outputs", []) for task in tasks if isinstance(task.get("outputs"), list)),
        [exact_next_object_path] if exact_next_object_path else [],
        [task_profile_path] if task_profile_path else [],
        [queue_request_draft_path] if queue_request_draft_path else [],
        state.get("important_paths", []) if isinstance(state.get("important_paths"), list) else [],
    ):
        for item in candidate:
            text = str(item or "").strip()
            if text and text not in important_paths:
                important_paths.append(text)

    mode = str(state.get("mode") or "observer")
    if any(str(task.get("workspace_mode") or "").strip().lower() == "project_local_copy" for task in tasks):
        mode = "project-local-worker"
    elif any(str(task.get("kind") or "").strip().lower() == "queue_enqueue" or str(task.get("allowed_runner") or "").strip().lower() == "gpu" for task in tasks):
        mode = "gpu-queue-worker"
    elif any(str(task.get("allowed_runner") or "").strip().lower() == "cpu" for task in tasks):
        mode = "project-local-worker"
    elif not tasks:
        mode = "observer"

    required_successor_exactness = str((route_canonical or {}).get("required_successor_exactness") or (task_box or {}).get("required_successor_exactness") or "")
    successor_materialization_status = str((route_canonical or {}).get("successor_materialization_status") or (task_box or {}).get("successor_materialization_status") or "")
    experiment_gate_status = str((route_canonical or {}).get("experiment_gate_status") or (task_box or {}).get("experiment_gate_status") or "not_required")

    state.update({
        "schema_version": 1,
        "updated_utc": updated,
        "mode": mode,
        "requires_review": bool((route_canonical or {}).get("requires_review", False) or (task_box or {}).get("requires_review", False) or requires_review),
        "route_id": (route_canonical or {}).get("route_id") or (task_box or {}).get("route_id") or state.get("route_id"),
        "route_epoch": (route_canonical or {}).get("route_epoch") or (task_box or {}).get("route_epoch") or state.get("route_epoch"),
        "active_task_id": (route_canonical or {}).get("exact_next_task_id") or (successor_task_draft or {}).get("task_id") or state.get("active_task_id"),
        "route_task_id": str(route_task_id or "").strip() or state.get("route_task_id"),
        "tasks": tasks,
        "allowed_next_action": str((next_action or {}).get("kind") or state.get("allowed_next_action") or "report_only"),
        "blocked_actions": blocked_actions,
        "important_paths": important_paths,
        "exact_next_task_id": (route_canonical or {}).get("exact_next_task_id") or (successor_task_draft or {}).get("task_id"),
        "exact_profile_path": (route_canonical or {}).get("exact_profile_path"),
        "exact_queue_draft_path": (route_canonical or {}).get("exact_queue_draft_path"),
        "exact_next_object_path": exact_next_object_path or None,
        "successor_contract_required": bool((route_canonical or {}).get("successor_contract_required") or (task_box or {}).get("successor_contract_required")),
        "required_successor_exactness": required_successor_exactness,
        "successor_materialization_status": successor_materialization_status,
        "experiment_gate_status": experiment_gate_status,
        "experiment_decision_gate_required": bool((route_canonical or {}).get("experiment_decision_gate_required") or (task_box or {}).get("experiment_decision_gate_required")),
        "experiment_decision_gate_blocking": bool((route_canonical or {}).get("experiment_decision_gate_blocking") or (task_box or {}).get("experiment_decision_gate_blocking")),
        "task_box_id": (task_box or {}).get("task_box_id") or state.get("task_box_id"),
        "owner_mode": (route_canonical or {}).get("owner_mode") or state.get("owner_mode"),
        "current_allowed_step": (route_canonical or {}).get("current_allowed_step") or state.get("current_allowed_step"),
        "project_question": (task_box or {}).get("project_question") or state.get("project_question"),
        "decision_relevance": (task_box or {}).get("decision_relevance") or state.get("decision_relevance"),
        "claim_scope": (task_box or {}).get("claim_scope") or state.get("claim_scope"),
        "diagnosis_target": (task_box or {}).get("diagnosis_target") or state.get("diagnosis_target"),
        "derived_from_route_canonical": True,
    })
    return state

def write_task_profile_draft(draft, fallback_task_id):
    if not isinstance(draft, dict) or not draft:
        return ""
    task_id = str(draft.get("task_id") or fallback_task_id or "").strip()
    if not task_id:
        return ""
    payload = dict(draft)
    payload["task_id"] = task_id
    target = Path("agent/task_profiles") / f"{safe_name(task_id)}.json"
    atomic_write_json(target, payload)
    return str(target)

def write_queue_request_draft(draft, fallback_task_id):
    if not isinstance(draft, dict) or not draft:
        return ""
    task_id = str(draft.get("task_id") or fallback_task_id or "").strip()
    if not task_id:
        return ""
    payload = dict(draft)
    payload["task_id"] = task_id
    payload.setdefault("status", "draft")
    target = Path("agent/queue/drafts") / f"{safe_name(task_id)}.json"
    atomic_write_json(target, payload)
    return str(target)

print(data["report_markdown"])

updated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

successor_task_draft = normalize_successor_task(data.get("successor_task_draft"))
task_profile_draft = clean_object(data.get("task_profile_draft"))
queue_request_draft = clean_object(data.get("queue_request_draft"))
route_canonical_update = clean_object(data.get("route_canonical_update"))
task_box_update = clean_object(data.get("task_box_update"))
previous_exact_task_id = str(
    (route_canonical or {}).get("exact_next_task_id")
    or (task_box or {}).get("exact_next_task_id")
    or ""
).strip()

route_canonical_changed = False
task_box_changed = False

if route_canonical_update:
    route_canonical = merge_route_canonical(route_canonical, route_canonical_update, updated)
    route_canonical_changed = True
    if task_box:
        task_box = ensure_task_box(task_box, route_canonical)
        task_box["updated_utc"] = updated
        task_box_changed = True

if task_box_update:
    task_box = merge_task_box(task_box, task_box_update)
    task_box["updated_utc"] = updated
    task_box_changed = True

next_action = data.get("next_safe_action") or {}
initial_experiment_gate_status = infer_experiment_gate_status(route_canonical, task_box)

if not successor_task_draft and route_canonical.get("successor_contract_required") is True and initial_experiment_gate_status != "blocked":
    successor_task_draft = synthesize_successor_task(route_canonical, task_box, next_action, queue_request_draft, task_profile_draft)

if not successor_task_draft and initial_experiment_gate_status != "blocked":
    successor_task_draft = rehydrate_successor_task_from_exact_contract(
        route_canonical,
        task_box,
        next_action,
        task_profile_draft,
        queue_request_draft,
    )

if not task_profile_draft and should_synthesize_successor_profile(successor_task_draft) and initial_experiment_gate_status != "blocked":
    task_profile_draft = synthesize_successor_profile_draft(route_canonical, successor_task_draft)

if not queue_request_draft and should_synthesize_successor_queue_request(successor_task_draft) and initial_experiment_gate_status != "blocked":
    queue_request_draft = synthesize_successor_queue_request(route_canonical, task_box, successor_task_draft)

next_task_draft_path = ""
if successor_task_draft:
    next_task_draft_path = "agent/status/NEXT_TASK_DRAFT.json"
    atomic_write_json(next_task_draft_path, successor_task_draft)
    task_box = ensure_task_box(task_box, route_canonical)
    task_box = upsert_task_box_task(task_box, successor_task_draft)
    task_box["updated_utc"] = updated
    task_box_changed = True
    route_canonical = merge_route_canonical(route_canonical, {
        "exact_next_task_id": successor_task_draft.get("task_id"),
    }, updated)
    route_canonical_changed = True

task_profile_path = write_task_profile_draft(task_profile_draft, successor_task_draft.get("task_id") if successor_task_draft else "")
if task_profile_path:
    route_canonical = merge_route_canonical(route_canonical, {
        "exact_profile_path": task_profile_path,
    }, updated)
    route_canonical_changed = True

queue_request_draft_path = write_queue_request_draft(queue_request_draft, successor_task_draft.get("task_id") if successor_task_draft else "")
if queue_request_draft_path:
    route_canonical = merge_route_canonical(route_canonical, {
        "exact_queue_draft_path": queue_request_draft_path,
    }, updated)
    route_canonical_changed = True

resolved_exact_contract = resolve_exact_successor_contract(
    route_canonical,
    task_box,
    successor_task_draft,
    task_profile_path,
    queue_request_draft_path,
    next_task_draft_path,
    next_action,
)
required_successor_exactness = resolved_exact_contract["required_successor_exactness"]
experiment_gate_status = resolved_exact_contract["experiment_gate_status"]
successor_materialization_status = resolved_exact_contract["successor_materialization_status"]
exact_next_task_id = str(resolved_exact_contract.get("exact_next_task_id") or "").strip()
exact_profile_path = resolved_exact_contract.get("exact_profile_path")
exact_queue_draft_path = resolved_exact_contract.get("exact_queue_draft_path")
exact_next_object_path = resolved_exact_contract.get("exact_next_object_path")
resolved_route_task_id = resolve_route_task_id(route, exact_next_task_id)

task_box = prune_previous_exact_task_from_task_box(task_box, previous_exact_task_id, exact_next_task_id)

if not successor_task_draft:
    try:
        existing_next_task_draft = json.loads(Path("agent/status/NEXT_TASK_DRAFT.json").read_text())
    except Exception:
        existing_next_task_draft = {}
    existing_task_id = str(existing_next_task_draft.get("task_id") or "").strip() if isinstance(existing_next_task_draft, dict) else ""
    if existing_task_id and existing_task_id != exact_next_task_id:
        atomic_write_json("agent/status/NEXT_TASK_DRAFT.json", {})
        next_task_draft_path = ""

route_canonical = merge_route_canonical(route_canonical, {
    "active_task_id": resolved_exact_contract.get("exact_next_task_id"),
    "exact_next_task_id": resolved_exact_contract.get("exact_next_task_id"),
    "exact_profile_path": resolved_exact_contract.get("exact_profile_path"),
    "exact_queue_draft_path": resolved_exact_contract.get("exact_queue_draft_path"),
    "exact_next_object_path": resolved_exact_contract.get("exact_next_object_path"),
    "required_successor_exactness": resolved_exact_contract.get("required_successor_exactness"),
    "successor_materialization_status": resolved_exact_contract.get("successor_materialization_status"),
    "experiment_gate_status": resolved_exact_contract.get("experiment_gate_status"),
    "experiment_decision_gate_required": resolved_exact_contract.get("experiment_decision_gate_required"),
    "experiment_decision_gate_blocking": resolved_exact_contract.get("experiment_decision_gate_blocking"),
    "successor_contract_required": resolved_exact_contract.get("successor_contract_required"),
}, updated)
route_canonical_changed = True
task_box = ensure_task_box(task_box, route_canonical)
task_box["owner_mode"] = route_canonical.get("owner_mode") or task_box.get("owner_mode")
task_box["current_allowed_step"] = route_canonical.get("current_allowed_step") or task_box.get("current_allowed_step")
task_box["successor_contract_required"] = bool(resolved_exact_contract.get("successor_contract_required"))
task_box["active_task_id"] = resolved_exact_contract.get("exact_next_task_id")
task_box["route_task_id"] = resolved_route_task_id
task_box["exact_next_task_id"] = resolved_exact_contract.get("exact_next_task_id")
task_box["exact_profile_path"] = resolved_exact_contract.get("exact_profile_path")
task_box["exact_queue_draft_path"] = resolved_exact_contract.get("exact_queue_draft_path")
task_box["exact_next_object_path"] = resolved_exact_contract.get("exact_next_object_path")
task_box["required_successor_exactness"] = resolved_exact_contract.get("required_successor_exactness")
task_box["successor_materialization_status"] = resolved_exact_contract.get("successor_materialization_status")
task_box["experiment_gate_status"] = resolved_exact_contract.get("experiment_gate_status")
task_box["experiment_decision_gate_required"] = resolved_exact_contract.get("experiment_decision_gate_required")
task_box["experiment_decision_gate_blocking"] = resolved_exact_contract.get("experiment_decision_gate_blocking")
task_box["updated_utc"] = updated
task_box_changed = True

if route_canonical_changed and route_canonical:
    atomic_write_json(route_canonical_path, route_canonical)
if task_box_changed and task_box:
    atomic_write_json(task_box_path, task_box)

try:
    existing_state = json.loads(Path("agent/STATE.json").read_text())
except Exception:
    existing_state = {}
runtime_state_json = derive_runtime_state_json(
    route_canonical,
    task_box,
    successor_task_draft,
    next_action,
    resolved_route_task_id,
    existing_state if isinstance(existing_state, dict) else {},
    exact_next_object_path,
    task_profile_path,
    queue_request_draft_path,
    updated,
    bool(data.get("requires_human_review")),
)
atomic_write_json("agent/STATE.json", runtime_state_json)

state_update = data.get("state_update_markdown", "").strip()
if state_update:
    atomic_write_text("agent/STATE.proposed.md", state_update + "\\n")

runtime_update = data.get("runtime_state_markdown", "").strip()
if runtime_update:
    atomic_write_text("agent/RUNTIME_STATE.md", runtime_update + "\\n")

morning_brief = data.get("morning_brief_markdown", "").strip()
if morning_brief:
    atomic_write_text("agent/MORNING_BRIEF.md", morning_brief + "\\n")

progress_state = {
    "updated_utc": updated,
    "last_model_timestamp_utc": data.get("timestamp_utc"),
    "progress_changed": bool(data.get("progress_changed")),
    "no_progress_cycles": int(data.get("no_progress_cycles") or 0),
    "last_report_type": data.get("report_type", "heartbeat"),
    "primary_skill": data.get("primary_skill"),
    "expected_primary_skill": route.get("primary_skill"),
    "secondary_skills_expected": expected_secondary_skills,
    "secondary_skills_consulted": actual_secondary_skills,
    "route_capability": route.get("route_capability"),
    "skill_route_reason": route.get("reason"),
    "route_id": route_canonical.get("route_id") or task_box.get("route_id"),
    "route_epoch": route_canonical.get("route_epoch") or task_box.get("route_epoch"),
    "task_box_id": task_box.get("task_box_id"),
    "owner_mode": route_canonical.get("owner_mode") or task_box.get("owner_mode"),
    "current_allowed_step": route_canonical.get("current_allowed_step") or task_box.get("current_allowed_step"),
    "recommend_pause": bool(data.get("recommend_pause")),
    "requires_human_review": bool(data.get("requires_human_review")),
    "current_blocker": data.get("human_review_reason") or "; ".join(data.get("blocked_items") or [])[:1000],
    "next_safe_action": next_action,
    "active_task_id": exact_next_task_id or None,
    "route_task_id": resolved_route_task_id,
    "exact_next_task_id": exact_next_task_id,
    "exact_profile_path": exact_profile_path or None,
    "exact_queue_draft_path": exact_queue_draft_path or None,
    "exact_next_object_path": exact_next_object_path,
    "successor_contract_required": bool(resolved_exact_contract.get("successor_contract_required")),
    "required_successor_exactness": required_successor_exactness,
    "successor_materialization_status": successor_materialization_status,
    "experiment_gate_status": experiment_gate_status,
    "experiment_decision_gate_required": experiment_gate_status in {"required_ready", "blocked"},
    "experiment_decision_gate_blocking": experiment_gate_status == "blocked",
    "project_question": task_box.get("project_question"),
    "decision_relevance": task_box.get("decision_relevance"),
    "claim_scope": task_box.get("claim_scope"),
    "diagnosis_target": task_box.get("diagnosis_target"),
}
atomic_write_json("agent/PROGRESS_STATE.json", progress_state)

def blocker_type(blocked_items, requires_review, human_reason):
    text = " ".join(str(x) for x in (blocked_items or [])) + " " + str(human_reason or "")
    lowered = text.lower()
    if not lowered.strip():
        return "none"
    if any(k in lowered for k in ("cuda", "nvml", "conda", "systemd", "gpu", "environment", "env")):
        return "env"
    if "queue" in lowered or "runner" in lowered:
        return "queue"
    if any(k in lowered for k in ("approval", "permission", "allowlist", "sandbox", "policy")):
        return "permission"
    if any(k in lowered for k in ("reviewer", "bluecode", "claude", "external")):
        return "reviewer"
    if any(k in lowered for k in ("model", "loss", "gate", "architecture", "training")):
        return "model"
    if "data" in lowered or "dataset" in lowered:
        return "data"
    if "stale" in lowered or "snowball" in lowered:
        return "stale_state"
    if requires_review:
        return "permission"
    return "stale_state"

def write_lines(path, lines):
    atomic_write_text(path, "\\n".join(lines).rstrip() + "\\n")
blocked_items = data.get("blocked_items") or []
completed_items = data.get("completed_items") or []
running_items = data.get("running_items") or []
evidence = data.get("evidence") or []
human_reason = data.get("human_review_reason") or ""
requires_review = bool(data.get("requires_human_review"))
blocker = blocker_type(blocked_items, requires_review, human_reason)
successor_contract_required_text = str(bool(resolved_exact_contract.get("successor_contract_required"))).lower()
experiment_gate_required_text = str(experiment_gate_status in {"required_ready", "blocked"}).lower()
experiment_gate_blocking_text = str(experiment_gate_status == "blocked").lower()

Path("agent").mkdir(parents=True, exist_ok=True)
write_lines("agent/CURRENT_STATE.md", [
    "# Current State",
    "",
    f"Updated: {updated}",
    f"Role: {os.environ.get('WATCHDOG_ROLE', 'runner')}",
    f"Supervisor mode: {os.environ.get('WATCHDOG_SUPERVISOR_MODE', 'runner')}",
    f"Status: {data.get('overall_status', 'uncertain')}",
    f"Report type: {data.get('report_type', 'heartbeat')}",
    f"Primary skill: {data.get('primary_skill', '')}",
    f"Secondary skills: {', '.join(actual_secondary_skills) if actual_secondary_skills else 'none'}",
    f"Route ID: {route_canonical.get('route_id') or task_box.get('route_id') or 'unknown'}",
    f"Route epoch: {route_canonical.get('route_epoch') or task_box.get('route_epoch') or 'unknown'}",
    f"Owner mode: {route_canonical.get('owner_mode') or task_box.get('owner_mode') or 'unknown'}",
    f"Current allowed step: {route_canonical.get('current_allowed_step') or task_box.get('current_allowed_step') or 'unknown'}",
    f"Task box: {task_box.get('task_box_id') or 'none'}",
    f"Canonical active task: {exact_next_task_id or 'none'}",
    f"Route-selected task: {resolved_route_task_id or 'none'}",
    f"Exact next task: {exact_next_task_id or 'none'}",
    f"Exact profile path: {exact_profile_path or 'none'}",
    f"Exact queue draft path: {exact_queue_draft_path or 'none'}",
    f"Exact next object: {exact_next_object_path or 'none'}",
    f"Successor contract required: {successor_contract_required_text}",
    f"Required successor exactness: {required_successor_exactness or 'task_only'}",
    f"Successor materialization: {successor_materialization_status or 'missing'}",
    f"Experiment gate status: {experiment_gate_status or 'not_required'}",
    f"Experiment gate required: {experiment_gate_required_text}",
    f"Experiment gate blocking: {experiment_gate_blocking_text}",
    f"Project question: {task_box.get('project_question') or 'none'}",
    f"Decision relevance: {task_box.get('decision_relevance') or 'none'}",
    f"Claim scope: {task_box.get('claim_scope') or 'none'}",
    f"Diagnosis target: {task_box.get('diagnosis_target') or 'none'}",
    "",
    "## Current Facts",
    "",
    data.get("work_cycle_summary", "").strip() or "- No summary provided.",
    "",
    "## Completed Items",
    "",
    *(f"- {item}" for item in completed_items),
    *(["- None."] if not completed_items else []),
    "",
    "## Running Items",
    "",
    *(f"- {item}" for item in running_items),
    *(["- None."] if not running_items else []),
    "",
    "## Latest Evidence",
    "",
    *(f"- {item}" for item in evidence),
    *(["- None."] if not evidence else []),
])

runner_started_count = os.environ.get("WATCHDOG_RUNNER_STARTED_COUNT")
runner_completed_count = os.environ.get("WATCHDOG_RUNNER_COMPLETED_COUNT") or os.environ.get("WATCHDOG_RUNNER_RUN_COUNT")
runner_failure_drift = os.environ.get("WATCHDOG_RUNNER_FAILURE_DRIFT")

atomic_write_json("agent/RUN_STATE.json", {
    "schema_version": 1,
    "updated_utc": updated,
    "role": os.environ.get("WATCHDOG_ROLE", "runner"),
    "supervisor_mode": os.environ.get("WATCHDOG_SUPERVISOR_MODE", "runner"),
    "runner_run_count": os.environ.get("WATCHDOG_RUNNER_RUN_COUNT"),
    "runner_completed_count": runner_completed_count,
    "runner_started_count": runner_started_count,
    "runner_failure_drift": runner_failure_drift,
    "supervisor_audit_every_runner_runs": os.environ.get("WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS"),
    "status": data.get("overall_status", "uncertain"),
    "primary_skill": data.get("primary_skill"),
    "secondary_skills_expected": expected_secondary_skills,
    "secondary_skills_consulted": actual_secondary_skills,
    "route_capability": route.get("route_capability"),
    "report_type": data.get("report_type"),
    "progress_changed": bool(data.get("progress_changed")),
    "active_task_id": exact_next_task_id or None,
    "route_task_id": resolved_route_task_id,
    "route_id": route_canonical.get("route_id") or task_box.get("route_id"),
    "route_epoch": route_canonical.get("route_epoch") or task_box.get("route_epoch"),
    "task_box_id": task_box.get("task_box_id"),
    "owner_mode": route_canonical.get("owner_mode") or task_box.get("owner_mode"),
    "current_allowed_step": route_canonical.get("current_allowed_step") or task_box.get("current_allowed_step"),
    "blocker_type": blocker,
    "requires_human_review": requires_review,
    "next_action": next_action,
    "exact_next_task_id": exact_next_task_id or None,
    "exact_profile_path": exact_profile_path or None,
    "exact_queue_draft_path": exact_queue_draft_path or None,
    "exact_next_object_path": exact_next_object_path,
    "successor_contract_required": bool(resolved_exact_contract.get("successor_contract_required")),
    "required_successor_exactness": required_successor_exactness,
    "successor_materialization_status": successor_materialization_status,
    "experiment_gate_status": experiment_gate_status,
    "experiment_decision_gate_required": experiment_gate_status in {"required_ready", "blocked"},
    "experiment_decision_gate_blocking": experiment_gate_status == "blocked",
    "project_question": task_box.get("project_question"),
    "decision_relevance": task_box.get("decision_relevance"),
    "claim_scope": task_box.get("claim_scope"),
    "diagnosis_target": task_box.get("diagnosis_target"),
    "evidence": evidence,
})

if os.environ.get("WATCHDOG_ROLE", "runner") == "runner":
    runner_count = os.environ.get("WATCHDOG_RUNNER_RUN_COUNT")
    if runner_count:
        status_dir = Path("agent/status")
        status_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_text(status_dir / "runner_completed_count", str(runner_count) + "\\n")
        atomic_write_json(status_dir / "RUNNER_COMPLETION.json", {
            "schema_version": 1,
            "updated_utc": updated,
            "runner_run_count": runner_count,
            "runner_completed_count": runner_count,
            "status": data.get("overall_status", "uncertain"),
            "report_type": data.get("report_type"),
        })

write_lines("agent/NEXT_ACTION.md", [
    "# Next Action",
    "",
    f"Updated: {updated}",
    "",
    "## One Next Safe Action",
    "",
    f"- Kind: {next_action.get('kind', 'none')}",
    f"- Description: {next_action.get('description', '') or 'None.'}",
    f"- Automatic: {next_action.get('can_execute_automatically', False)}",
    f"- Reason: {next_action.get('reason', '') or 'No reason provided.'}",
    f"- Canonical active task: {exact_next_task_id or 'none'}",
    f"- Route-selected task: {resolved_route_task_id or 'none'}",
    f"- Exact next task: {exact_next_task_id or 'none'}",
    f"- Exact profile path: {exact_profile_path or 'none'}",
    f"- Exact queue draft path: {exact_queue_draft_path or 'none'}",
    f"- Exact object path: {exact_next_object_path or 'none'}",
    f"- Successor contract required: {successor_contract_required_text}",
    f"- Required successor exactness: {required_successor_exactness or 'task_only'}",
    f"- Successor materialization status: {successor_materialization_status or 'missing'}",
    f"- Experiment gate status: {experiment_gate_status or 'not_required'}",
    f"- Experiment gate required: {experiment_gate_required_text}",
    f"- Experiment gate blocking: {experiment_gate_blocking_text}",
    f"- Decision relevance: {task_box.get('decision_relevance') or 'none'}",
    f"- Claim scope: {task_box.get('claim_scope') or 'none'}",
    "",
    "## Stop Condition",
    "",
    f"- {data.get('skill_stop_condition', 'Stop after one bounded action.')}",
])

write_lines("agent/BLOCKERS.md", [
    "# Blockers",
    "",
    f"Updated: {updated}",
    f"Blocker type: {blocker}",
    "",
    "## Active Blockers",
    "",
    *(f"- {item}" for item in blocked_items),
    *(["- none: no active blocker reported."] if not blocked_items else []),
    "",
    "## Human Review",
    "",
    f"- Required: {requires_review}",
    f"- Reason: {human_reason or 'None.'}",
])

proposal = data.get("proposal_markdown", "").strip()
review_state = "pending_send" if proposal else "none"
if requires_review and not proposal:
    review_state = "review_required_no_bundle"
next_kind = str(next_action.get("kind", "none") or "none").strip()
review_scope = str(data.get("review_scope", "") or "").strip()
if review_scope not in {"none", "report_only", "bookkeeping", "external_review", "unsafe_operation"}:
    if proposal:
        review_scope = "external_review"
    elif requires_review and next_kind in {"report_only", "none"}:
        review_scope = "report_only"
    elif requires_review:
        review_scope = "unsafe_operation"
    else:
        review_scope = "none"
review_resolver = str(data.get("review_resolver", "") or "").strip()
if review_resolver not in {"none", "supervisor", "human", "external"}:
    if review_scope in {"report_only", "bookkeeping"}:
        review_resolver = "supervisor"
    elif review_scope == "external_review":
        review_resolver = "external"
    elif requires_review or proposal:
        review_resolver = "human"
    else:
        review_resolver = "none"
write_lines("agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    f"Updated: {updated}",
    "",
    "## Reviewer Bundle State",
    "",
    f"- state: {review_state}",
    f"- requires_human_review: {requires_review}",
    f"- scope: {review_scope}",
    f"- resolver: {review_resolver}",
    f"- human_review_reason: {human_reason or 'None.'}",
    "",
    "## Notes",
    "",
    "- If external reviewer sending is blocked by policy, write the exact bundle path and policy reason here instead of repeating it in every report.",
])

ledger_update = data.get("ledger_update_markdown", "").strip()
if ledger_update:
    Path("research").mkdir(parents=True, exist_ok=True)
    if ledger_update.startswith("# Research Ledger"):
        Path("research/RESEARCH_LEDGER.md").write_text(ledger_update + "\\n")
    else:
        with Path("research/LEDGER_NOTES.md").open("a") as fh:
            fh.write("\\n\\n## Proposed Ledger Fragment\\n\\n")
            fh.write(ledger_update + "\\n")

append_jsonl("agent/EVIDENCE_LEDGER.jsonl", {
    "timestamp_utc": updated,
    "task_id": route.get("task_id"),
    "artifact_type": data.get("report_type", "heartbeat"),
    "status": data.get("overall_status", "uncertain"),
    "primary_skill": data.get("primary_skill"),
    "secondary_skills_consulted": actual_secondary_skills,
    "route_capability": route.get("route_capability"),
    "route_id": route_canonical.get("route_id") or task_box.get("route_id"),
    "route_epoch": route_canonical.get("route_epoch") or task_box.get("route_epoch"),
    "successor_contract_generated": bool(next_task_draft_path or task_profile_path or queue_request_draft_path),
    "exact_next_task_id": exact_next_task_id or None,
    "exact_profile_path": exact_profile_path or None,
    "exact_queue_draft_path": exact_queue_draft_path or None,
    "exact_next_object_path": exact_next_object_path,
    "required_successor_exactness": required_successor_exactness,
    "successor_materialization_status": successor_materialization_status,
    "experiment_gate_status": experiment_gate_status,
    "experiment_decision_gate_required": experiment_gate_status in {"required_ready", "blocked"},
    "experiment_decision_gate_blocking": experiment_gate_status == "blocked",
    "task_box_id": task_box.get("task_box_id"),
    "input_paths": [],
    "output_paths": [
        "agent/reports/latest.md",
        "agent/STATE.json",
        "agent/CURRENT_STATE.md",
        "agent/RUN_STATE.json",
        "agent/PROGRESS_STATE.json",
        "agent/NEXT_ACTION.md",
        "agent/ROUTE_CANONICAL.json",
        *( [next_task_draft_path] if next_task_draft_path else [] ),
        *( [task_profile_path] if task_profile_path else [] ),
        *( [queue_request_draft_path] if queue_request_draft_path else [] ),
    ],
    "metrics": {},
    "caveats": data.get("blocked_items") or [],
    "next_safe_action": next_action.get("description", ""),
    "requires_review": requires_review,
    "project_question": task_box.get("project_question"),
    "decision_relevance": task_box.get("decision_relevance"),
    "claim_scope": task_box.get("claim_scope"),
    "diagnosis_target": task_box.get("diagnosis_target"),
    "fair_comparability": task_box.get("fair_comparability"),
    "value_of_information": task_box.get("value_of_information"),
})

proposal = data.get("proposal_markdown", "").strip()
if proposal:
    proposal_dir = Path("research/proposals")
    proposal_dir.mkdir(parents=True, exist_ok=True)
    proposal_name = safe_name(data.get("timestamp_utc", "unknown"))
    Path(proposal_dir / f"{proposal_name}.md").write_text(proposal + "\\n")

if data.get("requires_human_review"):
    pending_dir = Path("agent/pending/review_required")
    pending_dir.mkdir(parents=True, exist_ok=True)
    safe_ts = safe_name(data.get("timestamp_utc", "unknown"))
    Path(pending_dir / f"{safe_ts}.json").write_text(json.dumps(data, indent=2))

def finalize_supervisor_decision():
    if os.environ.get("WATCHDOG_ROLE", "runner") != "supervisor":
        return

    state_path = Path("agent/status/supervisor_state.json")
    try:
        state = json.loads(state_path.read_text())
    except Exception:
        state = {
            "schema_version": 2,
            "role": "supervisor",
            "mode": os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby"),
        }

    decision = dict(state.get("decision") or {})
    mode = decision.get("mode") or state.get("mode") or os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")
    target_count = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
    try:
        target_count = int(decision.get("target_runner_completed_count", target_count))
    except Exception:
        pass

    codex_status = os.environ.get("WATCHDOG_CODEX_STATUS", "0")
    success = codex_status == "0"
    decision["mode"] = mode
    decision["target_runner_completed_count"] = target_count

    event = {
        "decision_id": decision.get("decision_id", ""),
        "timestamp": updated,
        "mode": mode,
        "runner_completed_count": target_count,
    }

    if success:
        decision["status"] = "completed"
        decision["completed_at"] = updated
        state["last_seen_runner_completed_count"] = max(int(state.get("last_seen_runner_completed_count") or state.get("last_seen_runner_run_count") or 0), target_count)
        state["last_seen_runner_run_count"] = state["last_seen_runner_completed_count"]
        if mode == "light":
            state["last_light_runner_completed_count"] = max(int(state.get("last_light_runner_completed_count") or 0), target_count)
        if mode == "audit":
            state["last_audit_runner_completed_count"] = max(int(state.get("last_audit_runner_completed_count") or state.get("last_audit_runner_run_count") or 0), target_count)
            state["last_audit_runner_run_count"] = state["last_audit_runner_completed_count"]
        if mode in {"light", "audit"} and state.get("marker_pending") and state.get("marker_fingerprint"):
            state["last_actioned_marker_fingerprint"] = state.get("marker_fingerprint", "")
            state["last_marker_fingerprint"] = state.get("marker_fingerprint", "")
        event["event"] = "completed"
    else:
        decision["status"] = "failed"
        decision["failed_at"] = updated
        decision["failure_reason"] = f"codex_status_{codex_status}"
        event["event"] = "failed"
        event["failure_reason"] = decision["failure_reason"]

    state["schema_version"] = 2
    state["updated_utc"] = updated
    state["role"] = "supervisor"
    state["mode"] = mode
    state["runner_completed_count"] = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
    state["runner_started_count"] = int_env("WATCHDOG_RUNNER_STARTED_COUNT", state["runner_completed_count"])
    state["runner_failure_drift"] = int_env("WATCHDOG_RUNNER_FAILURE_DRIFT", max(0, state["runner_started_count"] - state["runner_completed_count"]))
    state["decision"] = decision

    atomic_write_json(state_path, state)
    atomic_write_json("agent/status/SUPERVISOR_MODE.json", state)
    append_jsonl("agent/status/SUPERVISOR_MODE.events.jsonl", event)

finalize_supervisor_decision()
`
};

module.exports = {
  activate,
  deactivate
};
