#!/usr/bin/env bash
set -euo pipefail

systemctl --user status agent-host-web.service --no-pager
systemctl --user status discord-agent-adapter.service --no-pager
