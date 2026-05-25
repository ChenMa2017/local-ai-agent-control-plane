#!/usr/bin/env bash
set -euo pipefail

systemctl --user stop discord-agent-adapter.service
systemctl --user stop agent-host-web.service
