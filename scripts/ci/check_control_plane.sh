#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT"
python3 -m py_compile \
  scripts/control_plane.py \
  scripts/server_smoke_baseline.py \
  tests/test_control_plane.py \
  tests/test_server_smoke_baseline.py
python3 -m unittest tests/test_control_plane.py tests/test_server_smoke_baseline.py
