# Discord Agent Adapter

This is a thin Discord Gateway adapter for the local Agent Host API.

It does not execute Codex directly, does not read `task.json`, and does not know real workspace paths. It only calls:

```text
http://127.0.0.1:8787
```

## Commands

```text
/agent_status
/agent_workspaces
/agent_prepare [prompt] [workspace] [intake_id] [answers] [reference_task_id] [followup_task_id]
/agent_intake intake_id
/agent_run [prompt] [workspace] [reference_task_id] [intake_id]
/agent_task task_id
/agent_task_page task_id page
/agent_cancel task_id
```

In bot-created task threads, a plain Discord reply to a bot task message can also create a follow-up task automatically. The adapter resolves `reference_task_id` from the replied bot message, so you do not need to copy/paste task ids by hand.

## Setup

Create a Discord Application and Bot in the Discord Developer Portal.

Enable the bot in your target server with the `applications.commands` scope and bot permissions needed to receive slash commands. For local development, keep the Agent Host bound to `127.0.0.1`; this bot uses Discord Gateway and does not need a public inbound webhook.

If you want the direct-reply follow-up flow inside task threads, also enable the bot's Message Content intent in the Discord Developer Portal. Slash commands continue to work without it, but plain-text thread replies need message content delivery.

Install dependencies:

```bash
cd $HOME/Documents/My_App_Dev/discord_agent_adapter
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt
```

Create config:

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "agent_host": {
    "base_url": "http://127.0.0.1:8787",
    "token_env": "AGENT_HOST_TOKEN"
  },
  "discord": {
    "allowed_guild_ids": ["1234567890"],
    "allowed_channel_ids": ["2345678901"],
    "default_workspace": "main_codex",
    "command_prefix": "agent",
    "users": {
      "3456789012": {
        "internal_user": "chenma",
        "role": "admin"
      }
    }
  }
}
```

`command_prefix` controls the slash command namespace. Discord slash commands are not isolated per channel, so multiple bots in the same guild should use different prefixes.

The person who pulls this repo does **not** have to keep your prefix. Each machine should choose its own short, stable prefix, for example:

```json
{
  "discord": {
    "command_prefix": "thinkpad_agent"
  }
}
```

Recommended pattern:

```text
<machine_or_host>_agent
```

Examples:

```text
thinkpad_agent
a6000_agent
server_agent
macmini_agent
```

That produces commands like `/thinkpad_agent_run`, `/a6000_agent_status`, and `/server_agent_task`. Channel allowlists still protect execution, but they do not hide commands from Discord's slash command picker.

If several teammates test in the same Discord server, each machine should set its own:

```text
- Discord Application / Bot
- command_prefix
- Agent Host token
```

This keeps command names readable and avoids cross-machine collisions in the slash-command picker.

Preferred local secret source:

```bash
mkdir -p ~/.config/agent-host
nano ~/.config/agent-host/secrets.env
chmod 600 ~/.config/agent-host/secrets.env
```

Example:

```bash
DISCORD_BOT_TOKEN=your-discord-bot-token
DISCORD_GUILD_ID=your-test-guild-id
AGENT_HOST_TOKEN=your-agent-host-token
```

For an interactive shell session, load the same file instead of creating a second secret source:

```bash
set -a
. ~/.config/agent-host/secrets.env
set +a
```

Start the Agent Host first:

```bash
cd $HOME/Documents/My_App_Dev/mattermpst_chat
./watchdog_bridge.sh status
```

Check the adapter configuration before starting the bot:

```bash
cd $HOME/Documents/My_App_Dev/discord_agent_adapter
python3 bot.py --config config.json --check-config
```

This command verifies:

```text
DISCORD_BOT_TOKEN is present, without printing it
DISCORD_GUILD_ID is present
AGENT_HOST_TOKEN is present, without printing it
allowed_guild_ids / allowed_channel_ids / users are nonempty
Agent Host /health is reachable
/codex/capabilities works
/codex/workspaces works and does not expose local paths
```

Then start the bot:

```bash
cd $HOME/Documents/My_App_Dev/discord_agent_adapter
python3 bot.py --config config.json
```

The bot logs must not contain `DISCORD_BOT_TOKEN`, `AGENT_HOST_TOKEN`, or local paths such as
`$HOME/Documents/My_App_Dev/...`.

## Long-Running Service Mode

The recommended long-running setup is managed from the Agent Host project:

```bash
cd $HOME/Documents/My_App_Dev/mattermpst_chat
scripts/install_user_services.sh
```

The Discord service template is:

```text
$HOME/Documents/My_App_Dev/discord_agent_adapter/systemd/user/discord-agent-adapter.service
```

It loads secrets from:

```text
~/.config/agent-host/secrets.env
```

Real tokens should not be written into the systemd unit. The local secrets file should be protected:

```bash
chmod 600 ~/.config/agent-host/secrets.env
```

Useful commands:

```bash
systemctl --user status discord-agent-adapter.service
systemctl --user restart discord-agent-adapter.service
journalctl --user -u discord-agent-adapter.service -f
```

The bot still uses Discord Gateway only. It does not expose a public HTTP endpoint.

## Security Boundary

Discord is only the message entrance:

```text
Discord Bot
  -> Agent Host API
  -> codex-bridge core
  -> codex exec
```

The adapter must not:

- run `codex exec`;
- run shell commands for user prompts;
- read `.codex-bridge/tasks/*/task.json`;
- read raw `result.md` or raw logs;
- expose the Agent Host bearer token in Discord messages or logs;
- bypass Agent Host auth, workspace allowlists, safe output, cancel, timeout, or task ownership checks.

The adapter checks Discord-side allowlists first:

```text
guild_id
channel_id
discord user_id
prompt length
```

The Agent Host remains the final authority for:

```text
token auth
workspace allowlist
workspace mode
task registry
safe result/logs
cancel/timeout
idempotency
```

## Command Mapping

`/<prefix>_prepare` is the intake/clarification entrypoint. It does not execute Codex directly. Instead it asks Agent Host to persist:

```text
INTENT_DRAFT
QUESTIONS
TASK_CONTRACT
TASKBOX_DRAFT
POLICY_PREFLIGHT
DECISION_GATE
EVIDENCE_RETRIEVAL
READ_PLAN
```

If clarification is still needed, the adapter returns the generated questions plus an `intake_id`. A later `/<prefix>_prepare` call can continue the same intake by sending that `intake_id` with `answers`.

`followup_task_id` is also optional on `/<prefix>_prepare`. When present, the adapter can omit `prompt` and let Agent Host seed a fresh intake from the latest `FOLLOWUP_TASK_DRAFT` attached to that finished task. Inside a bot-created task thread, calling `/<prefix>_prepare` with no prompt or intake id now falls back to that thread's latest task id as the follow-up seed.

When that seeded follow-up also has post-run context such as `execution_evaluation`, `ledger_note_draft`, `review_proposal_draft`, or `operator_summary`, the adapter now surfaces a short summary in the prepare reply. This helps the user see whether they are continuing a normal review loop, a stale-claim review, or a policy-review handoff.

`/<prefix>_intake intake_id:...` is the read-only way to reopen a saved intake bundle from Discord. It shows the current `status / objective / preflight / questions`, and when available it also includes `operator_summary`, `execution_evaluation`, `followup_task_draft`, `ledger_note_draft`, and `review_proposal_draft`.

When Agent Host also performs metadata-first evidence retrieval, the prepare response now surfaces the retrieval `decision`, any warnings, and a short `read_plan` summary directly in Discord. This lets the user see whether the request looks like a safe-to-answer conclusion, a stale conclusion, or an auxiliary-only match before turning it into `/run`.

If the request looks like a real experiment and Agent Host marks `DECISION_GATE.required=true`, keep the user in the `/prepare` loop until the missing experiment decisions are clarified. The adapter should not bypass that gate by turning the same vague request into `/run`.

`/<prefix>_run workspace:grokking prompt:"..."` becomes a Codex task request. With the default prefix this is `/agent_run`. If `workspace` is omitted, the adapter uses `discord.default_workspace`, usually `main_codex`. The adapter asks the Agent Host for the selected workspace's default mode and sends that mode with the run request. For example, a normal project may be `readonly`, while the main coordination workspace can be `workspace-write`.

`intake_id` is also optional on `/<prefix>_run`. When present, the adapter can omit `prompt` and let Agent Host continue the prepared intake directly. That path reuses the stored `TASK_CONTRACT`, `POLICY_PREFLIGHT`, and evidence `READ_PLAN`, so a user can go from `/prepare` to `/run` without retyping the original request.

`reference_task_id` is optional. When provided, the new task becomes a follow-up to a previous task. The Agent Host checks that the authenticated user can access the referenced task, and `codex-bridge` injects only the previous task's safe result excerpt into the new Codex prompt. If `/agent_run` is used inside a bot-created task thread and `reference_task_id` is omitted, the adapter uses that thread's current task as the reference.

When a prepared run later finishes and Agent Host returns `operator_summary` and `execution_evaluation` inside `/codex/result`, the adapter now surfaces both the aggregated operator state and the execution summary in task replies and completion notifications. Users can see whether the result is ready for review, needs log inspection, or stopped on a policy boundary without opening the intake directory by hand.

If Agent Host also returns `followup_task_draft`, the adapter now shows that draft's title and recommended next action in the same reply. This keeps the user in a structured `/prepare -> /run -> /prepare` loop instead of forcing them to invent the next prompt from memory.

If Agent Host also returns `ledger_note_draft` or `review_proposal_draft`, the adapter surfaces those summaries in the same task reply / completion message. This gives the user an immediate hint that the result is ready to be turned into a bounded ledger note, or that a human/policy review bundle should be handled before any retry or claim promotion.

The same rule now applies to `/<prefix>_task_page` page 1 for long results: the first paged reply can still show operator / evaluation / follow-up / review summaries before the first safe-result slice, so paging does not erase the structured next-step context.

If you reply directly to a bot-authored task message inside a bot-created task thread, the adapter treats that reply as a follow-up task request in the same thread. It tries to resolve `reference_task_id` from the replied bot message first, then falls back to the thread's latest known task. This makes the thread behave more like an email chain:

```text
bot completion message
  └─ your Discord reply
       -> new task in same thread
       -> reference_task_id automatically set
```

This reply flow is intentionally narrow:

```text
- only inside bot-created task threads
- only for allowlisted users
- only when replying to a bot task message
- still routed through Agent Host API and normal safety checks
```

```json
{
  "workspace": "grokking",
  "mode": "<workspace default mode>",
  "prompt": "...",
  "reference_task_id": "task_20260525_120000_abcdef",
  "source": "discord",
  "source_user_id": "<discord user id>",
  "source_channel_id": "<discord channel id>",
  "source_message_id": "<discord interaction id>",
  "idempotency_key": "discord:<discord interaction id>",
  "metadata": {
    "guild_id": "<discord guild id>",
    "command": "/<prefix>_run"
  }
}
```

The internal user identity is not accepted from Discord request bodies. It is controlled by the Agent Host token and local allowlists.

## Task Threads And Completion Notifications

`/<prefix>_run` now creates a Discord task thread when channel permissions allow it. The main command response stays short and includes the `task_id`, workspace, status, optional reference task, and thread reference. The thread receives a task summary with the prompt preview, workspace, selected workspace mode, and optional `reference_task_id`.

The adapter stores Discord-only thread mappings in:

```text
state/task_threads.json
```

This file maps `task_id` to Discord `guild_id`, `channel_id`, `thread_id`, workspace, last known status, and notification state. It is runtime state and should not be committed. The adapter still does not read Agent Host task files or `codex-bridge` artifacts directly.

A background watcher polls the Agent Host API on `watcher_interval_seconds` and sends one completion notification to the task thread when a task reaches:

```text
done
failed
cancelled
timeout
stale
policy_violation
```

For `done` and `policy_violation`, the notification uses the default safe result from `/codex/result` and sends it through Discord chunking instead of pre-truncating it inside the adapter. `policy_violation` is how `codex-bridge` reports a workspace-write task that touched a protected path policy. For other terminal states, it sends a short safe status summary. Raw results and raw logs are never posted to Discord.

If a Discord message would be too long, the adapter now splits it into ordered chunks such as:

```text
[1/N] ...
[2/N] ...
[3/N] ...
```

This chunking is used for:

```text
- task-thread completion notifications
- thread intro messages
- slash-command responses
- adapter error replies
```

So long safe replies stay readable inside Discord instead of being hard-cut at one message boundary. `/agent_task` and completion notifications now fetch the full safe result and let the adapter split it into ordered `[1/N]`, `[2/N]` chunks automatically.

If a task is `workspace-write`, the main response and task thread note that write audit is enabled. The completion result includes the safe `Write Summary` generated by `codex-bridge`, including changed file count and protected path status.

Optional config:

```json
{
  "state_dir": "state",
  "watcher_interval_seconds": 10
}
```

## Tests

```bash
python3 -m unittest discover -s tests
```
