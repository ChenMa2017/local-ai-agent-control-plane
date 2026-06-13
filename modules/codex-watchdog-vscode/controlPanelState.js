"use strict";

const fs = require("fs");
const path = require("path");

function emptyPanelOperationState() {
  return {
    status: "idle",
    title: "",
    detail: "",
    startedAt: ""
  };
}

function nextPanelOperationState(previousState, data) {
  const previous = previousState || emptyPanelOperationState();
  return {
    status: "running",
    title: String(data && data.title || ""),
    detail: String(data && data.detail || ""),
    startedAt: String(data && data.startedAt || previous.startedAt || new Date().toISOString())
  };
}

function createControlPanelStateHelpers({
  getKnownProjectRoot,
  isWatchdogInitialized,
  getProjectSetupHelpers,
  isGuardPaused,
  codexHomePlan,
  resolveCodexBin,
  sandboxModeSetting,
  positiveNumberSetting,
  extensionSetting,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_COMPACT_EVERY_RUNS,
  getCodexLoginStatus,
  getTimerStatus,
  inspectProjectRuntimeClarity,
  effectiveWatchdogSettings,
  readWatcherUnitDrift,
  getBootstrapConversationState,
  readFilePrefix
}) {
  async function getControlPanelState(panelOperationState) {
    const root = getKnownProjectRoot();
    const projectSetupHelpers = getProjectSetupHelpers();
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
      isRunning: panelOperationState && panelOperationState.status === "running",
      title: String(panelOperationState && panelOperationState.title || ""),
      detail: String(panelOperationState && panelOperationState.detail || ""),
      startedAt: String(panelOperationState && panelOperationState.startedAt || "")
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

  function renderControlPanel(state, nonce) {
    const esc = escapeHtml;
    const scriptNonce = nonce || "";
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

  return {
    getControlPanelState,
    getControlPanelNextStep,
    renderControlPanel
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  emptyPanelOperationState,
  nextPanelOperationState,
  createControlPanelStateHelpers
};
