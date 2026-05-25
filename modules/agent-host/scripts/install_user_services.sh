#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="/home/chenma/Documents/My_App_Dev"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
SECRETS_DIR="${HOME}/.config/agent-host"

mkdir -p "$USER_SYSTEMD_DIR" "$SECRETS_DIR"

install -m 0644 "$ROOT_DIR/systemd/user/agent-host-web.service" \
  "$USER_SYSTEMD_DIR/agent-host-web.service"
install -m 0644 "$APP_ROOT/discord_agent_adapter/systemd/user/discord-agent-adapter.service" \
  "$USER_SYSTEMD_DIR/discord-agent-adapter.service"

if [ ! -f "$SECRETS_DIR/secrets.env" ]; then
  install -m 0600 "$ROOT_DIR/secrets.env.example" "$SECRETS_DIR/secrets.env"
  echo "Created $SECRETS_DIR/secrets.env from example. Edit it with real secret values before starting services."
else
  chmod 600 "$SECRETS_DIR/secrets.env"
fi

systemctl --user daemon-reload
systemctl --user enable agent-host-web.service discord-agent-adapter.service

cat <<EOF
Installed user services:
  agent-host-web.service
  discord-agent-adapter.service

Next:
  nano $SECRETS_DIR/secrets.env
  $ROOT_DIR/scripts/check_all.sh
  $ROOT_DIR/scripts/start_services.sh
EOF
