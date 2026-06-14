"use strict";

const assert = require("assert");

const { createServiceAssemblyBridges } = require("../serviceBridges");
const { createServiceControlPanelFactory } = require("../serviceControlPanelFactory");
const {
  createBaseControlPanelState,
  applyResolvedRuntimeState,
  applyConfigurationErrorState,
  createOperationState,
  applyLatestReportState
} = require("../controlPanelStateModel");
const { renderControlPanel } = require("../controlPanelRenderer");

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

async function main() {
  await testServiceBridges();
  testControlPanelStateModel();
  testRenderer();
  await testControlPanelFactoryCaching();
  console.log("refactor smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
