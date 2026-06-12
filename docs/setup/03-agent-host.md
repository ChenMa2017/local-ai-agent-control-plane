# 03. Agent Host Setup

Path:

```text
modules/agent-host
```

Purpose:

```text
Local Web UI and unified Agent Host API on 127.0.0.1:8787.
```

Create config:

```bash
cd "$CONTROL_PLANE_ROOT/modules/agent-host"
cp config.example.json config.json
```

Edit `config.json`.

Recommended workspaces:

```json
{
  "projects": {
    "main_codex": {
      "path": "$PROJECT_ROOT",
      "default_mode": "workspace-write",
      "allowed_modes": ["workspace-write"]
    },
    "grokking": {
      "path": "$PROJECT_ROOT/watchdog_demo_Grokking",
      "default_mode": "readonly",
      "allowed_modes": ["readonly"]
    }
  }
}
```

Set `codex_bridge_root`:

```json
"codex_bridge_root": "$CONTROL_PLANE_ROOT/modules/codex-bridge"
```

Add auth tokens in `config.json`:

```json
"auth": {
  "tokens": {
    "replace-with-codex-web-token": {
      "user": "chenma",
      "role": "admin"
    },
    "replace-with-discord-adapter-token": {
      "user": "chenma",
      "role": "user"
    }
  }
}
```

Check config:

```bash
python3 bridge.py --config config.json --check-config
```

Run manually:

```bash
python3 bridge.py --config config.json
```

Open:

```text
http://127.0.0.1:8787/
```

Useful API checks:

```bash
curl http://127.0.0.1:8787/health
curl -H "Authorization: Bearer $AGENT_HOST_TOKEN" http://127.0.0.1:8787/codex/workspaces
curl -H "Authorization: Bearer $AGENT_HOST_TOKEN" http://127.0.0.1:8787/codex/capabilities
```

Prepare intake is now a first-class API:

```bash
curl -X POST http://127.0.0.1:8787/codex/prepare \
  -H "Authorization: Bearer $AGENT_HOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"main_codex","prompt":"请先帮我定义一个 bounded CPU baseline experiment"}'
```

That endpoint can persist:

```text
INTENT_DRAFT
GRAY_AREAS
QUESTIONS
TASK_CONTRACT
TASKBOX_DRAFT
POLICY_PREFLIGHT
DECISION_GATE
```

If the request still lacks experiment-defining decisions such as a control meaning, fairness constraint, or success criterion, the API should stop at clarification instead of routing a vague prompt straight to execution.

Do not bind to `0.0.0.0` until authentication, tokens, and remote access policy are reviewed.
