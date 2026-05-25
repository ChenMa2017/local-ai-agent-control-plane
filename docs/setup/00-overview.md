# 00. Overview

The system is a local AI-Agent control plane:

```text
Discord / Web UI
  -> Agent Host API
  -> codex-bridge
  -> Codex CLI
  -> local workspaces
  -> safe result / logs / Discord task thread
```

The monorepo contains five modules:

```text
modules/codex-bridge
  Execution core for Codex tasks.

modules/agent-host
  Web UI and Agent Host API.

modules/discord-adapter
  Discord Gateway bot adapter.

modules/host-ops
  Read-only host status sensor.

modules/codex-watchdog-vscode
  Project watchdog / VSCode prototype.
```

Runtime state is local and must not be committed:

```text
config.json
.env
secrets.env
state/
logs/
.codex-bridge/
```

The root-level scripts are for the monorepo:

```bash
scripts/check_all.sh
scripts/install_user_services.sh
scripts/start_services.sh
scripts/stop_services.sh
scripts/status_services.sh
scripts/tail_logs.sh
```

The current GitHub repo contains code and examples only. Every machine must create its own local config and secrets.
