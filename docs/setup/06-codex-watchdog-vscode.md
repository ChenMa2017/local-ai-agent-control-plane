# 06. Codex Watchdog VSCode Setup

Path:

```text
modules/codex-watchdog-vscode
```

Purpose:

```text
VSCode/project watchdog prototype.
```

Install/check:

```bash
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane/modules/codex-watchdog-vscode
npm install
node --check extension.js
```

Package locally if needed:

```bash
npm run package
```

This module is implementation tooling. It does not need to be exposed as an Agent Host workspace for ordinary Discord/Web tests.

Project watchdogs should live under project workspaces, for example:

```text
$HOME/Documents/My_AI_Agent/watchdog_demo_Grokking/agent/
```

Recommended project report protocol:

```text
agent/STATE.md
agent/PLAN.md
agent/TODO.md
agent/REPORT.md
agent/SAFETY.md
```

The main Codex workspace should read these reports rather than blindly scanning large logs.
