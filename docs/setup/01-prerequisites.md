# 01. Prerequisites

Install or confirm these tools:

```bash
node --version
npm --version
python3 --version
git --version
ssh -T git@github.com
codex --version
```

Expected:

```text
Node.js 20.x recommended for local development
Node.js 12.22.x is the current legacy compatibility floor
Python >= 3.10
Git configured with user.name and user.email
GitHub SSH key installed
Codex CLI installed and authenticated locally
```

Legacy server note:

```text
selected codex-bridge / watchdog runtime paths intentionally keep Node 12.22-compatible fallbacks
Node 12 is EOL and should be treated as a temporary compatibility floor, not the long-term development or CI baseline
```

Recommended directory layout:

```text
$CONTROL_PLANE_ROOT
$PROJECT_ROOT
$PROJECT_ROOT/watchdog_demo_Grokking
$COLLAB_ROOT
```

Create the main AI workspace if needed:

```bash
mkdir -p "$PROJECT_ROOT"
```

Secrets are stored outside the repo:

```bash
mkdir -p ~/.config/agent-host
nano ~/.config/agent-host/secrets.env
chmod 600 ~/.config/agent-host/secrets.env
```

Example:

```bash
DISCORD_BOT_TOKEN=replace-with-token
DISCORD_GUILD_ID=replace-with-guild-id
AGENT_HOST_TOKEN=replace-with-agent-host-token
AGENT_HOST_ADMIN_TOKEN=replace-with-agent-host-admin-token
```

Do not use `export` in `secrets.env`; systemd `EnvironmentFile` expects `KEY=value`.
