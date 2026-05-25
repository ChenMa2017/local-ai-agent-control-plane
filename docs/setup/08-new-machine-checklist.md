# 08. New Machine Checklist

Use this when cloning the project onto another computer.

## 1. Clone

```bash
cd $HOME/Documents/My_App_Dev
git clone git@github.com:ChenMa2017/local-ai-agent-control-plane.git
cd local-ai-agent-control-plane
```

## 2. Install prerequisites

```bash
node --version
npm --version
python3 --version
git --version
codex --version
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
mkdir -p $HOME/Documents/My_AI_Agent
```

Create or copy your project:

```text
$HOME/Documents/My_AI_Agent/watchdog_demo_Grokking
```

## 5. Configure Agent Host

```bash
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane/modules/agent-host
cp config.example.json config.json
nano config.json
```

Change paths and tokens for this machine.

## 6. Configure Discord Adapter

```bash
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane/modules/discord-adapter
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
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane
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
