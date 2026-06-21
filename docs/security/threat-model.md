# Threat Model

This repository is a local-first Agent control plane for one machine or one trusted operator domain. It is not a multi-tenant hosted SaaS control plane.

## Intended Deployment

Expected deployment shape:

```text
trusted operator
  -> local Web UI / local Discord bot
  -> Agent Host API
  -> codex-bridge
  -> Codex CLI
  -> allowlisted local workspaces
```

Recommended exposure boundary:

```text
localhost
LAN/VPN inside a trusted operator network
SSH tunnel for individual operators
```

It should not be exposed as a public unauthenticated internet service.

## Assets To Protect

Important assets:

```text
local workspace files
task results and logs
Discord bot token
Agent Host token
Codex auth state
systemd user units
local machine path privacy
operator trust in task audit history
```

## Trust Boundaries

Trusted with constraints:

```text
repo source code
configured allowlisted workspaces
user-owned ~/.config/agent-host/secrets.env
systemd user services installed by the operator
```

Treated as untrusted or partially trusted:

```text
Discord message content
web request bodies
project-local watchdog settings
task prompts
Codex model output
workspace file content read by Codex
```

## Main Entry Points

Primary entry points:

```text
Discord slash commands / task requests
Agent Host HTTP endpoints
local config files
watchdog-generated project files
Codex CLI task execution
```

## Current Defenses

The current design already includes these controls:

```text
workspace alias allowlists instead of arbitrary raw paths
Bearer auth for protected Agent Host endpoints
safe-result and safe-log filtering
workspace-write audit artifacts
protected path policy reporting
workspace write lock for conflicting write tasks
read-only Host Ops design
secrets stored outside Git in ~/.config/agent-host/secrets.env
systemd EnvironmentFile instead of inlining tokens in unit files
```

## What This System Is Trying To Prevent

Primary misuse and failure cases:

```text
accidental exposure of private local paths
token leakage into logs or committed config
arbitrary path selection from external requests
silent workspace mutation without audit artifacts
concurrent write-task collisions in one workspace
turning host-ops into a general-purpose remote shell
```

## Residual Risks

Important current limits:

```text
workspace-write is still a bounded local trust feature, not a fully verified safe executor
protected path policy is strong audit and policy reporting, but not full OS sandbox isolation
single-node local operation is the intended model; distributed trust is out of scope
Discord and Web entrypoints still depend on correct local operator configuration
Codex model output can still propose risky actions and must remain policy-bounded
```

## Operator Requirements

Safe operating assumptions:

```text
keep services behind localhost, LAN/VPN, or SSH tunnel
protect ~/.config/agent-host/secrets.env with chmod 600
do not commit config.json, secrets.env, logs, or state artifacts
review workspace-write enablement deliberately
keep public docs free of private absolute paths and real tokens
```

## Next Hardening Priorities

The next engineering steps should focus on:

```text
git worktree isolated write-task execution
stronger protected-path prevention before task completion, not only post-run reporting
more explicit secret-source documentation and validation across modules
continued decomposition and test coverage for large critical files such as codex-bridge.js
```
