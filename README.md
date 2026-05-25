# Local AI-Agent Control Plane

This repository combines the five local modules that make up the Discord/Web controlled Codex Agent Host.

It replaces day-to-day maintenance across five separate repos with one monorepo while keeping the runtime boundaries intact.

## Architecture

```text
Discord / Web UI
  -> Agent Host API
  -> codex-bridge
  -> Codex CLI
  -> local workspaces
  -> safe result / logs / Discord task thread
```

## Modules

```text
modules/codex-bridge
  Codex task execution core.
  Owns task lifecycle, cancel, timeout, safe output, reference_task_id,
  workspace-write audit, protected path policy, and write locks.

modules/agent-host
  Agent Host API and Web UI.
  Owns auth, workspace list, run/tasks/status/result/logs/cancel/SSE APIs,
  source metadata, idempotency, and adapter contract.

modules/discord-adapter
  Discord Gateway adapter.
  Owns slash commands, command_prefix, task threads, completion notifications,
  and Discord-only state mapping. It does not execute Codex directly.

modules/host-ops
  Read-only host sensor layer.
  Owns allowlisted systemd status, journal tail, disk usage, and git status.
  It is not a remote shell.

modules/codex-watchdog-vscode
  Project watchdog / VSCode prototype.
  Provides project-level watchdog workflow templates and tooling.
```

## Current Workspace Model

Runtime workspaces are configured in `modules/agent-host/config.json`, copied from `modules/agent-host/config.example.json`.

Typical local setup:

```text
main_codex
  $HOME/Documents/My_AI_Agent
  workspace-write

grokking
  $HOME/Documents/My_AI_Agent/watchdog_demo_Grokking
  readonly
```

The monorepo modules are tool implementation code. They do not need to be exposed as Agent Host workspaces for normal testing. Add them to your private `config.json` only when you explicitly want Codex to inspect the tool code through the Agent Host.

`main_codex` is the main AI-Agent workspace. It can be `workspace-write`, but write tasks are governed by:

```text
write_audit.json
diff_stat.safe.txt
changed_files.safe.txt
Write Summary in result.safe.md
protected path policy
policy_violation status
workspace write lock
```

## Bootstrap

For detailed setup instructions, see:

```text
docs/setup/
```

Install Node dependencies for modules that need them:

```bash
cd modules/codex-bridge
npm install

cd ../codex-watchdog-vscode
npm install
```

Install Python dependencies for the Discord adapter:

```bash
cd modules/discord-adapter
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

The Agent Host and Host Ops currently use the Python standard library only.

## Local Config

Copy examples:

```bash
cp modules/agent-host/config.example.json modules/agent-host/config.json
cp modules/discord-adapter/config.example.json modules/discord-adapter/config.json
```

Create secrets outside the repo:

```bash
mkdir -p ~/.config/agent-host
nano ~/.config/agent-host/secrets.env
chmod 600 ~/.config/agent-host/secrets.env
```

Example:

```bash
DISCORD_BOT_TOKEN=replace-with-token
DISCORD_GUILD_ID=replace-with-guild-id
AGENT_HOST_TOKEN=replace-with-agent-host-token
```

Never commit `config.json`, `.env`, `secrets.env`, task state, or logs.

## Development Checks

```bash
scripts/check_all.sh
```

This runs the module tests and syntax checks that can be run locally.

## Systemd User Services

The root service templates are in:

```text
systemd/user/agent-host-web.service
systemd/user/discord-agent-adapter.service
```

Install them for the current user:

```bash
scripts/install_user_services.sh
systemctl --user daemon-reload
systemctl --user start agent-host-web.service
systemctl --user start discord-agent-adapter.service
```

Inspect:

```bash
scripts/status_services.sh
scripts/tail_logs.sh
```

These templates read secrets from:

```text
~/.config/agent-host/secrets.env
```

They do not inline tokens.

## GitHub Push

Create an empty GitHub repository, then from this monorepo:

```bash
git remote add origin git@github.com:<your-user>/<your-repo>.git
git push -u origin master
```

Before pushing, run:

```bash
git status --short
scripts/check_all.sh
```

Confirm no `config.json`, `.env`, `secrets.env`, `state/`, `.codex-bridge/`, or logs are tracked.
