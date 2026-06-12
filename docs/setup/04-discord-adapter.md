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

If you want plain Discord replies inside bot-created task threads to create follow-up tasks automatically, also enable the bot's Message Content intent in the Discord Developer Portal. Slash commands work without it, but direct thread-reply follow-up does not.

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
/agent_health
/agent_workspaces
/agent_prepare
/agent_run
/agent_task
/agent_task_page
/agent_cancel
```

`/agent_run` creates a task thread and sends completion notification with safe result.

`/agent_prepare` is the structured clarification entrypoint. It persists Agent Host intake artifacts such as:

```text
INTENT_DRAFT
QUESTIONS
TASK_CONTRACT
TASKBOX_DRAFT
POLICY_PREFLIGHT
DECISION_GATE
```

If Agent Host says `DECISION_GATE.required=true`, keep the user in `/agent_prepare` follow-up turns until the missing experiment choices are resolved. Do not bypass that by sending the same vague experiment prompt directly to `/agent_run`.

Long safe replies are no longer adapter-truncated before sending. If a safe result is too long for one Discord message, the adapter splits it into ordered chunks such as:

```text
[1/N] ...
[2/N] ...
[3/N] ...
```

This chunking is used for slash-command replies, task-thread intro messages, completion notifications, and adapter-side error replies.
