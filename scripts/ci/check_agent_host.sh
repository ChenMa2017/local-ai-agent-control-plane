#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT/modules/agent-host"
python3 -m compileall -q bridge.py agent_host tests
python3 -m unittest discover -s tests
