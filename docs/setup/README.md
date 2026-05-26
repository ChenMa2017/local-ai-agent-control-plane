# Setup Guide Index

This folder is the operational setup manual for the monorepo.

Read in this order:

```text
00-overview.md
01-prerequisites.md
02-codex-bridge.md
03-agent-host.md
04-discord-adapter.md
05-host-ops.md
06-codex-watchdog-vscode.md
07-systemd-services.md
08-new-machine-checklist.md
09-github-ssh.md
10-operational-safety.md
```

The normal test workspaces are intentionally small:

```text
main_codex
  $HOME/Documents/My_AI_Agent
  workspace-write

grokking
  $HOME/Documents/My_AI_Agent/watchdog_demo_Grokking
  readonly
```

The module source directories are implementation code. Do not expose them as Agent Host workspaces unless you explicitly want Codex to inspect or maintain the tooling itself.
