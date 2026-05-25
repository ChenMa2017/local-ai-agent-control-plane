#!/usr/bin/env bash
set -euo pipefail

systemctl --user status --no-pager agent-host-web.service discord-agent-adapter.service
