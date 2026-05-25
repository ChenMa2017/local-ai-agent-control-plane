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
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane/modules/agent-host
cp config.example.json config.json
```

Edit `config.json`.

Recommended workspaces:

```json
{
  "projects": {
    "main_codex": {
      "path": "$HOME/Documents/My_AI_Agent",
      "default_mode": "workspace-write",
      "allowed_modes": ["workspace-write"]
    },
    "grokking": {
      "path": "$HOME/Documents/My_AI_Agent/watchdog_demo_Grokking",
      "default_mode": "readonly",
      "allowed_modes": ["readonly"]
    }
  }
}
```

Set `codex_bridge_root`:

```json
"codex_bridge_root": "$HOME/Documents/My_App_Dev/local-ai-agent-control-plane/modules/codex-bridge"
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

Do not bind to `0.0.0.0` until authentication, tokens, and remote access policy are reviewed.
