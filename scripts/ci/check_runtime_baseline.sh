#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

readonly NODE_MIN_MAJOR=12
readonly NODE_MIN_MINOR=22
readonly NODE_MIN_PATCH=0
readonly NODE_RECOMMENDED_MAJOR=20
readonly PYTHON_MIN_MAJOR=3
readonly PYTHON_MIN_MINOR=10

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
}

parse_node_version_fields() {
  local version_text="$1"
  local parsed

  parsed="$(printf '%s\n' "$version_text" | sed -E 's/^v([0-9]+)\.([0-9]+)\.([0-9]+).*/\1 \2 \3/')"
  [[ "$parsed" =~ ^[0-9]+\ [0-9]+\ [0-9]+$ ]] || fail "unable to parse Node.js version: $version_text"
  printf '%s\n' "$parsed"
}

python_version_fields() {
  python3 - <<'PY'
import sys
print(sys.version_info.major, sys.version_info.minor, sys.version_info.micro)
PY
}

require_command node
require_command npm
require_command python3
require_command git

cd "$ROOT"

node_version_raw="$(node --version)"
read -r node_major node_minor node_patch <<<"$(parse_node_version_fields "$node_version_raw")"

if (( node_major < NODE_MIN_MAJOR )) || \
  (( node_major == NODE_MIN_MAJOR && node_minor < NODE_MIN_MINOR )) || \
  (( node_major == NODE_MIN_MAJOR && node_minor == NODE_MIN_MINOR && node_patch < NODE_MIN_PATCH )); then
  fail "Node.js ${node_version_raw} is below the supported repository legacy floor ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}.${NODE_MIN_PATCH}"
fi

read -r python_major python_minor python_patch <<<"$(python_version_fields)"

if (( python_major < PYTHON_MIN_MAJOR )) || (( python_major == PYTHON_MIN_MAJOR && python_minor < PYTHON_MIN_MINOR )); then
  fail "Python ${python_major}.${python_minor}.${python_patch} is below the supported repository minimum ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}"
fi

npm_version_raw="$(npm --version)"
git_version_raw="$(git --version)"

printf 'Runtime baseline OK\n'
printf '  Node.js: %s (legacy compatibility floor: %s.%s.%s, recommended local/CI baseline: %s.x)\n' \
  "$node_version_raw" \
  "$NODE_MIN_MAJOR" \
  "$NODE_MIN_MINOR" \
  "$NODE_MIN_PATCH" \
  "$NODE_RECOMMENDED_MAJOR"
printf '  Python: %s.%s.%s (minimum supported: %s.%s, CI baseline: %s.%s)\n' \
  "$python_major" \
  "$python_minor" \
  "$python_patch" \
  "$PYTHON_MIN_MAJOR" \
  "$PYTHON_MIN_MINOR" \
  "$PYTHON_MIN_MAJOR" \
  "$PYTHON_MIN_MINOR"
printf '  npm: %s\n' "$npm_version_raw"
printf '  git: %s\n' "$git_version_raw"

if (( node_major < NODE_RECOMMENDED_MAJOR )); then
  printf 'NOTE: Node.js %s satisfies the current legacy compatibility floor, but 20.x remains the recommended local development baseline.\n' "$node_version_raw"
fi

printf '%s\n' \
  'Legacy note: selected codex-bridge/watchdog runtime paths intentionally remain Node 12.22-compatible for older server installs, but Node 12 is EOL and should be treated as a temporary compatibility floor rather than the long-term development target.'
