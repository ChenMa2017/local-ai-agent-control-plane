#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ROOT="${VSCODE_EXTENSIONS:-$HOME/.vscode-server/extensions}"

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    NODE_BIN="$(find "$HOME/.vscode-server/bin" -path '*/node' -type f -executable 2>/dev/null | head -1)"
  fi
fi

if [ -n "$NODE_BIN" ]; then
  NAME="$("$NODE_BIN" -e 'const p=require(process.argv[1]); console.log(p.name)' "$SRC/package.json")"
  VERSION="$("$NODE_BIN" -e 'const p=require(process.argv[1]); console.log(p.version)' "$SRC/package.json")"
  PUBLISHER="$("$NODE_BIN" -e 'const p=require(process.argv[1]); console.log(p.publisher)' "$SRC/package.json")"
else
  NAME="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)"
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)"
  PUBLISHER="$(sed -n 's/.*"publisher"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)"
fi

if [ -z "${NAME:-}" ] || [ -z "${VERSION:-}" ] || [ -z "${PUBLISHER:-}" ]; then
  echo "Could not read name/version/publisher from package.json" >&2
  exit 1
fi

if [[ ! "$NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || [[ ! "$PUBLISHER" =~ ^[A-Za-z0-9_.-]+$ ]] || [[ ! "$VERSION" =~ ^[A-Za-z0-9_.+-]+$ ]]; then
  echo "Unsafe package metadata in package.json" >&2
  exit 1
fi

DEST="$DEST_ROOT/${PUBLISHER}.${NAME}-${VERSION}"

rm -rf "$DEST"
mkdir -p "$DEST"
mkdir -p "$DEST/scripts"
cp "$SRC/package.json" "$DEST/package.json"
cp "$SRC/extension.js" "$DEST/extension.js"
cp "$SRC/README.md" "$DEST/README.md"
cp "$SRC/REVIEW_BRIEF.md" "$DEST/REVIEW_BRIEF.md"
cp "$SRC/scripts/install-local.sh" "$DEST/scripts/install-local.sh"
cp "$SRC/scripts/package-local.js" "$DEST/scripts/package-local.js"
cp "$SRC/scripts/package-local.sh" "$DEST/scripts/package-local.sh"

echo "Installed Codex Watchdog extension to:"
echo "  $DEST"
echo
echo "Reload the VSCode Remote window, then open the Command Palette and run:"
echo "  Codex Watchdog: Open Control Panel"
