#!/usr/bin/env bash
set -euo pipefail

systemctl --user start agent-host-web.service
systemctl --user start discord-agent-adapter.service
systemctl --user status --no-pager agent-host-web.service discord-agent-adapter.service
