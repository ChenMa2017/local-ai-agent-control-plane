#!/usr/bin/env bash
set -euo pipefail

systemctl --user start agent-host-web.service
systemctl --user start discord-agent-adapter.service
systemctl --user status agent-host-web.service --no-pager
systemctl --user status discord-agent-adapter.service --no-pager
