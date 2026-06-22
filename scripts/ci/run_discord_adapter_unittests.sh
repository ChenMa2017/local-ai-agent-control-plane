#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
LOG_FILE="$(mktemp)"

cleanup() {
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

cd "$ROOT/modules/discord-adapter"

set +e
"$PYTHON_BIN" -m unittest discover -s tests -v 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}
set -e

if [[ $status -ne 0 && "${GITHUB_ACTIONS:-}" == "true" ]]; then
  "$PYTHON_BIN" - <<'PY' "$LOG_FILE"
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace")
tail = "\n".join(text.strip().splitlines()[-80:]) or "discord-adapter unittest failed without captured output"
tail = tail.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
print(f"::error title=discord-adapter unittest failed::{tail}")
PY
fi

exit "$status"
