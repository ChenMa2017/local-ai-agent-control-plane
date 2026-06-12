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
  Discord reply-to-follow-up mapping, and ordered chunk delivery for long safe
  results. It does not execute Codex directly.

modules/host-ops
  Read-only host sensor layer.
  Owns allowlisted systemd status, journal tail, disk usage, and git status.
  It is not a remote shell.

modules/codex-watchdog-vscode
  Project watchdog / VSCode prototype.
  Provides project-level watchdog workflow templates, panel-local bootstrap
  conversation, and the bounded-autonomy runtime contract for runner/supervisor
  watchdogs.
```

## Current Workspace Model

Runtime workspaces are configured in `modules/agent-host/config.json`, copied from `modules/agent-host/config.example.json`.

Public docs use placeholders instead of private machine paths:

```text
$CONTROL_PLANE_ROOT  local clone of this monorepo
$PROJECT_ROOT        main AI-Agent workspace
$COLLAB_ROOT         optional shared docs / collaboration workspace
```

Set those locally however your machine is laid out; do not commit real private paths.

Typical local setup:

```text
main_codex
  $PROJECT_ROOT
  workspace-write

grokking
  $PROJECT_ROOT/watchdog_demo_Grokking
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

## Generated Watchdog Files

`modules/codex-watchdog-vscode` generates project-local watchdog scripts, schemas, prompts, skills, and helper docs. The generated project records a public-safe manifest:

```text
agent/status/generated_manifest.json
```

The manifest stores relative paths and SHA-256 template hashes only. It does not store local private paths. In a watchdog project, run:

```bash
./agent/bin/watchdog validate
```

That command validates compact runtime JSON and checks generated file drift against `generated_manifest.json`. If generated scripts or templates were hand-edited, validation fails and asks you to refresh generated watcher files.

The VSCode watchdog panel now also contains a `Bootstrap Conversation` setup flow. Instead of asking users to switch to a separate chat, the panel can:

- keep the initialization conversation inside the project UI;
- use `Generate Drafts` as the lightweight discussion turn so the user and AI can refine the watchdog goal in-panel;
- use `Preview Changed Files` to synthesize a candidate version of `agent/PLAN.md`, `agent/TODO.md`, `agent/STATE.md`, `agent/SAFETY.md`, and `agent/DAILY_HANDOFF.md` from that conversation;
- use `Instantiate Project` as the explicit point that applies that latest candidate draft to the project files;
- save the transcript under `agent/status/bootstrap_conversation.json` and `agent/status/bootstrap_conversation.md`;
- save a latest change preview under `agent/status/bootstrap_change_preview.md`;
- archive old setup rounds under `agent/status/bootstrap_archive/` when the user resets the conversation;
- let later Codex sessions and teammates inspect how the watchdog objective was defined.

Generated watchdog projects now also treat the route contract as structured runtime state, not just prose. In practice that means:

- `agent/TASK_BOX.json` can carry research-contract fields such as `project_question`, `decision_relevance`, `claim_scope`, `fair_comparability`, and `value_of_information`;
- `agent/ROUTE_CANONICAL.json` can require an exact successor contract through fields such as `successor_contract_required` and `exact_next_object_path`;
- projects may optionally add `agent/SECONDARY_SKILLS.json` so one routed wakeup can load project-owned support skills without changing the authoritative `primary_skill`;
- the generated route/runtime layer can repair missing research-contract metadata locally through `task_box_update`;
- if a route change requires an exact next object but the model forgot to emit one, the generated runtime can synthesize a bounded fallback successor draft instead of stopping at a broad report.

The generated runtime now also validates the secondary-skill chain end to end:

- `route_skill.py` may attach `secondary_skills` into `agent/status/SKILL_ROUTE.json`;
- the wakeup prompt must report `secondary_skills_consulted`;
- `render_report.py` rejects mismatched `primary_skill` or `secondary_skills_consulted` values.

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

## Operational Safety Checks

The monorepo includes a read-only safety helper:

```bash
python3 scripts/control_plane.py config validate
python3 scripts/control_plane.py migrate check --dry-run
python3 scripts/control_plane.py migrate rollback --dry-run
```

It validates config shape, prints redacted reports, detects scattered old installs, and prints a rollback plan. It does not stop services, restart services, delete files, or modify systemd units.

Agent Host also provides safe operational read APIs:

```text
GET /health/summary
POST /codex/prepare
POST /codex/result-page
```

`POST /codex/prepare` is now more than a generic clarification endpoint. It can:

- classify low-risk report-only / bounded CPU / local-workspace-copy requests into a structured `TASK_CONTRACT`;
- persist `INTENT_DRAFT`, `GRAY_AREAS`, `QUESTIONS`, `TASKBOX_DRAFT`, and `POLICY_PREFLIGHT`;
- persist `DECISION_GATE.json` for expensive or scientifically ambiguous experiments;
- block direct execution when experiment-defining decisions such as control-arm meaning, fairness constraints, or success criteria are still unresolved.

Discord Adapter maps them to:

```text
/agent_health
/agent_prepare
/agent_task_page
```

See:

```text
docs/setup/10-operational-safety.md
docs/setup/11-watchdog-secondary-skills-and-prepare-gates.md
```

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
git branch -M main
git push -u origin main
```

Before pushing, run:

```bash
git status --short
scripts/check_all.sh
```

Confirm no `config.json`, `.env`, `secrets.env`, `state/`, `.codex-bridge/`, logs, real Discord IDs, real tokens, or private local paths are tracked. Public examples should use `$PROJECT_ROOT`, `$CONTROL_PLANE_ROOT`, and `$COLLAB_ROOT`.
