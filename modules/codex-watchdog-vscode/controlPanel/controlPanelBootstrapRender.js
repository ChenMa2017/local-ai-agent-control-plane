"use strict";

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

module.exports = {
  renderBootstrapSection,
  renderLatestReportSection,
  renderBootstrapConversation,
  renderBootstrapQuestions,
  renderBootstrapPending,
  renderOperationPending
};
