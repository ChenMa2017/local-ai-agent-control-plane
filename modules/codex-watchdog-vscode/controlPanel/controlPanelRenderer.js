"use strict";

const {
  getProjectLabel,
  renderHeader,
  renderMetrics,
  renderProjectSection,
  renderLoginSection,
  renderScheduleSection,
  renderActionsSection,
  renderRuntimeClaritySection,
  renderBootstrapSection,
  renderLatestReportSection
} = require("./controlPanelRenderSections");
const {
  CONTROL_PANEL_STYLES,
  renderControlPanelClientScript
} = require("./controlPanelRenderAssets");

function renderControlPanel(state, nonce) {
  const esc = escapeHtml;
  const scriptNonce = nonce || "";
  const loginClass = state.login.ok ? "ok" : "bad";
  const initializedClass = state.initialized ? "ok" : "warn";
  const timerActive = Boolean(state.timer.isActive);
  const timerEnabled = Boolean(state.timer.isEnabled);
  const timerClass = timerActive ? "ok" : timerEnabled ? "warn" : "muted";
  const timerLabel = timerActive ? "On" : timerEnabled ? "Enabled" : "Off";
  const prepareButtonClass = !state.initialized || !state.taskReady ? "" : "secondary";
  const startButtonClass = state.initialized && state.taskReady && !timerActive ? "" : "secondary";
  const instantiateButtonClass = state.bootstrap.hasDraft ? "" : "secondary";
  const selectedOnlyStyle = state.root ? "" : ' style="display:none"';
  const timerPill = state.root ? `<div class="pill ${timerClass}">Timer ${esc(timerLabel)}</div>` : "";
  const view = {
    esc,
    state,
    loginClass,
    initializedClass,
    prepareButtonClass,
    startButtonClass,
    instantiateButtonClass,
    selectedOnlyStyle,
    timerPill,
    projectLabel: getProjectLabel(state.root)
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${esc(scriptNonce)}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Watchdog</title>
  <style>
${CONTROL_PANEL_STYLES}
  </style>
</head>
<body data-selected-root="${esc(state.root)}">
  ${renderHeader(view)}
  ${renderMetrics(view)}
  ${renderProjectSection(view)}
  ${renderLoginSection(view)}
  ${renderScheduleSection(view)}
  ${renderActionsSection(view)}
  ${renderRuntimeClaritySection(view)}
  ${renderBootstrapSection(view)}
  ${renderLatestReportSection(view)}

  <script nonce="${esc(scriptNonce)}">
${renderControlPanelClientScript()}
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  renderControlPanel
};
