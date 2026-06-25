"use strict";

const assert = require("assert");

const { createServiceAssemblyBridges } = require("../services/serviceBridges");
const { createServiceControlPanelFactory } = require("../services/serviceControlPanelFactory");
const { createServiceRuntimeFactory } = require("../services/serviceRuntimeFactory");
const { createServiceProjectFactory } = require("../services/serviceProjectFactory");
const { createServiceAssembly } = require("../services/serviceAssembly");
const {
  createBaseControlPanelState,
  applyResolvedRuntimeState,
  applyConfigurationErrorState,
  createOperationState,
  applyLatestReportState
} = require("../controlPanel/controlPanelStateModel");
const { renderControlPanel } = require("../controlPanel/controlPanelRenderer");

async function testServiceBridges() {
  const calls = [];
  const bridges = createServiceAssemblyBridges({
    getProjectRootManager: () => ({
      getKnownProjectRoot: () => "/tmp/project",
      getWorkspaceRoot: () => "/tmp/workspace",
      selectProjectRoot: async (title) => {
        calls.push(["selectProjectRoot", title]);
        return "/tmp/project";
      },
      browseExistingProjectRoot: async (title, raw) => {
        calls.push(["browseExistingProjectRoot", title, raw]);
        return raw;
      },
      normalizeProjectRootInput: async (raw) => raw,
      getProjectRoot: async () => "/tmp/project",
      rememberProjectRoot: async (root) => {
        calls.push(["rememberProjectRoot", root]);
      },
      clearRememberedProjectRoot: async () => {
        calls.push(["clearRememberedProjectRoot"]);
      }
    }),
    getRuntimeHelpers: () => ({
      effectiveWatchdogSettings: async () => ({ intervalMinutes: 30 }),
      renderWatchdogEnv: async () => "ENV=1",
      writeSystemdUnits: async () => "ok",
      ensureCodexHome: async () => "home",
      inspectWatcherHomeBootstrapState: () => ({ ok: true }),
      inspectWatcherHomeBootstrap: () => ({ ok: true }),
      seedWatcherHomeBootstrapFromProfilePaths: async () => "seeded",
      seedWatcherHomeAuthFromMainProfile: async () => "auth-seeded",
      getCodexLoginStatus: async () => ({ ok: true }),
      confirmLoginIfNeeded: async () => true,
      openLoginTerminal: async () => "opened",
      getTimerStatus: async () => ({ isActive: false, isEnabled: false, text: "timer" }),
      readWatcherUnitDrift: () => ({ needsReinstall: false, text: "" }),
      inspectProjectRuntimeClarity: () => ({ signals: [] })
    }),
    getBootstrapScaffoldingHelpers: () => ({
      bootstrapProject: async () => ({ created: [] }),
      showBootstrapResult: (result) => result,
      ensureWatchdogReadme: async () => "readme",
      createDemoProjectTemplate: async () => ({ root: "/tmp/project" })
    }),
    getControlPanelController: () => ({
      updateStatusBar: async () => {
        calls.push(["updateStatusBar"]);
      },
      openControlPanel: async () => {
        calls.push(["openControlPanel"]);
      },
      updateControlPanel: async () => {
        calls.push(["updateControlPanel"]);
      },
      setPanelOperationState: async (data) => {
        calls.push(["setPanelOperationState", data.title]);
      },
      clearPanelOperationState: async () => {
        calls.push(["clearPanelOperationState"]);
      },
      initializeStatusBar: () => {
        calls.push(["initializeStatusBar"]);
      }
    }),
    getProjectSetupHelpers: () => ({
      taskLooksInstantiated: () => true
    }),
    resolveCodexBin: async () => "/usr/bin/codex",
    updateProjectSetting: async (root, key, value) => {
      calls.push(["updateProjectSetting", root, key, value]);
    },
    archiveAndResetBootstrapConversation: async (root) => {
      calls.push(["archiveAndResetBootstrapConversation", root]);
    }
  });

  assert.strictEqual(bridges.getKnownProjectRoot(), "/tmp/project");
  assert.strictEqual(bridges.getWorkspaceRoot(), "/tmp/workspace");
  assert.strictEqual(await bridges.selectProjectRoot("Select"), "/tmp/project");
  await bridges.updateStatusBar();
  await bridges.updateProjectSetting("/tmp/project", "codexWatchdog.intervalMinutes", 30);
  assert.strictEqual(await bridges.resolveCodexBin("/tmp/project"), "/usr/bin/codex");
  assert.strictEqual(bridges.taskLooksInstantiated("/tmp/project"), true);
  assert.deepStrictEqual(calls[0], ["selectProjectRoot", "Select"]);
  assert.deepStrictEqual(calls[1], ["updateStatusBar"]);
}

function testControlPanelStateModel() {
  const state = createBaseControlPanelState({
    root: "/tmp/project",
    rootExists: true,
    initialized: true,
    taskReady: false,
    paused: false
  });
  assert.strictEqual(state.root, "/tmp/project");
  assert.strictEqual(state.initialized, true);
  assert.strictEqual(state.taskReady, false);

  applyResolvedRuntimeState(state, {
    codexHome: "/tmp/home",
    codexHomeNotice: "notice",
    codexBin: "/usr/bin/codex",
    sandboxMode: "read-only",
    timeoutMinutes: 25,
    intervalMinutes: 30,
    compactEveryRuns: 6,
    login: { ok: true },
    timer: { text: "timer", isActive: false, isEnabled: true },
    runtime: { queueText: "queue", signals: [] },
    timerNeedsReinstall: true,
    timerWarningText: "reinstall"
  });
  assert.strictEqual(state.codexHome, "/tmp/home");
  assert.strictEqual(state.timer.needsReinstall, true);
  assert.strictEqual(state.intervalMinutes, "30");

  state.operation = createOperationState({
    status: "running",
    title: "Refreshing",
    detail: "Working",
    startedAt: "2026-06-13T00:00:00Z"
  });
  assert.strictEqual(state.operation.isRunning, true);
  assert.strictEqual(state.operation.title, "Refreshing");

  applyLatestReportState(state, {
    latestReport: "/tmp/project/agent/reports/latest.md",
    latestSummary: "summary"
  });
  assert.strictEqual(state.latestSummary, "summary");

  applyConfigurationErrorState(state, "broken");
  assert.match(state.login.text, /broken/);
  assert.match(state.nextStep, /Fix the project-local watchdog configuration/);
}

function testRenderer() {
  const html = renderControlPanel({
    root: "/tmp/project",
    rootExists: true,
    initialized: true,
    taskReady: true,
    paused: false,
    codexHome: "/tmp/home",
    codexHomeNotice: "",
    codexBin: "/usr/bin/codex",
    sandboxMode: "read-only",
    timeoutMinutes: "25",
    intervalMinutes: "30",
    compactEveryRuns: "6",
    login: { ok: true, text: "Ready", bootstrapText: "" },
    timer: { isActive: false, isEnabled: true, text: "Timer enabled", warningText: "", needsReinstall: false },
    runtime: { queueText: "", signals: [] },
    latestReport: "",
    latestSummary: "",
    bootstrap: {
      hasDraft: true,
      messages: [{ role: "assistant", text: "<b>safe</b>", createdAt: "2026-06-13T00:00:00Z" }],
      openQuestions: ["Can we proceed?"],
      isRunning: true,
      runtimeStartedAt: "2026-06-13T00:00:01Z",
      runtimeDetail: "Thinking",
      statusText: "Discuss setup",
      draftText: "hello"
    },
    operation: { isRunning: true, title: "Preparing", detail: "Running", startedAt: "2026-06-13T00:00:02Z" },
    nextStep: "Next"
  }, "nonce-123");

  assert.match(html, /Generate Drafts/);
  assert.match(html, /Instantiate Project/);
  assert.match(html, /Waiting for AI reply/);
  assert.match(html, /&lt;b&gt;safe&lt;\/b&gt;/);
  assert.match(html, /nonce-123/);
}

async function testControlPanelFactoryCaching() {
  let stateCount = 0;
  let actionCount = 0;
  let controllerCount = 0;

  const factory = createServiceControlPanelFactory({
    createControlPanelStateHelpers: () => ({ kind: `state-${++stateCount}` }),
    createControlPanelActionHandler: () => ({ kind: `action-${++actionCount}` }),
    createControlPanelController: () => ({ kind: `controller-${++controllerCount}`, deactivate() {} }),
    vscode: {},
    getOutput: () => ({ appendLine() {} }),
    statusRefreshMs: 1000,
    emptyPanelOperationState: () => ({ status: "idle" }),
    nextPanelOperationState: (prev) => prev,
    defaultTimeoutMinutes: 25,
    defaultIntervalMinutes: 30,
    defaultCompactEveryRuns: 6,
    extensionSetting: () => undefined,
    isWatchdogInitialized: () => true,
    getProjectSetupHelpers: () => ({ taskLooksInstantiated: () => true, openInstantiationFiles() {} }),
    getProjectCommands: () => ({
      isGuardPaused: () => false,
      showProjectRootSelected() {},
      prepareProjectCommand() {},
      generateBootstrapConversationCommand() {},
      openMorningBriefCommand() {},
      refreshGeneratedFilesCommand() {}
    }),
    getRuntimeConfigHelpers: () => ({
      codexHomePlan: () => ({ effectivePath: "/tmp/home" }),
      sandboxModeSetting: () => "read-only",
      positiveNumberSetting: () => 30
    }),
    getBootstrapWorkflowHelpers: () => ({ instantiateBootstrapProjectCommand() {} }),
    getGuardCommands: () => ({ startGuardCommand() {} }),
    bridges: {
      getKnownProjectRoot: () => "/tmp/project",
      resolveCodexBin: async () => "/usr/bin/codex",
      getCodexLoginStatus: async () => ({ ok: true }),
      getTimerStatus: async () => ({ isActive: false, isEnabled: false, text: "timer" }),
      inspectProjectRuntimeClarity: () => ({ queueText: "", signals: [] }),
      effectiveWatchdogSettings: async () => ({}),
      readWatcherUnitDrift: () => ({ needsReinstall: false, text: "" }),
      getProjectRoot: async () => "/tmp/project",
      selectProjectRoot: async () => "/tmp/project",
      rememberProjectRoot: async () => {},
      browseExistingProjectRoot: async () => "/tmp/project",
      normalizeProjectRootInput: async () => "/tmp/project",
      clearRememberedProjectRoot: async () => {},
      updateProjectSetting: async () => {},
      updateControlPanel: async () => {},
      openLoginTerminal: async () => {},
      archiveAndResetBootstrapConversation: async () => {}
    },
    getBootstrapConversationState: async () => ({ messages: [], openQuestions: [], hasDraft: false }),
    readFilePrefix: () => ""
  });

  assert.strictEqual(factory.getControlPanelStateHelpers().kind, "state-1");
  assert.strictEqual(factory.getControlPanelStateHelpers().kind, "state-1");
  assert.strictEqual(factory.getControlPanelMessageHandler().kind, "action-1");
  assert.strictEqual(factory.getControlPanelMessageHandler().kind, "action-1");
  assert.strictEqual(factory.getControlPanelController().kind, "controller-1");
  assert.strictEqual(factory.getControlPanelController().kind, "controller-1");
  assert.strictEqual(stateCount, 1);
  assert.strictEqual(actionCount, 1);
  assert.strictEqual(controllerCount, 1);
  factory.deactivate();
}

async function testRuntimeFactoryCaching() {
  let rootManagerCount = 0;
  let runtimeConfigCount = 0;
  let runtimeHelpersCount = 0;
  let updateStatusBarCount = 0;

  const runtimeFactory = createServiceRuntimeFactory({
    createProjectRootManager: ({ updateStatusBar }) => ({
      kind: `root-${++rootManagerCount}`,
      getKnownProjectRoot: () => "/tmp/project",
      getWorkspaceRoot: () => "/tmp/workspace",
      getProjectRoot: async () => "/tmp/project",
      selectProjectRoot: async () => "/tmp/project",
      browseExistingProjectRoot: async () => "/tmp/project",
      normalizeProjectRootInput: async () => "/tmp/project",
      rememberProjectRoot: async () => {},
      clearRememberedProjectRoot: async () => {},
      pokeStatus: async () => updateStatusBar()
    }),
    createRuntimeConfigHelpers: () => ({
      kind: `config-${++runtimeConfigCount}`,
      codexHomeSetting: () => "/tmp/home",
      codexHomePlan: () => ({ effectivePath: "/tmp/home" }),
      sandboxModeSetting: () => "read-only",
      positiveNumberSetting: () => 30,
      watchdogRoleSetting: () => "runner",
      booleanSetting: () => true,
      servicePrefixSetting: () => "codex-watchdog",
      watcherProfileModelDefaults: {},
      mergeWatcherConfigText: () => "",
      hasTomlAssignment: () => false,
      parseTomlBasicString: () => ""
    }),
    createRuntimeHelpers: ({ getProjectRoot }) => ({
      kind: `runtime-${++runtimeHelpersCount}`,
      getProjectRoot
    }),
    vscode: {},
    fs: {},
    fsp: {},
    path: {},
    os: {},
    getOutput: () => ({ appendLine() {} }),
    getExtensionContext: () => ({ subscriptions: [] }),
    projectRootKey: "root",
    extensionSetting: () => undefined,
    extensionSettingWithSource: () => undefined,
    projectSetting: () => undefined,
    projectSettingWithSource: () => undefined,
    expandHome: (value) => value,
    isExistingDirectory: () => true,
    isSafeProjectRootPath: () => true,
    validateProjectRootPath: () => true,
    ensureDir: async () => {},
    requireExistingDirectory: async () => {},
    defaultWatchdogRole: "runner",
    defaultServicePrefix: "codex-watchdog",
    loginReadyRe: /ready/,
    resolveCodexBin: async () => "/usr/bin/codex",
    updateProjectSetting: async () => {},
    defaultTimeoutMinutes: 25,
    defaultIntervalMinutes: 30,
    defaultCompactEveryRuns: 6,
    defaultPhaseOffsetMinutes: 10,
    defaultSupervisorLightFollowup: true,
    defaultSupervisorAuditEveryRunnerRuns: 4,
    run: async () => {},
    unitNames: () => ({}),
    systemdQuote: (value) => value,
    systemdPathValue: (value) => value,
    systemdEnvValue: (value) => value,
    shellQuote: (value) => value,
    readFilePrefix: () => "",
    updateStatusBar: async () => {
      updateStatusBarCount += 1;
    }
  });

  assert.strictEqual(runtimeFactory.getProjectRootManager().kind, "root-1");
  assert.strictEqual(runtimeFactory.getProjectRootManager().kind, "root-1");
  assert.strictEqual(runtimeFactory.getRuntimeConfigHelpers().kind, "config-1");
  assert.strictEqual(runtimeFactory.getRuntimeConfigHelpers().kind, "config-1");
  assert.strictEqual(runtimeFactory.getRuntimeHelpers().kind, "runtime-1");
  assert.strictEqual(runtimeFactory.getRuntimeHelpers().kind, "runtime-1");
  assert.strictEqual(await runtimeFactory.getRuntimeHelpers().getProjectRoot(), "/tmp/project");
  await runtimeFactory.getProjectRootManager().pokeStatus();
  assert.strictEqual(rootManagerCount, 1);
  assert.strictEqual(runtimeConfigCount, 1);
  assert.strictEqual(runtimeHelpersCount, 1);
  assert.strictEqual(updateStatusBarCount, 1);
}

async function testProjectFactoryCaching() {
  let setupCount = 0;
  let workflowCount = 0;
  let generatedCount = 0;
  let scaffoldingCount = 0;
  let commandsCount = 0;
  let guardCount = 0;
  let timeoutProbe;
  let guardTimeoutProbe;

  const projectFactory = createServiceProjectFactory({
    createProjectSetupHelpers: () => ({
      kind: `setup-${++setupCount}`,
      prepareProjectForGuard() {},
      confirmTaskInstantiatedIfNeeded() {},
      ensureBootstrapConversationReady() {},
      taskLooksInstantiated() { return true; }
    }),
    createBootstrapWorkflowHelpers: (args) => {
      timeoutProbe = args.watchdogCommandTimeoutMs;
      return { kind: `workflow-${++workflowCount}` };
    },
    createGeneratedFilesHelpers: () => ({
      kind: `generated-${++generatedCount}`,
      refreshGeneratedWatcherFiles() {}
    }),
    createBootstrapScaffoldingHelpers: () => ({
      kind: `scaffolding-${++scaffoldingCount}`
    }),
    createProjectCommands: () => ({
      kind: `commands-${++commandsCount}`,
      watchdogCommandTimeoutMs: () => 12345,
      watchdogCommandEnv: async () => ({}),
      isGuardPaused: () => false
    }),
    createGuardLifecycle: (args) => {
      guardTimeoutProbe = args.watchdogCommandTimeoutMs();
      return { kind: `guard-${++guardCount}` };
    },
    vscode: {},
    fs: {},
    fsp: {},
    path: {},
    crypto: {},
    packageVersion: "0.1.47",
    templates: {},
    ensureDir: async () => {},
    getOutput: () => ({ appendLine() {} }),
    openDocument: async () => {},
    getRuntimeConfigHelpers: () => ({
      codexHomeSetting: () => "/tmp/home"
    }),
    bridges: {
      bootstrapProject: async () => ({}),
      showBootstrapResult: () => {},
      ensureCodexHome: async () => {},
      renderWatchdogEnv: async () => "",
      resolveCodexBin: async () => "/usr/bin/codex",
      updateControlPanel: async () => {},
      confirmLoginIfNeeded: async () => true,
      getProjectRoot: async () => "/tmp/project",
      selectProjectRoot: async () => "/tmp/project",
      rememberProjectRoot: async () => {},
      effectiveWatchdogSettings: async () => ({}),
      setPanelOperationState: async () => {},
      clearPanelOperationState: async () => {},
      updateStatusBar: async () => {},
      getTimerStatus: async () => ({})
    },
    bootstrapConversationTurnSchemaPath: () => "/tmp/turn.schema.json",
    bootstrapResultSchemaPath: () => "/tmp/result.schema.json",
    bootstrapLastResultPath: () => "/tmp/last.json",
    bootstrapConversationPromptText: () => "prompt",
    bootstrapInstantiationPromptText: () => "instantiate",
    bootstrapConversationMarkdownPath: () => "/tmp/conversation.md",
    bootstrapChangePreviewPath: () => "/tmp/preview.md",
    readBootstrapConversation: async () => ({}),
    writeBootstrapConversation: async () => {},
    clearBootstrapDraftArtifacts: async () => {},
    runLoggedWithInput: async () => {},
    createNonce: () => "nonce",
    stageBootstrapDraftFiles: async () => {},
    applyBootstrapDraftFiles: async () => [],
    writeBootstrapRuntimeState: async () => {},
    emptyBootstrapRuntimeState: () => ({}),
    extensionSetting: () => undefined,
    defaultTimeoutMinutes: 25,
    isWatchdogInitialized: () => true,
    isEffectivelyEmptyDir: () => false,
    runLogged: async () => {},
    unitNames: () => ({}),
    getControlPanelController: () => ({
      setPanelOperationState: async () => {},
      clearPanelOperationState: async () => {}
    })
  });

  assert.strictEqual(projectFactory.getProjectSetupHelpers().kind, "setup-1");
  assert.strictEqual(projectFactory.getProjectSetupHelpers().kind, "setup-1");
  assert.strictEqual(projectFactory.getGeneratedFilesHelpers().kind, "generated-1");
  assert.strictEqual(projectFactory.getGeneratedFilesHelpers().kind, "generated-1");
  assert.strictEqual(projectFactory.getBootstrapScaffoldingHelpers().kind, "scaffolding-1");
  assert.strictEqual(projectFactory.getProjectCommands().kind, "commands-1");
  assert.strictEqual(projectFactory.getBootstrapWorkflowHelpers().kind, "workflow-1");
  assert.strictEqual(projectFactory.getGuardCommands().kind, "guard-1");
  assert.strictEqual(timeoutProbe("/tmp/project"), 12345);
  assert.strictEqual(guardTimeoutProbe, 12345);
  assert.strictEqual(setupCount, 1);
  assert.strictEqual(workflowCount, 1);
  assert.strictEqual(generatedCount, 1);
  assert.strictEqual(scaffoldingCount, 1);
  assert.strictEqual(commandsCount, 1);
  assert.strictEqual(guardCount, 1);
}

async function testServiceAssemblySmoke() {
  const registeredCommands = [];
  const context = {
    subscriptions: [],
    globalState: {
      get() {
        return undefined;
      },
      async update() {}
    }
  };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ProgressLocation: { Notification: 1 },
    ViewColumn: { One: 1 },
    Disposable: class Disposable {
      constructor(fn) {
        this.dispose = fn;
      }
    },
    Uri: {
      file(fsPath) {
        return { fsPath };
      }
    },
    workspace: {
      workspaceFolders: []
    },
    commands: {
      registerCommand(name, handler) {
        registeredCommands.push(name);
        return { dispose() {}, handler };
      }
    },
    window: {
      createStatusBarItem() {
        return {
          show() {},
          hide() {},
          dispose() {},
          text: "",
          tooltip: "",
          backgroundColor: undefined,
          command: "",
          name: ""
        };
      },
      showErrorMessage() {},
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      createWebviewPanel() {
        return {
          webview: {
            html: "",
            onDidReceiveMessage() {}
          },
          onDidDispose() {},
          reveal() {}
        };
      }
    }
  };

  const assembly = createServiceAssembly({
    vscode,
    fs: require("fs"),
    fsp: require("fs").promises,
    path: require("path"),
    os: require("os"),
    crypto: require("crypto"),
    getOutput: () => ({ appendLine() {} }),
    getExtensionContext: () => context,
    projectRootKey: "codexWatchdog.projectRoot",
    statusRefreshMs: 1_000,
    defaultIntervalMinutes: 30,
    defaultTimeoutMinutes: 25,
    defaultCompactEveryRuns: 6,
    defaultPhaseOffsetMinutes: 10,
    defaultWatchdogRole: "runner",
    defaultSupervisorAuditEveryRunnerRuns: 4,
    defaultSupervisorLightFollowup: true,
    defaultServicePrefix: "codex-watchdog",
    loginReadyRe: /ready/i,
    emptyPanelOperationState: () => ({ status: "idle" }),
    nextPanelOperationState: (_, next) => next || { status: "idle" },
    templates: {},
    ensureDir: async () => {},
    openDocument: async () => {},
    extensionSetting: (_key, fallback) => fallback,
    extensionSettingWithSource: (_key, fallback) => ({ value: fallback, source: "extension" }),
    projectSetting: (_root, _key, fallback) => fallback,
    projectSettingWithSource: (_root, _key, fallback) => ({ value: fallback, source: "project" }),
    expandHome: (value) => value,
    isExistingDirectory: () => false,
    isSafeProjectRootPath: () => true,
    validateProjectRootPath: () => true,
    requireExistingDirectory: async (value) => value,
    resolveCodexBin: async () => "/usr/bin/codex",
    runLogged: async () => ({ stdout: "", stderr: "" }),
    runLoggedWithInput: async () => ({ stdout: "", stderr: "" }),
    createNonce: () => "nonce",
    updateProjectSetting: async () => {},
    run: async () => ({ stdout: "", stderr: "" }),
    unitNames: () => ({
      service: "codex-watchdog.service",
      timer: "codex-watchdog.timer",
      wakeupService: "codex-watchdog-wakeup.service"
    }),
    systemdQuote: (value) => value,
    systemdPathValue: (value) => value,
    systemdEnvValue: (value) => value,
    shellQuote: (value) => value,
    readFilePrefix: () => "",
    isWatchdogInitialized: () => false,
    isEffectivelyEmptyDir: () => true
  });

  assert.strictEqual(typeof assembly.activate, "function");
  assert.strictEqual(typeof assembly.getProjectCommands, "function");
  assembly.activate(context);
  assert(registeredCommands.includes("codexWatchdog.openControlPanel"));
  assert(registeredCommands.includes("codexWatchdog.startGuard"));
  assert(registeredCommands.includes("codexWatchdog.acceptStateUpdate"));
  assembly.deactivate();
}

async function main() {
  await testServiceBridges();
  testControlPanelStateModel();
  testRenderer();
  await testControlPanelFactoryCaching();
  await testRuntimeFactoryCaching();
  await testProjectFactoryCaching();
  await testServiceAssemblySmoke();
  console.log("refactor smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
