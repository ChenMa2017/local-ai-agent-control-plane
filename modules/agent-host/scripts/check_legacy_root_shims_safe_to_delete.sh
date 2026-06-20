#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$AGENT_HOST_DIR" rev-parse --show-toplevel)"
LEGACY_DIR="$AGENT_HOST_DIR/legacy_root_shims"

if [ ! -d "$LEGACY_DIR" ]; then
  echo "legacy_root_shims folder is missing: $LEGACY_DIR" >&2
  exit 1
fi

echo "[1/3] Checking for legacy root shim imports in active code and tests..."
if rg -n \
  "^(import|from) (api_bridge_bindings|auth_policy|bridge_foundation|bridge_handler|bridge_runtime_bindings|codex_bridge_runtime|codex_execution_handlers|codex_runtime|codex_task_runtime_bindings|codex_tasking|config_loader|evidence_retrieval|execution_evaluation|experiment_contracts|health_bridge_bindings|health_summary|http_routes|hypothesis_state|intake_bridge_bindings|intake_preparation|intake_store|intake_views|operator_summary|post_run_artifacts|prepare_artifacts|prepare_flow|prepare_intent|prepared_context|project_research_sync|promotion_policy|request_contracts|research_assessment|research_fingerprints|research_objects|research_store|result_streaming|startup_runtime|stream_bridge_bindings|watchdog_bridge_bindings|watchdog_commands|web_ui)\b" \
  "$AGENT_HOST_DIR/tests" \
  "$AGENT_HOST_DIR/agent_host"
then
  echo
  echo "Found active imports that still rely on legacy root shim module names." >&2
  exit 2
fi

echo "[2/3] Running agent-host test suite..."
(
  cd "$AGENT_HOST_DIR"
  python3 -m unittest discover -s tests -q
)

echo "[3/3] Reporting result..."
echo
echo "PASS: From the repository-internal perspective, legacy_root_shims is no longer part of"
echo "the active implementation or test baseline. If you have no external/private scripts that"
echo "still import those old module names, you can manually delete:"
echo "  $LEGACY_DIR"
