#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$ROOT_DIR" rev-parse --show-toplevel)"
LEGACY_DIR="$ROOT_DIR/legacy_root_shims"

mkdir -p "$LEGACY_DIR"

git -C "$REPO_ROOT" mv \
  "modules/agent-host/api_bridge_bindings.py" \
  "modules/agent-host/auth_policy.py" \
  "modules/agent-host/bridge_foundation.py" \
  "modules/agent-host/bridge_handler.py" \
  "modules/agent-host/bridge_runtime_bindings.py" \
  "modules/agent-host/codex_bridge_runtime.py" \
  "modules/agent-host/codex_execution_handlers.py" \
  "modules/agent-host/codex_runtime.py" \
  "modules/agent-host/codex_task_runtime_bindings.py" \
  "modules/agent-host/codex_tasking.py" \
  "modules/agent-host/config_loader.py" \
  "modules/agent-host/evidence_retrieval.py" \
  "modules/agent-host/execution_evaluation.py" \
  "modules/agent-host/experiment_contracts.py" \
  "modules/agent-host/health_bridge_bindings.py" \
  "modules/agent-host/health_summary.py" \
  "modules/agent-host/http_routes.py" \
  "modules/agent-host/hypothesis_state.py" \
  "modules/agent-host/intake_bridge_bindings.py" \
  "modules/agent-host/intake_preparation.py" \
  "modules/agent-host/intake_store.py" \
  "modules/agent-host/intake_views.py" \
  "modules/agent-host/operator_summary.py" \
  "modules/agent-host/post_run_artifacts.py" \
  "modules/agent-host/prepare_artifacts.py" \
  "modules/agent-host/prepare_flow.py" \
  "modules/agent-host/prepare_intent.py" \
  "modules/agent-host/prepared_context.py" \
  "modules/agent-host/project_research_sync.py" \
  "modules/agent-host/promotion_policy.py" \
  "modules/agent-host/request_contracts.py" \
  "modules/agent-host/research_assessment.py" \
  "modules/agent-host/research_fingerprints.py" \
  "modules/agent-host/research_objects.py" \
  "modules/agent-host/research_store.py" \
  "modules/agent-host/result_streaming.py" \
  "modules/agent-host/startup_runtime.py" \
  "modules/agent-host/stream_bridge_bindings.py" \
  "modules/agent-host/watchdog_bridge_bindings.py" \
  "modules/agent-host/watchdog_commands.py" \
  "modules/agent-host/web_ui.py" \
  "modules/agent-host/legacy_root_shims/"

echo "Moved root shim files into: $LEGACY_DIR"
echo "Next steps:"
echo "  1. Review git diff"
echo "  2. Update .vscode/settings.json if you no longer want exclude rules"
echo "  3. Run: cd \"$ROOT_DIR\" && python3 -m unittest discover -s tests -q"
