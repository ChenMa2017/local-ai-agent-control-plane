#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$USER_SYSTEMD_DIR"
cp "$ROOT/systemd/user/agent-host-web.service" "$USER_SYSTEMD_DIR/agent-host-web.service"
cp "$ROOT/systemd/user/discord-agent-adapter.service" "$USER_SYSTEMD_DIR/discord-agent-adapter.service"

systemctl --user daemon-reload

echo "Installed user services:"
echo "  agent-host-web.service"
echo "  discord-agent-adapter.service"
echo
echo "Start with:"
echo "  systemctl --user start agent-host-web.service"
echo "  systemctl --user start discord-agent-adapter.service"
