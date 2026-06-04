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
cd "$CONTROL_PLANE_ROOT/modules/codex-watchdog-vscode"
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
$PROJECT_ROOT/watchdog_demo_Grokking/agent/
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

Generated watchdog scripts also write:

```text
agent/status/generated_manifest.json
```

Run this inside a watchdog project after bootstrap or refresh:

```bash
./agent/bin/watchdog validate
```

It validates runtime JSON and checks generated file hashes. If generated scripts drift from the recorded template hashes, refresh generated watcher files before relying on the watchdog.

Preferred bootstrap flow in the VSCode control panel:

```text
Use / Create Project
-> Prepare Project
-> Bootstrap Conversation
-> Generate Drafts
-> Preview Changed Files
-> Instantiate Project
-> review PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF
-> decide whether to Start Guard
```

The `Bootstrap Conversation` keeps the initialization dialog inside the panel and saves the transcript in the project:

```text
agent/status/bootstrap_conversation.json
agent/status/bootstrap_conversation.md
```

The panel also supports:

```text
Generate Drafts        continue the setup discussion inside the panel
Preview Changed Files   synthesize/open the latest candidate file-change preview
Instantiate Project    apply the current conversation draft to the five core handoff files
Reset Conversation      archive current setup transcript/artifacts and clear the panel
```

That makes the setup intent visible to later Codex sessions and to teammates who inherit the project.
