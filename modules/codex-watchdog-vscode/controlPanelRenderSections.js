"use strict";

const path = require("path");
const {
  renderBootstrapSection,
  renderLatestReportSection,
  renderBootstrapConversation,
  renderBootstrapQuestions,
  renderBootstrapPending,
  renderOperationPending
} = require("./controlPanelBootstrapRender");

function renderHeader(view) {
  return `
  <div class="header">
    <div>
      <h1>Codex Watchdog</h1>
      <div class="subtitle">${view.esc(view.projectLabel)}</div>
    </div>
    ${view.timerPill}
  </div>
`;
}

function renderMetrics(view) {
  return `
  <div class="metric selected-only"${view.selectedOnlyStyle}>
    <div class="metric-item"><span>Folder</span><strong class="${view.state.rootExists ? "ok" : "bad"}">${view.state.rootExists ? "Exists" : "Missing"}</strong></div>
    <div class="metric-item"><span>Template</span><strong class="${view.initializedClass}">${view.state.initialized ? "Initialized" : "Not initialized"}</strong></div>
    <div class="metric-item"><span>Task</span><strong class="${view.state.taskReady ? "ok" : "warn"}">${view.state.taskReady ? "Instantiated" : "Needs setup"}</strong></div>
    <div class="metric-item"><span>Login</span><strong class="${view.loginClass}">${view.state.login.ok ? "Ready" : "Needs login"}</strong></div>
    <div class="metric-item"><span>Control</span><strong class="${view.state.paused ? "warn" : "ok"}">${view.state.paused ? "Paused" : "Live"}</strong></div>
  </div>
  <div class="hint selected-only"${view.selectedOnlyStyle}>${view.esc(view.state.nextStep)}</div>
  ${view.state.root ? renderOperationPending(view.state.operation, view.esc) : ""}
`;
}

function renderProjectSection(view) {
  return `
  <div class="section">
  <h2>Project</h2>
  <div class="row">
    <input id="root" value="${view.esc(view.state.root)}" placeholder="/home/you/project">
    <button id="saveRoot">Use / Create Project</button>
    <button id="browseRoot" class="secondary">Browse Existing</button>
    <button id="chooseRoot" class="ghost">Prompt Path</button>
    <button id="clearRoot" class="ghost">Clear</button>
  </div>
  <div id="pendingRootHint" class="hint" hidden>This path is not selected yet. Click <strong>Use / Create Project</strong> to create/select it before viewing reports or starting the guard.</div>
  <div class="grid selected-only"${view.selectedOnlyStyle}>
    <div class="label">Folder</div><div class="${view.state.rootExists ? "ok" : "bad"}">${view.state.rootExists ? "exists" : "missing"}</div>
    <div class="label">Template</div><div class="${view.initializedClass}">${view.state.initialized ? "initialized" : "not initialized"}</div>
    <div class="label">Task</div><div class="${view.state.taskReady ? "ok" : "warn"}">${view.state.taskReady ? "instantiated" : "needs setup"}</div>
    <div class="label">Sandbox</div><div><code>${view.esc(view.state.sandboxMode || "-")}</code></div>
    <div class="label">Codex Home</div><div><code>${view.esc(view.state.codexHome || "-")}</code></div>
    <div class="label">Codex Bin</div><div><code>${view.esc(view.state.codexBin || "-")}</code></div>
  </div>
  ${view.state.codexHomeNotice ? `<div class="status warn">${view.esc(view.state.codexHomeNotice)}</div>` : ""}
  </div>
`;
}

function renderLoginSection(view) {
  return `
  <div class="section selected-only"${view.selectedOnlyStyle}>
  <h2>Login</h2>
  <div class="status ${view.loginClass}">${view.esc(view.state.login.text)}</div>
  ${view.state.login.bootstrapText ? `<div class="status warn">${view.esc(view.state.login.bootstrapText)}</div>` : ""}
  <div class="hint">OpenAI login is the only manual authorization step. The extension prepares the folder and scripts, then waits for this login before starting unattended runs.</div>
  <div class="row">
    <button id="refresh" class="secondary">Refresh Status</button>
    <button id="login">Open Login Terminal</button>
  </div>
  </div>
`;
}

function renderScheduleSection(view) {
  return `
  <div class="section selected-only"${view.selectedOnlyStyle}>
  <h2>Schedule</h2>
  <div class="row">
    <label for="interval">Repeat every</label>
    <input id="interval" class="small" type="number" min="5" value="${view.esc(view.state.intervalMinutes || "30")}">
    <span>minutes</span>
    <label for="compactEveryRuns">Compact every</label>
    <input id="compactEveryRuns" class="small" type="number" min="0" value="${view.esc(view.state.compactEveryRuns || "6")}">
    <span>runs</span>
    <button id="saveInterval">Save</button>
  </div>
  <div class="status">${view.esc(view.state.timer.text)}</div>
  ${view.state.timer.warningText ? `<div class="status warn">${view.esc(view.state.timer.warningText)}</div>` : ""}
  </div>
`;
}

function renderActionsSection(view) {
  return `
  <div class="section selected-only"${view.selectedOnlyStyle}>
  <h2>Actions</h2>
  <div class="actions">
    <button id="prepareProject" class="${view.esc(view.prepareButtonClass)}">Prepare Project</button>
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
`;
}

function renderRuntimeClaritySection(view) {
  return `
  <div class="section selected-only"${view.selectedOnlyStyle}>
  <h2>Runtime Clarity</h2>
  ${view.state.runtime.queueText ? `<div class="status">${view.esc(view.state.runtime.queueText)}</div>` : ""}
  ${renderRuntimeSignals(view.state.runtime, view.esc)}
  </div>
`;
}

function renderRuntimeSignals(runtime, esc) {
  return runtime.signals.length
    ? runtime.signals.map((signal) => `<div class="status ${esc(signal.level || "muted")}">${esc(signal.text || "")}</div>`).join("")
    : `<div class="subtle">No paused/stale-state warning is visible from the local watchdog runtime files.</div>`;
}

function getProjectLabel(root) {
  return root ? path.basename(root) || root : "No project selected";
}

module.exports = {
  getProjectLabel,
  renderHeader,
  renderMetrics,
  renderProjectSection,
  renderLoginSection,
  renderScheduleSection,
  renderActionsSection,
  renderRuntimeClaritySection,
  renderBootstrapSection,
  renderLatestReportSection,
  renderRuntimeSignals
};
