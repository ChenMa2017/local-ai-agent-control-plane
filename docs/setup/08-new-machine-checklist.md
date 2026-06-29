# 08. New Machine Checklist

Use this when cloning the project onto another computer.

## 1. Clone

```bash
mkdir -p "$(dirname "$CONTROL_PLANE_ROOT")"
cd "$(dirname "$CONTROL_PLANE_ROOT")"
git clone git@github.com:<your-user>/<your-repo>.git "$(basename "$CONTROL_PLANE_ROOT")"
cd "$CONTROL_PLANE_ROOT"
```

## 2. Install prerequisites

```bash
node --version
npm --version
python3 --version
git --version
codex --version
```

Target baseline:

```text
Node.js 20.x recommended
Node.js 12.22.x is the current legacy compatibility floor
Python >= 3.10
Node 12 is legacy-only compatibility, not the long-term development baseline
```

## 3. Install module dependencies

```bash
cd modules/codex-bridge
npm install

cd ../codex-watchdog-vscode
npm install

cd ../discord-adapter
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## 4. Create local workspaces

```bash
mkdir -p "$PROJECT_ROOT"
```

Create or copy your project:

```text
$PROJECT_ROOT/watchdog_demo_Grokking
```

## 5. Configure Agent Host

```bash
cd "$CONTROL_PLANE_ROOT/modules/agent-host"
cp config.example.json config.json
nano config.json
```

Change paths and tokens for this machine.

## 6. Configure Discord Adapter

```bash
cd "$CONTROL_PLANE_ROOT/modules/discord-adapter"
cp config.example.json config.json
nano config.json
```

For each machine, prefer:

```text
independent Discord Application / Bot token
independent Agent Host token
unique command_prefix
machine-specific allowed_channel_ids
```

## 7. Create secrets

```bash
mkdir -p ~/.config/agent-host
nano ~/.config/agent-host/secrets.env
chmod 600 ~/.config/agent-host/secrets.env
```

## 8. Check

```bash
cd "$CONTROL_PLANE_ROOT"
scripts/check_all.sh
```

## 9. Run

Manual:

```bash
cd modules/agent-host
python3 bridge.py --config config.json
```

Systemd:

```bash
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane
scripts/install_user_services.sh
scripts/start_services.sh
```

## 10. Discord smoke test

```text
/agent_status
/agent_workspaces
/agent_run workspace:main_codex prompt:请只回复 OK，并说明当前 workspace 名称
```

## 11. Real server smoke baseline

After the services are up, run one real operator baseline from the monorepo root:

```bash
cd "$CONTROL_PLANE_ROOT"
python3 scripts/server_smoke_baseline.py
```

Notes:

```text
default behavior prefers a visible readonly workspace
it checks health / auth / prepare / run / tasks / status / result-page / intake
use --workspace <alias> if you want to force a specific workspace
use --dry-run if you only want the control path receipt
```
