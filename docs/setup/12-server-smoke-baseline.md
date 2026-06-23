# 12. Server Smoke Baseline

Use this after:

- local configs are in place;
- `~/.config/agent-host/secrets.env` exists;
- `scripts/start_services.sh` has already started the user services.

## Command

From the monorepo root:

```bash
python3 scripts/server_smoke_baseline.py
```

## What It Checks

The script is meant to prove the real local control path, not just unit tests.

It performs:

```text
control-plane config validation
systemd user service activity check
GET /health
GET /whoami
GET /health/summary
GET /codex/workspaces
POST /codex/prepare
POST /codex/run
GET /codex/tasks polling until terminal
GET /codex/status
GET /codex/result-page
GET /codex/intake
```

## Safety Defaults

If you do not specify a workspace, the script prefers a visible `readonly` workspace first.

That makes the default smoke path safer on machines where the main adapter default is still a `workspace-write` workspace.

## Useful Variants

Force a specific workspace:

```bash
python3 scripts/server_smoke_baseline.py --workspace main_codex
```

Use a dry-run receipt instead of a real task execution:

```bash
python3 scripts/server_smoke_baseline.py --dry-run
```

Skip Discord service activity if you only want to validate the web/API side:

```bash
python3 scripts/server_smoke_baseline.py --skip-discord-service-check
```

Print machine-readable output:

```bash
python3 scripts/server_smoke_baseline.py --json
```
