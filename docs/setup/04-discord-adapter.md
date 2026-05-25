# 04. Discord Adapter Setup

Path:

```text
modules/discord-adapter
```

Purpose:

```text
Discord Gateway bot that calls Agent Host API.
```

It must not:

```text
execute codex directly
read task.json directly
know real workspace paths beyond aliases
bypass Agent Host permissions
```

Create Python environment:

```bash
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane/modules/discord-adapter
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Create config:

```bash
cp config.example.json config.json
```

Set:

```json
{
  "agent_host": {
    "base_url": "http://127.0.0.1:8787",
    "token_env": "AGENT_HOST_TOKEN"
  },
  "discord": {
    "bot_token_env": "DISCORD_BOT_TOKEN",
    "guild_id_env": "DISCORD_GUILD_ID",
    "allowed_guild_ids": ["your-guild-id"],
    "allowed_channel_ids": ["your-channel-id"],
    "default_workspace": "main_codex",
    "command_prefix": "agent",
    "users": {
      "your-discord-user-id": {
        "internal_user": "chenma",
        "role": "admin"
      }
    }
  }
}
```

For multiple machines in one Discord server, use different prefixes:

```text
thinkpad_agent
server_agent
laptop_agent
```

Check config:

```bash
set -a
. ~/.config/agent-host/secrets.env
set +a
. .venv/bin/activate
python3 bot.py --config config.json --check-config
```

Run manually:

```bash
python3 bot.py --config config.json
```

Discord commands:

```text
/agent_status
/agent_workspaces
/agent_run
/agent_task
/agent_cancel
```

`/agent_run` creates a task thread and sends completion notification with safe result.
