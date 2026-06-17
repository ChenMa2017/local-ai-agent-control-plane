"use strict";

const pythonValidateRuntimeTemplates = {
  validateRuntime: () => `#!/usr/bin/env python3
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(".")
OUT = ROOT / "agent" / "status" / "RUNTIME_VALIDATION.json"

VALID_SKILLS = {
    "watchdog-orchestrator",
    "watchdog-job-queue",
    "watchdog-gate-evaluator",
    "watchdog-report-curator",
    "watchdog-permission-guardian",
    "watchdog-handoff-writer",
    "watchdog-cleanup-auditor",
}
VALID_TASK_STATUS = {"pending", "queued", "running", "done", "failed", "rejected", "blocked"}
VALID_JOB_STATUS = {"queued", "running", "done", "failed", "cancelled"}
VALID_RUNNERS = {"cpu", "gpu", "report_only"}

errors = []
warnings = []

def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def load_json(path, required=False):
    p = ROOT / path
    if not p.exists():
        if required:
            errors.append(f"missing required JSON file: {path}")
        return None
    try:
        return json.loads(p.read_text())
    except Exception as exc:
        errors.append(f"invalid JSON in {path}: {exc}")
        return None

def require_type(value, expected, label):
    if not isinstance(value, expected):
        errors.append(f"{label} has wrong type")
        return False
    return True

def validate_state():
    state = load_json("agent/STATE.json", required=True)
    if not isinstance(state, dict):
        return
    if not isinstance(state.get("schema_version"), int):
        errors.append("agent/STATE.json schema_version must be an integer")
    if state.get("mode") not in {"observer", "project-local-worker", "gpu-queue-worker", "maintainer"}:
        errors.append("agent/STATE.json mode is invalid")
    if not isinstance(state.get("requires_review"), bool):
        errors.append("agent/STATE.json requires_review must be boolean")
    for key in ("updated_utc", "route_id", "route_epoch", "active_task_id", "route_task_id", "active_branch", "allowed_next_action", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status", "task_box_id", "owner_mode", "current_allowed_step", "project_question", "decision_relevance", "claim_scope", "diagnosis_target"):
        if key in state and state.get(key) is not None and not isinstance(state.get(key), str):
            errors.append(f"agent/STATE.json {key} must be string or null")
    for key in ("successor_contract_required", "experiment_decision_gate_required", "experiment_decision_gate_blocking", "derived_from_route_canonical"):
        if key in state and not isinstance(state.get(key), bool):
            errors.append(f"agent/STATE.json {key} must be boolean")
    if "important_paths" in state and not isinstance(state.get("important_paths"), list):
        errors.append("agent/STATE.json important_paths must be an array")
    tasks = state.get("tasks")
    if not isinstance(tasks, list):
        errors.append("agent/STATE.json tasks must be an array")
        return
    seen = set()
    active = []
    for idx, task in enumerate(tasks):
        label = f"agent/STATE.json tasks[{idx}]"
        if not isinstance(task, dict):
            errors.append(f"{label} must be an object")
            continue
        tid = task.get("task_id")
        if not isinstance(tid, str) or not tid.strip():
            errors.append(f"{label}.task_id must be a nonempty string")
        elif tid in seen:
            errors.append(f"duplicate task_id in STATE.json: {tid}")
        else:
            seen.add(tid)
        if task.get("status") not in VALID_TASK_STATUS:
            errors.append(f"{label}.status is invalid")
        if task.get("allowed_runner") not in VALID_RUNNERS:
            errors.append(f"{label}.allowed_runner is invalid")
        if task.get("status") in {"queued", "running"} and tid:
            active.append(tid)
    for tid in set(active):
        if active.count(tid) > 1:
            errors.append(f"task_id has multiple active STATE entries: {tid}")

def validate_progress():
    progress = load_json("agent/PROGRESS_STATE.json", required=True)
    if not isinstance(progress, dict):
        return
    if "no_progress_cycles" in progress and not isinstance(progress.get("no_progress_cycles"), int):
        errors.append("agent/PROGRESS_STATE.json no_progress_cycles must be integer")
    if "recommend_pause" in progress and not isinstance(progress.get("recommend_pause"), bool):
        errors.append("agent/PROGRESS_STATE.json recommend_pause must be boolean")
    if "route_epoch" in progress and progress.get("route_epoch") is not None and not isinstance(progress.get("route_epoch"), str):
        errors.append("agent/PROGRESS_STATE.json route_epoch must be string or null")
    for key in ("active_task_id", "route_task_id", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status", "owner_mode", "current_allowed_step"):
        if key in progress and progress.get(key) is not None and not isinstance(progress.get(key), str):
            errors.append(f"agent/PROGRESS_STATE.json {key} must be string or null")
    if "successor_contract_required" in progress and not isinstance(progress.get("successor_contract_required"), bool):
        errors.append("agent/PROGRESS_STATE.json successor_contract_required must be boolean")
    for key in ("experiment_decision_gate_required", "experiment_decision_gate_blocking"):
        if key in progress and not isinstance(progress.get(key), bool):
            errors.append(f"agent/PROGRESS_STATE.json {key} must be boolean")

def validate_task_box():
    task_box = load_json("agent/TASK_BOX.json", required=False)
    if task_box is None:
        return
    if not isinstance(task_box, dict):
        errors.append("agent/TASK_BOX.json must be an object")
        return
    tasks = task_box.get("tasks")
    if tasks is not None and not isinstance(tasks, list):
        errors.append("agent/TASK_BOX.json tasks must be an array")
    queue_policy = task_box.get("queue_policy")
    if queue_policy is not None and not isinstance(queue_policy, dict):
        errors.append("agent/TASK_BOX.json queue_policy must be an object")
    for key in (
        "project_question",
        "decision_relevance",
        "uncertainty_reduced_if_success",
        "uncertainty_reduced_if_failure",
        "claim_scope",
        "diagnosis_target",
        "current_conclusion_topic_id",
        "current_conclusion_query",
    ):
        if key in task_box and task_box.get(key) is not None and not isinstance(task_box.get(key), str):
            errors.append(f"agent/TASK_BOX.json {key} must be string or null")
    forbidden = task_box.get("forbidden_conclusions")
    if forbidden is not None and not isinstance(forbidden, list):
        errors.append("agent/TASK_BOX.json forbidden_conclusions must be an array")
    fair = task_box.get("fair_comparability")
    if fair is not None and not isinstance(fair, dict):
        errors.append("agent/TASK_BOX.json fair_comparability must be an object")
    voi = task_box.get("value_of_information")
    if voi is not None and not isinstance(voi, dict):
        errors.append("agent/TASK_BOX.json value_of_information must be an object")
    gate_policy = task_box.get("gate_policy")
    if gate_policy is not None and not isinstance(gate_policy, dict):
        errors.append("agent/TASK_BOX.json gate_policy must be an object")
    for key in ("owner_mode", "current_allowed_step", "active_task_id", "route_task_id", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status"):
        if key in task_box and task_box.get(key) is not None and not isinstance(task_box.get(key), str):
            errors.append(f"agent/TASK_BOX.json {key} must be string or null")
    for key in ("successor_contract_required", "experiment_decision_gate_required", "experiment_decision_gate_blocking"):
        if key in task_box and not isinstance(task_box.get(key), bool):
            errors.append(f"agent/TASK_BOX.json {key} must be boolean")

def validate_route_canonical():
    route = load_json("agent/ROUTE_CANONICAL.json", required=False)
    if route is None:
        return
    if not isinstance(route, dict):
        errors.append("agent/ROUTE_CANONICAL.json must be an object")
        return
    if "route_epoch" in route and route.get("route_epoch") is not None and not isinstance(route.get("route_epoch"), str):
        errors.append("agent/ROUTE_CANONICAL.json route_epoch must be string or null")
    if "owner_mode" in route and route.get("owner_mode") is not None and not isinstance(route.get("owner_mode"), str):
        errors.append("agent/ROUTE_CANONICAL.json owner_mode must be string or null")
    if "successor_contract_required" in route and not isinstance(route.get("successor_contract_required"), bool):
        errors.append("agent/ROUTE_CANONICAL.json successor_contract_required must be boolean")
    for key in (
        "exact_next_task_id",
        "exact_profile_path",
        "exact_queue_draft_path",
        "exact_next_object_path",
        "required_successor_exactness",
        "successor_materialization_status",
        "experiment_gate_status",
        "current_conclusion_topic_id",
        "current_conclusion_query",
    ):
        if key in route and route.get(key) is not None and not isinstance(route.get(key), str):
            errors.append(f"agent/ROUTE_CANONICAL.json {key} must be string or null")
    for key in ("experiment_decision_gate_required", "experiment_decision_gate_blocking"):
        if key in route and not isinstance(route.get(key), bool):
            errors.append(f"agent/ROUTE_CANONICAL.json {key} must be boolean")

def validate_next_task_draft():
    draft = load_json("agent/status/NEXT_TASK_DRAFT.json", required=False)
    if draft is None:
        return
    if not isinstance(draft, dict):
        errors.append("agent/status/NEXT_TASK_DRAFT.json must be an object")
        return
    if not isinstance(draft.get("task_id"), str) or not str(draft.get("task_id") or "").strip():
        errors.append("agent/status/NEXT_TASK_DRAFT.json task_id must be a nonempty string")
    if "status" in draft and draft.get("status") not in VALID_TASK_STATUS:
        errors.append("agent/status/NEXT_TASK_DRAFT.json status is invalid")
    if "allowed_runner" in draft and draft.get("allowed_runner") not in VALID_RUNNERS:
        errors.append("agent/status/NEXT_TASK_DRAFT.json allowed_runner is invalid")

def validate_schema_files():
    for rel in (
        "agent/schemas/watch_decision.schema.json",
        "agent/schemas/bootstrap_conversation_turn.schema.json",
        "agent/schemas/bootstrap_instantiation.schema.json",
        "agent/schemas/state.schema.json",
        "agent/schemas/task_box.schema.json",
        "agent/schemas/route_canonical.schema.json",
        "agent/schemas/secondary_skills.schema.json",
        "agent/schemas/job.schema.json",
        "agent/schemas/gate.schema.json",
    ):
        data = load_json(rel, required=True)
        if not isinstance(data, dict):
            continue
        if data.get("type") != "object":
            warnings.append(f"{rel} does not declare top-level type=object")

def validate_job_file(path, expected_status=None):
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        errors.append(f"invalid job JSON in {path}: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"job file must be an object: {path}")
        return None
    for key in ("job_id", "task_id", "created_utc", "runner", "command_profile", "expected_outputs", "max_runtime_minutes"):
        if key not in data:
            errors.append(f"{path} missing required job key: {key}")
    if data.get("runner") not in VALID_RUNNERS:
        errors.append(f"{path} runner is invalid")
    status = data.get("status")
    if status not in VALID_JOB_STATUS:
        errors.append(f"{path} status is invalid")
    if expected_status and status != expected_status:
        warnings.append(f"{path} status={status!r} does not match directory status={expected_status!r}")
    if not isinstance(data.get("expected_outputs", []), list):
        errors.append(f"{path} expected_outputs must be an array")
    if not isinstance(data.get("max_runtime_minutes", 1), int):
        errors.append(f"{path} max_runtime_minutes must be integer")
    return data

def validate_jobs():
    running_task_ids = []
    for dirname, expected in (
        ("agent/queue/queued", "queued"),
        ("agent/queue/running", "running"),
        ("agent/queue/done", "done"),
        ("agent/queue/failed", "failed"),
    ):
        d = ROOT / dirname
        if not d.exists():
            continue
        for item in d.iterdir():
            if item.name.startswith(".") or not item.is_file():
                continue
            if item.suffix != ".json":
                warnings.append(f"non-json queue file ignored by validator: {item}")
                continue
            data = validate_job_file(item, expected)
            if data and expected == "running":
                running_task_ids.append(data.get("task_id"))
    for tid in set(t for t in running_task_ids if t):
        if running_task_ids.count(tid) > 1:
            errors.append(f"task_id has multiple running job files: {tid}")

def validate_gates():
    for dirname in ("agent/gates/pending", "agent/gates/passed", "agent/gates/failed", "agent/gates/review_required"):
        d = ROOT / dirname
        if not d.exists():
            continue
        for item in d.glob("*.json"):
            data = load_json(str(item), required=False)
            if data is None:
                continue
            if not isinstance(data, dict):
                errors.append(f"gate file must be an object: {item}")
                continue
            if "job_id" not in data and "gates" not in data:
                warnings.append(f"gate file has no job_id/gates key: {item}")

def validate_secondary_skills_config():
    config = load_json("agent/SECONDARY_SKILLS.json", required=False)
    if config is None:
        return
    if not isinstance(config, dict):
        errors.append("agent/SECONDARY_SKILLS.json must be an object")
        return
    if not isinstance(config.get("schema_version"), int):
        errors.append("agent/SECONDARY_SKILLS.json schema_version must be an integer")
    skills = config.get("skills")
    if not isinstance(skills, list):
        errors.append("agent/SECONDARY_SKILLS.json skills must be an array")
        return
    seen = set()
    for idx, item in enumerate(skills):
        label = f"agent/SECONDARY_SKILLS.json skills[{idx}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        skill_id = item.get("skill_id")
        if not isinstance(skill_id, str) or not skill_id.strip():
            errors.append(f"{label}.skill_id must be a nonempty string")
        elif skill_id in seen:
            errors.append(f"duplicate secondary skill_id: {skill_id}")
        else:
            seen.add(skill_id)
        rel_path = item.get("path")
        if not isinstance(rel_path, str) or not rel_path.strip():
            errors.append(f"{label}.path must be a nonempty string")
        else:
            skill_path = ROOT / rel_path
            if Path(rel_path).is_absolute():
                errors.append(f"{label}.path must stay project-relative")
            elif not skill_path.exists():
                errors.append(f"{label}.path does not exist: {rel_path}")
        if "enabled" in item and not isinstance(item.get("enabled"), bool):
            errors.append(f"{label}.enabled must be boolean when present")
        if "required" in item and not isinstance(item.get("required"), bool):
            errors.append(f"{label}.required must be boolean when present")
        if item.get("required") is True and item.get("enabled") is False:
            errors.append(f"{label} required secondary skill cannot be disabled")
        selectors = item.get("selectors")
        if not isinstance(selectors, dict):
            errors.append(f"{label}.selectors must be an object")
            continue
        for key in ("primary_skills", "roles", "supervisor_modes", "task_capabilities"):
            value = selectors.get(key, [])
            if not isinstance(value, list) or not all(isinstance(entry, str) for entry in value):
                errors.append(f"{label}.selectors.{key} must be an array of strings")

def validate_skill_route():
    route = load_json("agent/status/SKILL_ROUTE.json", required=False)
    if route is None:
        return
    if not isinstance(route, dict):
        errors.append("agent/status/SKILL_ROUTE.json must be an object")
        return
    if route.get("primary_skill") not in VALID_SKILLS:
        errors.append("agent/status/SKILL_ROUTE.json primary_skill is invalid")
    secondary = route.get("secondary_skills", [])
    if not isinstance(secondary, list):
        errors.append("agent/status/SKILL_ROUTE.json secondary_skills must be an array")
    else:
        seen = set()
        for idx, item in enumerate(secondary):
            label = f"agent/status/SKILL_ROUTE.json secondary_skills[{idx}]"
            if not isinstance(item, dict):
                errors.append(f"{label} must be an object")
                continue
            skill_id = item.get("skill_id")
            if not isinstance(skill_id, str) or not skill_id.strip():
                errors.append(f"{label}.skill_id must be a nonempty string")
            elif skill_id in seen:
                errors.append(f"duplicate routed secondary skill_id: {skill_id}")
            else:
                seen.add(skill_id)
            rel_path = item.get("path")
            if not isinstance(rel_path, str) or not rel_path.strip():
                errors.append(f"{label}.path must be a nonempty string")
            else:
                skill_path = ROOT / rel_path
                if Path(rel_path).is_absolute():
                    errors.append(f"{label}.path must stay project-relative")
                elif not skill_path.exists():
                    errors.append(f"{label}.path does not exist: {rel_path}")
    if "route_capability" in route and route.get("route_capability") is not None and not isinstance(route.get("route_capability"), str):
        errors.append("agent/status/SKILL_ROUTE.json route_capability must be string or null")
    failures = route.get("secondary_skill_failures")
    if failures is not None:
        if not isinstance(failures, list):
            errors.append("agent/status/SKILL_ROUTE.json secondary_skill_failures must be an array")
        else:
            for idx, item in enumerate(failures):
                label = f"agent/status/SKILL_ROUTE.json secondary_skill_failures[{idx}]"
                if not isinstance(item, dict):
                    errors.append(f"{label} must be an object")
                    continue
                for key in ("skill_id", "path", "reason"):
                    if key in item and item.get(key) is not None and not isinstance(item.get(key), str):
                        errors.append(f"{label}.{key} must be string or null")

validate_state()
validate_progress()
validate_task_box()
validate_route_canonical()
validate_next_task_draft()
validate_schema_files()
validate_jobs()
validate_gates()
validate_secondary_skills_config()
validate_skill_route()

payload = {
    "ok": not errors,
    "updated_utc": now_utc(),
    "errors": errors,
    "warnings": warnings
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(payload, indent=2) + "\\n")
print(json.dumps(payload, indent=2))
if errors:
    sys.exit(1)
`
};

module.exports = {
  pythonValidateRuntimeTemplates
};
