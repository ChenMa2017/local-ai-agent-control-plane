# Agent Rules

This monorepo contains the local AI-Agent control plane.

Safety rules:

- Do not commit secrets, `.env`, `config.json`, Discord tokens, Agent Host tokens, task logs, or runtime state.
- Do not expose `danger-full-access` through Discord or Web UI.
- Keep Discord and Web UI as adapters only. They must call Agent Host API and must not execute Codex directly.
- Keep Host Ops as a read-only sensor layer, not a remote shell.
- Treat `workspace-write` as auditable and bounded. Preserve write audit, protected path policy, and write lock behavior.
- Do not delete user project data or task artifacts unless explicitly asked.
