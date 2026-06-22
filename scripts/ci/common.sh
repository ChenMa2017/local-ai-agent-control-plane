#!/usr/bin/env bash

ci_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

discord_adapter_python_bin() {
  local root
  root="${1:-$(ci_repo_root)}"

  if [[ -n "${PYTHON_BIN:-}" ]]; then
    printf '%s\n' "$PYTHON_BIN"
    return
  fi

  if [[ -x "$root/modules/discord-adapter/.venv/bin/python" ]]; then
    printf '%s\n' "$root/modules/discord-adapter/.venv/bin/python"
    return
  fi

  printf 'python3\n'
}
