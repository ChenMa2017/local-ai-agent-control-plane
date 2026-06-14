"use strict";

const CONTROL_PANEL_STYLES = `
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
`;

module.exports = {
  CONTROL_PANEL_STYLES
};
