#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "discord" ]]; then
  journalctl --user -u discord-agent-adapter.service -f
elif [[ "${1:-}" == "agent" ]]; then
  journalctl --user -u agent-host-web.service -f
else
  journalctl --user -u agent-host-web.service -u discord-agent-adapter.service -f
fi
