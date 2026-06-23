# Secrets Contract

This repository is local-first and single-operator by default. Secret handling is intentionally simple, explicit, and outside Git.

## Source Of Truth

Service-level secrets for Agent Host and the Discord adapter should live in:

```text
~/.config/agent-host/secrets.env
```

This file is operator-owned and should be protected with:

```bash
chmod 600 ~/.config/agent-host/secrets.env
```

The checked-in systemd user units should load that file through:

```text
EnvironmentFile=%h/.config/agent-host/secrets.env
```

Inline secret-looking `Environment=` entries should not be committed into repo unit files.

## Required Service Secrets

For the default monorepo setup, the required keys are:

```text
DISCORD_BOT_TOKEN
DISCORD_GUILD_ID
AGENT_HOST_TOKEN
AGENT_HOST_ADMIN_TOKEN
```

These keys are referenced indirectly through config fields such as:

```text
agent_host.token_env
discord.bot_token_env
discord.guild_id_env
auth.token_env_map
```

Real token values must not be committed into `config.json`, example configs, unit files, docs, screenshots, or logs.

## Codex / OpenAI Auth

Codex or OpenAI auth material should not be embedded into repo config files.

Preferred sources:

```text
Codex CLI login state outside Git
operator shell environment for interactive sessions
project- or operator-local runtime home when explicitly documented
```

Avoid copying Codex/OpenAI credentials into:

```text
modules/agent-host/config.json
modules/discord-adapter/config.json
repo systemd unit files
public examples or docs
```

If an operator decides to export OpenAI-related keys into `secrets.env`, that is a conscious trust-domain choice. It increases the blast radius to every service that loads that file and should be treated as an accepted local-operator risk, not the default contract.

## GitHub Tokens

GitHub tokens are optional and should usually remain shell-scoped:

```text
temporary operator shell environment
explicit CI secret store
task-scoped runtime only when required
```

They are not required for normal Agent Host or Discord adapter startup.

## Rotation And Cleanup

Minimum operator expectations:

```text
rotate tokens outside Git
restart affected services after rotating service-level secrets
avoid sharing tokens through chat messages or shell history
remove obsolete local copies instead of leaving duplicate secret files
```

## Validation

Use the read-only validation helper:

```bash
python3 scripts/control_plane.py config validate
```

It checks:

```text
secrets.env permissions
missing expected secret keys
placeholder-like secret values
duplicate secret keys
repo systemd EnvironmentFile usage
inline secret-looking Environment= lines in repo unit files
```
