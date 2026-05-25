#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "web" ]; then
  exec journalctl --user -u agent-host-web.service -f
fi

if [ "${1:-}" = "discord" ]; then
  exec journalctl --user -u discord-agent-adapter.service -f
fi

exec journalctl --user -u agent-host-web.service -u discord-agent-adapter.service -f
