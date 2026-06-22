#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT/modules/host-ops"
python3 -m py_compile host_ops.py tests/test_host_ops.py
python3 -m unittest discover -s tests
