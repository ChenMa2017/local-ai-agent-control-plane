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
configured auth.token_env_map principals in agent-host config
operator-owned Codex CLI auth state outside Git
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
discord adapter token lookup by *_env indirection
agent-host auth.token_env_map support for env-backed bearer tokens
read-only control-plane validation for secret placeholders, duplicate keys, and repo EnvironmentFile checks
```

The detailed secret-source contract lives in:

```text
docs/security/secrets-contract.md
```

## Runtime and Interface Boundaries

Current boundary expectations:

```text
Discord and Web UI are adapters only; they call Agent Host and do not execute Codex directly
Agent Host is the policy and audit gateway for task creation, status, results, and workspace selection
codex-bridge owns task process lifecycle, finalization, reconciliation, and workspace-write audit artifacts
watchdog-generated current conclusions are not trusted by default; runner/evaluator boundaries must stay explicit
```

Task lifecycle hardening now specifically relies on:

```text
finalization ownership
abandoned-finalization recovery
workspace-write lock and write-summary artifacts
safe/public result shaping for adapter-facing responses
```

## Workspace Isolation Modes

The system currently supports two practical workspace execution shapes:

```text
direct workspace execution:
  Codex runs against the configured project root directly

git worktree isolated execution:
  Codex writes into an isolated worktree for bounded write tasks
```

Security posture difference:

```text
direct workspace execution is simpler but relies more heavily on allowlists, protected-path policy, and audit review
git worktree isolation reduces accidental mutation scope and is preferred for higher-risk write flows
```

## Adapter Privacy Contract

Adapter-facing responses should follow these privacy rules:

```text
Discord and Web UI should expose workspace aliases, modes, and safe summaries
they should not expose absolute local paths
they should not expose raw tokens, bearer headers, or Codex auth material
raw=true style responses must remain policy-bounded and not be reachable through Discord
```

This contract is currently enforced through safe output shaping, path redaction, and adapter-side validation such as the Discord `/codex/workspaces` path-leak checks.

## CI and Server Smoke Boundary

Repository CI is intended to prove:

```text
syntax correctness
unit and component behavior
task lifecycle regressions
adapter formatting and privacy regressions
```

Repository CI is not intended to prove:

```text
real Codex login state
real Discord gateway behavior
systemd installation health on one operator machine
real workspace permissions on the deployment host
GPU-backed or long-duration experiments
```

Those checks belong to a server-side smoke baseline run in a trusted operator environment.

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
putting extra shell-scoped credentials into shared secrets.env increases blast radius across local services
```

## Operator Requirements

Safe operating assumptions:

```text
keep services behind localhost, LAN/VPN, or SSH tunnel
protect ~/.config/agent-host/secrets.env with chmod 600
do not commit config.json, secrets.env, logs, or state artifacts
keep Agent Host / Discord startup secrets in EnvironmentFile, but keep optional GitHub or Codex/OpenAI credentials shell-scoped unless there is an explicit local need
review workspace-write enablement deliberately
keep public docs free of private absolute paths and real tokens
```

## Next Hardening Priorities

The next engineering steps should focus on:

```text
fixed-clock watchdog test support instead of date-drift-prone fixtures
single-operator server smoke baseline covering systemd -> agent-host -> adapter -> codex task -> audit -> cleanup
continued secret-source validation around EnvironmentFile and auth.token_env_map usage
operator-facing secrets contract and rotation guidance
additional operator-facing documentation for accepted residual risks and recovery steps
```
