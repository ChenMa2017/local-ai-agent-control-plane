"use strict";

const path = require("path");

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

function renderBootstrapSection(view) {
  return `
  <div class="section selected-only"${view.selectedOnlyStyle}>
    <h2>Bootstrap Conversation</h2>
    <div class="hint">Keep the watchdog setup discussion here. Codex will read the bootstrap files, answer inside this panel, stage a candidate setup draft, and keep the setup transcript in the project for later follow-up.</div>
    <div class="status">${view.esc(view.state.bootstrap.statusText)}</div>
    ${renderBootstrapQuestions(view.state.bootstrap.openQuestions, view.esc)}
    <div class="conversation">
      ${renderBootstrapConversation(view.state.bootstrap.messages, view.esc)}
      ${renderBootstrapPending(view.state.bootstrap, view.esc)}
    </div>
    <div class="row">
      <textarea id="bootstrapPrompt" placeholder="Describe what this watchdog project should do, what to avoid, and whether guard start should wait for review.">${view.esc(view.state.bootstrap.draftText || "")}</textarea>
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
        <button id="instantiateBootstrapProject" class="${view.esc(view.instantiateButtonClass)}">Instantiate Project</button>
      </div>
      <div class="workflow-card ${view.state.taskReady ? "ready" : ""}">
        <div class="workflow-step-title">Step 4</div>
        <div class="workflow-step-body"><strong>Start Guard</strong>\n最后再启动 guard，让项目进入定时 watchdog 模式。${view.state.taskReady ? "\n\n当前状态：已满足启动条件。" : "\n\n当前状态：还要先完成实例化。"} </div>
        <button id="startGuard" class="${view.esc(view.startButtonClass)}">Start Guard</button>
      </div>
    </div>
    <div class="actions" style="margin-top:10px;">
      <button id="openSetupFiles" class="secondary">Open Setup Files</button>
      <button id="openBootstrapTranscript" class="ghost">Open Setup Transcript</button>
      <button id="resetBootstrapConversation" class="ghost">Reset Conversation</button>
    </div>
  </div>
`;
}

function renderLatestReportSection(view) {
  return `
  <div class="section selected-only"${view.selectedOnlyStyle}>
  <h2>Latest Report</h2>
  <div>${view.state.latestReport ? `<code>${view.esc(view.state.latestReport)}</code>` : "No latest report found."}</div>
  ${view.state.latestSummary ? `<pre>${view.esc(view.state.latestSummary)}</pre>` : ""}
  </div>
`;
}

function renderBootstrapConversation(messages, esc) {
  return messages.length
    ? messages.map((message) => {
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
}

function renderBootstrapQuestions(openQuestions, esc) {
  return openQuestions.length
    ? `
      <div class="hint">
        <strong>Open questions</strong>
        <ul>
          ${openQuestions.map((item) => `<li>${esc(item)}</li>`).join("")}
        </ul>
      </div>
    `
    : "";
}

function renderBootstrapPending(bootstrap, esc) {
  return bootstrap.isRunning
    ? renderPendingMessage({
      title: "⌛ Waiting for AI reply",
      startedAt: bootstrap.runtimeStartedAt,
      detail: bootstrap.runtimeDetail || "Codex is thinking about the next reply..."
    }, esc)
    : "";
}

function renderOperationPending(operation, esc) {
  return operation.isRunning
    ? renderPendingMessage({
      title: operation.title || "Working",
      startedAt: operation.startedAt,
      detail: operation.detail || "Codex Watchdog is still working on this step..."
    }, esc)
    : "";
}

function renderPendingMessage(message, esc) {
  return `
      <div class="message assistant pending">
        <div class="message-meta">${esc(message.title)}${message.startedAt ? ` · ${esc(message.startedAt)}` : ""}</div>
        <div class="message-body">${esc(message.detail)}</div>
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
  renderBootstrapConversation,
  renderBootstrapQuestions,
  renderBootstrapPending,
  renderOperationPending,
  renderRuntimeSignals
};
