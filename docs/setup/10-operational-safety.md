# Operational Safety Tools

This repo includes a read-only control-plane safety helper:

```text
scripts/control_plane.py
```

The first version is intentionally conservative. It validates config, detects scattered old installs, and prints rollback plans. It does not stop services, restart services, copy files, delete files, or modify systemd units.

## Commands

Validate the example configs:

```bash
python3 scripts/control_plane.py config validate
```

Validate real local configs:

```bash
python3 scripts/control_plane.py config validate \
  --agent-host-config modules/agent-host/config.json \
  --discord-config modules/discord-adapter/config.json \
  --host-ops-config modules/host-ops/host_ops.config.json \
  --strict
```

Print a machine-readable JSON report:

```bash
python3 scripts/control_plane.py config validate --json
```

Print a redacted config report:

```bash
python3 scripts/control_plane.py config print-redacted --json
```

Run a migration dry-run check:

```bash
python3 scripts/control_plane.py migrate check --dry-run
```

Print a rollback plan:

```bash
python3 scripts/control_plane.py migrate rollback --dry-run
```

The same commands are available through npm scripts:

```bash
npm run control-plane:validate
npm run control-plane:migrate-check
npm run test:control-plane
```

## What It Checks

Config validation checks:

```text
Agent Host bind host and port
Agent Host users and auth token shape
workspace alias safety
workspace paths
default_mode is included in allowed_modes
Discord token env names
Discord guild/channel/user mapping shape
command_prefix safety
Host Ops unit allowlist shape
Host Ops path aliases
secrets.env existence and chmod 600
```

Migration dry-run checks:

```text
old install paths:
  codex-bridge
  mattermpst_chat
  discord_agent_adapter
  host_ops
  codex-watchdog-vscode

user systemd unit files:
  agent-host-web.service
  discord-agent-adapter.service
```

Rollback plan prints the safe manual steps for reverting to old units. It is plan-only.

## Redaction Rules

Reports redact token-like values. They should not print:

```text
DISCORD_BOT_TOKEN values
AGENT_HOST_TOKEN values
Authorization: Bearer values
OpenAI keys
GitHub tokens
Discord bot token-looking values
```

The validator may show token length and a tiny prefix shape, but never the full token.

## Strict Mode

Example configs contain placeholder paths such as:

```text
/home/you/Documents/...
```

These produce warnings by default so a fresh clone can still run checks.

For real deployments, use:

```bash
--strict
```

In strict mode, missing local paths are errors.

## Safety Boundary

These commands are read-only.

They must not:

```text
stop services
restart services
delete files
modify systemd units
edit config files
change secrets
start training jobs
push/pull/merge/rebase/reset git state
```

Future migration commands may add backup or switch behavior, but they should remain dry-run first and require explicit human approval before changing live services.

## Batch B: Health, Result Pages, Thread Repair

The Agent Host also exposes safe read-only operational endpoints:

```text
GET /health
GET /health/summary
POST /codex/result-page
GET /codex/result-page
```

`/health` stays public and only returns a minimal liveness response.

`/health/summary` requires Bearer auth and returns a safe summary:

```text
Agent Host active/version
workspace aliases and modes
recent task counts
active task count
latest terminal task
```

It does not expose raw Host Ops output, shell output, tokens, or real workspace paths.

`/codex/result-page` requires Bearer auth and returns one page of a safe result:

```json
{
  "task_id": "task_...",
  "page": 1,
  "page_size": 1800,
  "total_pages": 3,
  "has_next": true,
  "raw": false,
  "text": "..."
}
```

Discord Adapter exposes these through prefixed slash commands:

```text
/agent_health
/agent_task_page task_id:<task_id> page:<n>
```

If `command_prefix` is `server_agent`, the commands become:

```text
/server_agent_health
/server_agent_task_page
```

Completion watcher behavior:

```text
pending task thread -> terminal task -> send completion once -> mark notified_done
stale terminal thread without notification -> send missed notification once -> mark repaired_at
```

This repair behavior is idempotent. It should not repost completion repeatedly.
