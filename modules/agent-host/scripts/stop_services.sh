#!/usr/bin/env bash
set -euo pipefail

systemctl --user stop discord-agent-adapter.service
systemctl --user stop agent-host-web.service
systemctl --user status --no-pager agent-host-web.service discord-agent-adapter.service || true
