"use strict";

const pythonRenderReportTemplates = {
  renderReport: () => `#!/usr/bin/env python3
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())

def safe_name(value):
    raw = str(value or "unknown")
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", raw).strip("._-")[:80] or "unknown"

route_path = Path("agent/status/SKILL_ROUTE.json")
if route_path.exists():
    route = json.loads(route_path.read_text())
    expected_skill = route.get("primary_skill")
    actual_skill = data.get("primary_skill")
    if expected_skill and actual_skill != expected_skill:
        raise SystemExit(f"primary_skill mismatch: expected {expected_skill!r} from SKILL_ROUTE.json, got {actual_skill!r}")
else:
    route = {}

def normalized_secondary_skill_ids(items):
    result = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict):
            value = str(item.get("skill_id") or "").strip()
        else:
            value = str(item or "").strip()
        if value and value not in result:
            result.append(value)
    return result

expected_secondary_skills = normalized_secondary_skill_ids(route.get("secondary_skills", []))
actual_secondary_skills = normalized_secondary_skill_ids(data.get("secondary_skills_consulted", []))
if expected_secondary_skills != actual_secondary_skills:
    raise SystemExit(
        f"secondary_skills_consulted mismatch: expected {expected_secondary_skills!r} from SKILL_ROUTE.json, got {actual_secondary_skills!r}"
    )

task_box_path = Path("agent/TASK_BOX.json")
try:
    task_box = json.loads(task_box_path.read_text()) if task_box_path.exists() else {}
except Exception:
    task_box = {}
route_canonical_path = Path("agent/ROUTE_CANONICAL.json")
try:
    route_canonical = json.loads(route_canonical_path.read_text()) if route_canonical_path.exists() else {}
except Exception:
    route_canonical = {}

def atomic_write_text(path, text):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(target)

def atomic_write_json(path, payload):
    atomic_write_text(path, json.dumps(payload, indent=2) + "\\n")

def append_jsonl(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\\n")

def int_env(name, fallback=0):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except Exception:
        return fallback
    return value if value >= 0 else fallback

def clean_object(value):
    return value if isinstance(value, dict) else {}

def normalize_successor_task(value):
    if not isinstance(value, dict):
        return {}
    task_id = str(value.get("task_id") or "").strip()
    if not task_id:
        return {}
    task = dict(value)
    task["task_id"] = task_id
    if not task.get("status"):
        task["status"] = "pending"
    return task

def merge_route_canonical(existing, update, updated_utc):
    merged = dict(existing) if isinstance(existing, dict) else {}
    clearable_keys = {
        "active_task_id",
        "exact_next_task_id",
        "exact_profile_path",
        "exact_queue_draft_path",
        "exact_next_object_path",
        "required_successor_exactness",
        "successor_materialization_status",
        "experiment_gate_status",
    }
    if isinstance(update, dict):
        for key, value in update.items():
            if value is None and key not in clearable_keys:
                continue
            merged[key] = value
    if merged:
        merged.setdefault("schema_version", 1)
        merged["updated_utc"] = updated_utc
    return merged

def ensure_task_box(existing, route_canonical):
    if isinstance(existing, dict) and existing:
        box = dict(existing)
    else:
        box = {
            "schema_version": 1,
            "task_box_id": str((route_canonical or {}).get("route_id") or "runtime-task-box"),
            "route_id": str((route_canonical or {}).get("route_id") or "runtime-route"),
            "route_epoch": str((route_canonical or {}).get("route_epoch") or "runtime-000"),
            "requires_review": bool((route_canonical or {}).get("requires_review", False)),
            "allowed_actions": [],
            "blocked_actions": [],
            "allowed_write_paths": [
                "agent/status/",
                "agent/reports/",
                "agent/pending/",
                "agent/task_profiles/",
                "workspace/",
                "runs/"
            ],
            "queue_policy": {
                "gpu": "queue_only",
                "max_new_jobs_per_wakeup": 1,
                "allow_conditional_enqueue": False
            },
            "tasks": []
        }
    if isinstance(route_canonical, dict) and route_canonical:
        if route_canonical.get("route_id"):
            box["route_id"] = route_canonical.get("route_id")
        if route_canonical.get("route_epoch"):
            box["route_epoch"] = route_canonical.get("route_epoch")
        if isinstance(route_canonical.get("requires_review"), bool):
            box["requires_review"] = route_canonical.get("requires_review")
        for key in ("owner_mode", "current_allowed_step", "active_task_id", "route_task_id", "exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status"):
            if key in route_canonical:
                box[key] = route_canonical.get(key)
        for key in ("successor_contract_required", "experiment_decision_gate_required", "experiment_decision_gate_blocking"):
            if isinstance(route_canonical.get(key), bool):
                box[key] = route_canonical.get(key)
    box.setdefault("schema_version", 1)
    if not isinstance(box.get("tasks"), list):
        box["tasks"] = []
    if not isinstance(box.get("queue_policy"), dict):
        box["queue_policy"] = {}
    box["queue_policy"].setdefault("allow_conditional_enqueue", False)
    return box

def upsert_task_box_task(task_box, task):
    if not task:
        return task_box
    tasks = []
    replaced = False
    for existing in task_box.get("tasks", []):
        if not isinstance(existing, dict):
            continue
        if str(existing.get("task_id") or "") == task["task_id"]:
            merged = dict(existing)
            merged.update(task)
            tasks.append(merged)
            replaced = True
        else:
            tasks.append(existing)
    if not replaced:
        tasks.append(task)
    task_box["tasks"] = tasks
    return task_box

def merge_task_box(existing, update):
    box = ensure_task_box(existing, route_canonical)
    if not isinstance(update, dict):
        return box
    for key, value in update.items():
        if key == "tasks":
            continue
        if value is None:
            continue
        box[key] = value
    for task in update.get("tasks", []) if isinstance(update.get("tasks"), list) else []:
        if isinstance(task, dict) and str(task.get("task_id") or "").strip():
            box = upsert_task_box_task(box, task)
    return box

def prune_previous_exact_task_from_task_box(task_box, previous_exact_task_id, current_exact_task_id):
    if not isinstance(task_box, dict):
        return task_box
    previous_exact_task_id = str(previous_exact_task_id or "").strip()
    current_exact_task_id = str(current_exact_task_id or "").strip()
    if not previous_exact_task_id or not current_exact_task_id or previous_exact_task_id == current_exact_task_id:
        return task_box
    tasks = task_box.get("tasks")
    if not isinstance(tasks, list):
        return task_box
    task_box["tasks"] = [
        task for task in tasks
        if not (
            isinstance(task, dict)
            and str(task.get("task_id") or "").strip() == previous_exact_task_id
            and str(task.get("status") or "").strip().lower() == "pending"
        )
    ]
    return task_box

def infer_successor_allowed_runner(next_action, route_canonical, queue_request_draft, task_profile_draft):
    candidates = []
    if isinstance(queue_request_draft, dict):
        candidates.extend([
            queue_request_draft.get("allowed_runner"),
            queue_request_draft.get("runner"),
            "gpu" if str(queue_request_draft.get("queue_target") or "").strip() else "",
        ])
    if isinstance(task_profile_draft, dict):
        candidates.extend([
            task_profile_draft.get("allowed_runner"),
            task_profile_draft.get("runner"),
        ])
    if isinstance(route_canonical, dict):
        candidates.append(route_canonical.get("preferred_runner"))
        candidates.append("gpu" if str(route_canonical.get("exact_queue_draft_path") or "").strip() else "")
        step = str(route_canonical.get("current_allowed_step") or "").strip().lower()
        if any(term in step for term in ("local_workspace_copy", "local-workspace-copy", "workspace_copy", "local copy", "project_local_copy")):
            candidates.append("cpu")
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
        if "gpu" in text or "queue" in text:
            candidates.append("gpu")
        elif "local workspace" in text or "project-local" in text or "project local" in text or "local copy" in text:
            candidates.append("cpu")
        elif "cpu" in text or "smoke" in text or "eval" in text or "probe" in text:
            candidates.append("cpu")
    for candidate in candidates:
        value = str(candidate or "").strip().lower()
        if value in {"cpu", "gpu", "report_only"}:
            return value
    return "report_only"

def infer_successor_workspace_mode(next_action, route_canonical):
    text = ""
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
    step = str((route_canonical or {}).get("current_allowed_step") or "").lower()
    if "local workspace" in text or "project local" in text or "local copy" in text:
        return "project_local_copy"
    if "workspace" in step or "local_copy" in step or "local-copy" in step or "copy" in step:
        return "project_local_copy"
    return "readonly"

def infer_successor_queue_mode(task_box, route_canonical, next_action, allowed_runner):
    if allowed_runner != "gpu":
        return False
    policy = task_box.get("queue_policy") if isinstance(task_box, dict) else {}
    policy_gpu = str(policy.get("gpu") or "").strip().lower() if isinstance(policy, dict) else ""
    text = ""
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
    step = str((route_canonical or {}).get("current_allowed_step") or "").lower()
    if policy_gpu == "queue_only":
        return True
    if any(term in text for term in ("queue", "enqueue", "gpu_queue")):
        return True
    return any(term in step for term in ("queue", "enqueue", "gpu"))

def infer_successor_output_paths(task_id, allowed_runner, workspace_mode, queue_request_draft):
    if isinstance(queue_request_draft, dict):
        outputs = queue_request_draft.get("expected_outputs") if isinstance(queue_request_draft.get("expected_outputs"), list) else queue_request_draft.get("outputs")
        if isinstance(outputs, list) and any(str(item or "").strip() for item in outputs):
            return [str(item).strip() for item in outputs if str(item or "").strip()]
    slug = safe_name(task_id or "next-task")
    if workspace_mode == "project_local_copy":
        return [f"workspace/{slug}/", f"agent/reports/{slug}.md"]
    if allowed_runner in {"cpu", "gpu"}:
        return [f"runs/{slug}/metrics.json"]
    return [f"agent/reports/{slug}.md"]

def infer_successor_allowed_write_paths(task_box, workspace_mode):
    allowed = task_box.get("allowed_write_paths") if isinstance(task_box, dict) else None
    if isinstance(allowed, list) and any(str(item or "").strip() for item in allowed):
        return [str(item).strip() for item in allowed if str(item or "").strip()]
    if workspace_mode == "project_local_copy":
        return ["workspace/", "runs/", "agent/status/", "agent/reports/", "agent/task_profiles/"]
    return ["runs/", "agent/status/", "agent/reports/", "agent/task_profiles/"]

def infer_successor_budget_contract(route_canonical, queue_mode, allowed_runner):
    budget = str((route_canonical or {}).get("current_budget_contract") or "").strip()
    if budget:
        return budget
    if queue_mode:
        return "one bounded queue job"
    if allowed_runner == "cpu":
        return "one bounded cpu follow-up"
    if allowed_runner == "gpu":
        return "one bounded gpu follow-up"
    return "one bounded report-only follow-up"

def infer_successor_runtime_minutes(route_canonical, queue_mode, allowed_runner):
    for key in ("max_runtime_minutes", "bounded_runtime_minutes", "timeout_minutes"):
        value = (route_canonical or {}).get(key)
        if isinstance(value, int) and value > 0:
            return value
    if queue_mode or allowed_runner == "gpu":
        return 45
    if allowed_runner == "cpu":
        return 20
    return 10

def infer_successor_queue_target(task_box, route_canonical):
    for source in ((route_canonical or {}), (task_box.get("queue_policy") if isinstance(task_box, dict) else {})):
        if not isinstance(source, dict):
            continue
        for key in ("queue_target", "queue_name", "default_queue_target"):
            value = str(source.get(key) or "").strip()
            if value:
                return value
    return "gpu_queue"

def infer_required_successor_exactness(route_canonical, task_box, successor_task_draft, next_action):
    step = str((route_canonical or {}).get("current_allowed_step") or "").strip().lower()
    if isinstance(successor_task_draft, dict):
        kind = str(successor_task_draft.get("kind") or "").strip().lower()
        if kind == "queue_enqueue":
            return "queue_exact"
        if kind in {"bounded_cpu_eval", "local_workspace_copy"}:
            return "profile_exact"
    if any(term in step for term in ("queue", "enqueue", "gpu")):
        return "queue_exact"
    if any(term in step for term in ("local_workspace_copy", "local-workspace-copy", "workspace_copy", "local copy", "cpu")):
        return "profile_exact"
    text = ""
    if isinstance(next_action, dict):
        text = " ".join(str(next_action.get(key) or "") for key in ("kind", "description", "reason")).lower()
    if any(term in text for term in ("queue", "enqueue", "gpu_queue", "gpu follow-up", "gpu followup")):
        return "queue_exact"
    if any(term in text for term in ("local workspace", "project-local", "project local", "local copy", "cpu", "smoke", "eval", "probe")):
        return "profile_exact"
    allowed = task_box.get("allowed_actions") if isinstance(task_box, dict) else []
    if isinstance(allowed, list):
        normalized = {str(item or "").strip().lower() for item in allowed}
        if "queue_enqueue" in normalized:
            return "queue_exact"
        if normalized.intersection({"bounded_cpu_eval", "local_workspace_copy"}):
            return "profile_exact"
    return "task_only"

def infer_experiment_gate_status(route_canonical, task_box):
    for source in (task_box, route_canonical):
        if not isinstance(source, dict):
            continue
        gate = source.get("experiment_decision_gate")
        if isinstance(gate, dict):
            if gate.get("blocking") is True:
                return "blocked"
            if gate.get("required") is True:
                return "required_ready"
            if gate:
                return "not_required"
        if source.get("experiment_decision_gate_blocking") is True:
            return "blocked"
        if source.get("experiment_decision_gate_required") is True:
            return "required_ready"
        status = str(source.get("experiment_gate_status") or "").strip()
        if status:
            return status
    return "not_required"

def infer_successor_materialization_status(route_canonical, task_box, successor_task_draft, task_profile_path, queue_request_draft_path, next_task_draft_path, next_action):
    gate_status = infer_experiment_gate_status(route_canonical, task_box)
    required_exactness = infer_required_successor_exactness(route_canonical, task_box, successor_task_draft, next_action)
    if gate_status == "blocked":
        return "blocked_by_experiment_gate"
    if required_exactness == "queue_exact":
        return "queue_exact" if queue_request_draft_path else ("task_only" if next_task_draft_path else "missing")
    if required_exactness == "profile_exact":
        return "profile_exact" if task_profile_path else ("task_only" if next_task_draft_path else "missing")
    return "task_only" if next_task_draft_path else "missing"

def successor_path_matches_task_id(path_text, task_id):
    path_text = str(path_text or "").strip()
    task_id = str(task_id or "").strip()
    if not path_text or not task_id:
        return False
    try:
        return Path(path_text).stem == safe_name(task_id)
    except Exception:
        return False

def first_matching_successor_path(paths, task_id):
    for item in paths:
        text = str(item or "").strip()
        if successor_path_matches_task_id(text, task_id):
            return text
    return ""

def infer_successor_materialization_status_from_resolved(required_exactness, gate_status, exact_profile_path, exact_queue_draft_path, next_task_draft_path):
    if gate_status == "blocked":
        return "blocked_by_experiment_gate"
    if required_exactness == "queue_exact":
        return "queue_exact" if exact_queue_draft_path else ("task_only" if next_task_draft_path else "missing")
    if required_exactness == "profile_exact":
        return "profile_exact" if exact_profile_path else ("task_only" if next_task_draft_path else "missing")
    return "task_only" if next_task_draft_path else "missing"

def resolve_exact_successor_contract(route_canonical, task_box, successor_task_draft, task_profile_path, queue_request_draft_path, next_task_draft_path, next_action):
    required_exactness = infer_required_successor_exactness(route_canonical, task_box, successor_task_draft, next_action)
    gate_status = infer_experiment_gate_status(route_canonical, task_box)
    exact_next_task_id = str(
        (route_canonical or {}).get("exact_next_task_id")
        or (successor_task_draft or {}).get("task_id")
        or (task_box or {}).get("exact_next_task_id")
        or ""
    ).strip()

    exact_profile_path = first_matching_successor_path([
        task_profile_path,
        (route_canonical or {}).get("exact_profile_path"),
        (task_box or {}).get("exact_profile_path"),
    ], exact_next_task_id)
    exact_queue_draft_path = first_matching_successor_path([
        queue_request_draft_path,
        (route_canonical or {}).get("exact_queue_draft_path"),
        (task_box or {}).get("exact_queue_draft_path"),
    ], exact_next_task_id)

    matching_next_task_draft_path = ""
    if isinstance(successor_task_draft, dict) and str(successor_task_draft.get("task_id") or "").strip() == exact_next_task_id:
        matching_next_task_draft_path = str(next_task_draft_path or "").strip()

    if required_exactness == "queue_exact":
        exact_next_object_path = exact_queue_draft_path or ""
    elif required_exactness == "profile_exact":
        exact_next_object_path = exact_profile_path or ""
        exact_queue_draft_path = ""
    else:
        exact_next_object_path = matching_next_task_draft_path or ""
        exact_profile_path = ""
        exact_queue_draft_path = ""

    successor_materialization_status = infer_successor_materialization_status_from_resolved(
        required_exactness,
        gate_status,
        exact_profile_path,
        exact_queue_draft_path,
        matching_next_task_draft_path,
    )

    successor_contract_required = False
    if required_exactness == "queue_exact":
        successor_contract_required = successor_materialization_status != "queue_exact"
    elif required_exactness == "profile_exact":
        successor_contract_required = successor_materialization_status != "profile_exact"
    elif not matching_next_task_draft_path and exact_next_task_id:
        successor_contract_required = True

    return {
        "exact_next_task_id": exact_next_task_id or None,
        "exact_profile_path": exact_profile_path or None,
        "exact_queue_draft_path": exact_queue_draft_path or None,
        "exact_next_object_path": exact_next_object_path or None,
        "required_successor_exactness": required_exactness,
        "successor_materialization_status": successor_materialization_status,
        "experiment_gate_status": gate_status,
        "experiment_decision_gate_required": gate_status in {"required_ready", "blocked"},
        "experiment_decision_gate_blocking": gate_status == "blocked",
        "successor_contract_required": successor_contract_required,
    }

def resolve_route_task_id(route, exact_next_task_id):
    route_task_id = str((route or {}).get("task_id") or "").strip() if isinstance(route, dict) else ""
    exact_next_task_id = str(exact_next_task_id or "").strip()
    if not route_task_id:
        return exact_next_task_id or None
    if not exact_next_task_id or route_task_id == exact_next_task_id:
        return route_task_id
    capability = str((route or {}).get("route_capability") or "").strip().lower() if isinstance(route, dict) else ""
    if capability in {"state_reconcile", "stale_marker_cleanup", "local_profile_authoring", "local_queue_draft_authoring"}:
        return route_task_id
    return exact_next_task_id or route_task_id

def synthesize_successor_task(route_canonical, task_box, next_action, queue_request_draft, task_profile_draft):
    if not isinstance(route_canonical, dict):
        return {}
    task_id = str(route_canonical.get("exact_next_task_id") or "").strip()
    if not task_id:
        route_hint = safe_name(route_canonical.get("route_id") or "successor-route")
        step_hint = safe_name(route_canonical.get("current_allowed_step") or "next")
        task_id = f"{route_hint}_{step_hint}"
    title = ""
    if isinstance(next_action, dict):
        title = str(next_action.get("description") or "").strip()
    if not title:
        title = f"Continue with exact successor route {route_canonical.get('route_id') or 'next-step'}."
    allowed_runner = infer_successor_allowed_runner(next_action, route_canonical, queue_request_draft, task_profile_draft)
    workspace_mode = infer_successor_workspace_mode(next_action, route_canonical)
    queue_mode = infer_successor_queue_mode(task_box, route_canonical, next_action, allowed_runner)
    outputs = infer_successor_output_paths(task_id, allowed_runner, workspace_mode, queue_request_draft)
    task = {
        "task_id": task_id,
        "status": "pending",
        "allowed_runner": allowed_runner,
        "title": title,
        "successor_contract_inferred": True,
        "outputs": outputs,
    }
    if workspace_mode == "project_local_copy":
        task["workspace_mode"] = workspace_mode
        task["kind"] = "local_workspace_copy"
        task["allowed_write_paths"] = infer_successor_allowed_write_paths(task_box, workspace_mode)
        task["expected_outputs"] = outputs
        task["workspace_root"] = f"workspace/{safe_name(task_id)}/"
        task["max_runtime_minutes"] = infer_successor_runtime_minutes(route_canonical, False, "cpu")
        task["budget_contract"] = infer_successor_budget_contract(route_canonical, False, "cpu")
    elif allowed_runner == "cpu":
        task["kind"] = "bounded_cpu_eval"
        task["expected_outputs"] = outputs
        task["max_runtime_minutes"] = infer_successor_runtime_minutes(route_canonical, False, allowed_runner)
        task["budget_contract"] = infer_successor_budget_contract(route_canonical, False, allowed_runner)
    if queue_mode:
        task["kind"] = "queue_enqueue"
        task["queue_target"] = infer_successor_queue_target(task_box, route_canonical)
        task["command_profile"] = safe_name(task_id)
        task["expected_outputs"] = outputs
        task["max_runtime_minutes"] = infer_successor_runtime_minutes(route_canonical, queue_mode, allowed_runner)
        task["budget_contract"] = infer_successor_budget_contract(route_canonical, queue_mode, allowed_runner)
    return task

def should_synthesize_successor_profile(task):
    if not isinstance(task, dict):
        return False
    kind = str(task.get("kind") or "").strip().lower()
    return kind in {"queue_enqueue", "bounded_cpu_eval", "local_workspace_copy"}

def synthesize_successor_profile_draft(route_canonical, task):
    if not should_synthesize_successor_profile(task):
        return {}
    task_id = str(task.get("task_id") or "").strip()
    if not task_id:
        return {}
    kind = str(task.get("kind") or "").strip().lower()
    if kind == "bounded_cpu_eval":
        return {
            "task_id": task_id,
            "profile_kind": "cpu_followup",
            "allowed_runner": "cpu",
            "route_id": str((route_canonical or {}).get("route_id") or ""),
            "route_epoch": str((route_canonical or {}).get("route_epoch") or ""),
            "budget_contract": str(task.get("budget_contract") or ""),
            "max_runtime_minutes": int(task.get("max_runtime_minutes") or 20),
            "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else [],
        }
    if kind == "local_workspace_copy":
        return {
            "task_id": task_id,
            "profile_kind": "local_workspace_copy",
            "allowed_runner": str(task.get("allowed_runner") or "").strip().lower() or "cpu",
            "workspace_mode": "project_local_copy",
            "workspace_root": str(task.get("workspace_root") or f"workspace/{safe_name(task_id)}/"),
            "allowed_write_paths": task.get("allowed_write_paths") if isinstance(task.get("allowed_write_paths"), list) else [],
            "route_id": str((route_canonical or {}).get("route_id") or ""),
            "route_epoch": str((route_canonical or {}).get("route_epoch") or ""),
            "budget_contract": str(task.get("budget_contract") or ""),
            "max_runtime_minutes": int(task.get("max_runtime_minutes") or 20),
            "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else [],
        }
    return {
        "task_id": task_id,
        "profile_kind": "gpu_queue_followup",
        "allowed_runner": str(task.get("allowed_runner") or "").strip().lower() or "gpu",
        "command_profile": str(task.get("command_profile") or safe_name(task_id)),
        "route_id": str((route_canonical or {}).get("route_id") or ""),
        "route_epoch": str((route_canonical or {}).get("route_epoch") or ""),
        "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else [],
    }

def should_synthesize_successor_queue_request(task):
    return isinstance(task, dict) and str(task.get("kind") or "").strip().lower() == "queue_enqueue"

def synthesize_successor_queue_request(route_canonical, task_box, task):
    if not should_synthesize_successor_queue_request(task):
        return {}
    task_id = str(task.get("task_id") or "").strip()
    if not task_id:
        return {}
    return {
        "task_id": task_id,
        "runner": str(task.get("allowed_runner") or "").strip().lower() or "gpu",
        "queue_target": str(task.get("queue_target") or infer_successor_queue_target(task_box, route_canonical)),
        "command_profile": str(task.get("command_profile") or safe_name(task_id)),
        "expected_outputs": task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else infer_successor_output_paths(task_id, str(task.get("allowed_runner") or "").strip().lower() or "gpu", str(task.get("workspace_mode") or "readonly"), {}),
        "max_runtime_minutes": int(task.get("max_runtime_minutes") or infer_successor_runtime_minutes(route_canonical, True, str(task.get("allowed_runner") or "").strip().lower() or "gpu")),
        "budget_contract": str(task.get("budget_contract") or infer_successor_budget_contract(route_canonical, True, str(task.get("allowed_runner") or "").strip().lower() or "gpu")),
    }

def rehydrate_successor_task_from_exact_contract(route_canonical, task_box, next_action, task_profile_draft, queue_request_draft):
    if not isinstance(route_canonical, dict):
        return {}
    exact_next_task_id = str(route_canonical.get("exact_next_task_id") or "").strip()
    if not exact_next_task_id:
        return {}
    required_exactness = str(route_canonical.get("required_successor_exactness") or "").strip().lower()
    if required_exactness == "missing":
        return {}

    def load_exact_object(rel_path):
        rel_path = str(rel_path or "").strip()
        if not rel_path:
            return {}
        target = Path(rel_path)
        if not target.exists() or not target.is_file():
            return {}
        try:
            payload = json.loads(target.read_text())
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    loaded_profile = {}
    if isinstance(task_profile_draft, dict) and str(task_profile_draft.get("task_id") or "").strip() == exact_next_task_id:
        loaded_profile = dict(task_profile_draft)
    else:
        loaded_profile = load_exact_object(route_canonical.get("exact_profile_path"))

    loaded_queue = {}
    if isinstance(queue_request_draft, dict) and str(queue_request_draft.get("task_id") or "").strip() == exact_next_task_id:
        loaded_queue = dict(queue_request_draft)
    else:
        loaded_queue = load_exact_object(route_canonical.get("exact_queue_draft_path"))

    if required_exactness == "queue_exact" and not loaded_queue:
        return {}
    if required_exactness == "profile_exact" and not loaded_profile:
        return {}

    task = synthesize_successor_task(route_canonical, task_box, next_action, loaded_queue, loaded_profile)
    if not isinstance(task, dict) or not str(task.get("task_id") or "").strip():
        return {}
    task["task_id"] = exact_next_task_id
    task["exact_contract_rehydrated"] = True
    return task

def derive_runtime_state_json(route_canonical, task_box, successor_task_draft, next_action, route_task_id, existing_state, exact_next_object_path, task_profile_path, queue_request_draft_path, updated, requires_review):
    state = dict(existing_state) if isinstance(existing_state, dict) else {}
    tasks = []
    current_exact_task_id = str((route_canonical or {}).get("exact_next_task_id") or (successor_task_draft or {}).get("task_id") or "").strip()
    previous_exact_task_id = str(state.get("exact_next_task_id") or "").strip() if isinstance(state, dict) else ""
    for raw in task_box.get("tasks", []) if isinstance(task_box, dict) else []:
        if isinstance(raw, dict) and str(raw.get("task_id") or "").strip():
            tasks.append(dict(raw))
    if not tasks and isinstance(successor_task_draft, dict) and str(successor_task_draft.get("task_id") or "").strip():
        tasks.append(dict(successor_task_draft))
    if not tasks:
        fallback_tasks = existing_state.get("tasks") if isinstance(existing_state, dict) else []
        if isinstance(fallback_tasks, list):
            tasks = [
                dict(raw) for raw in fallback_tasks
                if isinstance(raw, dict)
                and str(raw.get("task_id") or "").strip()
                and not (
                    current_exact_task_id
                    and previous_exact_task_id
                    and current_exact_task_id != previous_exact_task_id
                    and str(raw.get("task_id") or "").strip() == previous_exact_task_id
                )
            ]

    blocked_actions = task_box.get("blocked_actions") if isinstance(task_box, dict) and isinstance(task_box.get("blocked_actions"), list) else state.get("blocked_actions", [])
    if not isinstance(blocked_actions, list):
        blocked_actions = []

    important_paths = []
    for candidate in (
        *(task.get("expected_outputs", []) for task in tasks if isinstance(task.get("expected_outputs"), list)),
        *(task.get("outputs", []) for task in tasks if isinstance(task.get("outputs"), list)),
        [exact_next_object_path] if exact_next_object_path else [],
        [task_profile_path] if task_profile_path else [],
        [queue_request_draft_path] if queue_request_draft_path else [],
        state.get("important_paths", []) if isinstance(state.get("important_paths"), list) else [],
    ):
        for item in candidate:
            text = str(item or "").strip()
            if text and text not in important_paths:
                important_paths.append(text)

    mode = str(state.get("mode") or "observer")
    if any(str(task.get("workspace_mode") or "").strip().lower() == "project_local_copy" for task in tasks):
        mode = "project-local-worker"
    elif any(str(task.get("kind") or "").strip().lower() == "queue_enqueue" or str(task.get("allowed_runner") or "").strip().lower() == "gpu" for task in tasks):
        mode = "gpu-queue-worker"
    elif any(str(task.get("allowed_runner") or "").strip().lower() == "cpu" for task in tasks):
        mode = "project-local-worker"
    elif not tasks:
        mode = "observer"

    required_successor_exactness = str((route_canonical or {}).get("required_successor_exactness") or (task_box or {}).get("required_successor_exactness") or "")
    successor_materialization_status = str((route_canonical or {}).get("successor_materialization_status") or (task_box or {}).get("successor_materialization_status") or "")
    experiment_gate_status = str((route_canonical or {}).get("experiment_gate_status") or (task_box or {}).get("experiment_gate_status") or "not_required")

    state.update({
        "schema_version": 1,
        "updated_utc": updated,
        "mode": mode,
        "requires_review": bool((route_canonical or {}).get("requires_review", False) or (task_box or {}).get("requires_review", False) or requires_review),
        "route_id": (route_canonical or {}).get("route_id") or (task_box or {}).get("route_id") or state.get("route_id"),
        "route_epoch": (route_canonical or {}).get("route_epoch") or (task_box or {}).get("route_epoch") or state.get("route_epoch"),
        "active_task_id": (route_canonical or {}).get("exact_next_task_id") or (successor_task_draft or {}).get("task_id") or state.get("active_task_id"),
        "route_task_id": str(route_task_id or "").strip() or state.get("route_task_id"),
        "tasks": tasks,
        "allowed_next_action": str((next_action or {}).get("kind") or state.get("allowed_next_action") or "report_only"),
        "blocked_actions": blocked_actions,
        "important_paths": important_paths,
        "exact_next_task_id": (route_canonical or {}).get("exact_next_task_id") or (successor_task_draft or {}).get("task_id"),
        "exact_profile_path": (route_canonical or {}).get("exact_profile_path"),
        "exact_queue_draft_path": (route_canonical or {}).get("exact_queue_draft_path"),
        "exact_next_object_path": exact_next_object_path or None,
        "successor_contract_required": bool((route_canonical or {}).get("successor_contract_required") or (task_box or {}).get("successor_contract_required")),
        "required_successor_exactness": required_successor_exactness,
        "successor_materialization_status": successor_materialization_status,
        "experiment_gate_status": experiment_gate_status,
        "experiment_decision_gate_required": bool((route_canonical or {}).get("experiment_decision_gate_required") or (task_box or {}).get("experiment_decision_gate_required")),
        "experiment_decision_gate_blocking": bool((route_canonical or {}).get("experiment_decision_gate_blocking") or (task_box or {}).get("experiment_decision_gate_blocking")),
        "task_box_id": (task_box or {}).get("task_box_id") or state.get("task_box_id"),
        "owner_mode": (route_canonical or {}).get("owner_mode") or state.get("owner_mode"),
        "current_allowed_step": (route_canonical or {}).get("current_allowed_step") or state.get("current_allowed_step"),
        "project_question": (task_box or {}).get("project_question") or state.get("project_question"),
        "decision_relevance": (task_box or {}).get("decision_relevance") or state.get("decision_relevance"),
        "claim_scope": (task_box or {}).get("claim_scope") or state.get("claim_scope"),
        "diagnosis_target": (task_box or {}).get("diagnosis_target") or state.get("diagnosis_target"),
        "derived_from_route_canonical": True,
    })
    return state

def write_task_profile_draft(draft, fallback_task_id):
    if not isinstance(draft, dict) or not draft:
        return ""
    task_id = str(draft.get("task_id") or fallback_task_id or "").strip()
    if not task_id:
        return ""
    payload = dict(draft)
    payload["task_id"] = task_id
    target = Path("agent/task_profiles") / f"{safe_name(task_id)}.json"
    atomic_write_json(target, payload)
    return str(target)

def write_queue_request_draft(draft, fallback_task_id):
    if not isinstance(draft, dict) or not draft:
        return ""
    task_id = str(draft.get("task_id") or fallback_task_id or "").strip()
    if not task_id:
        return ""
    payload = dict(draft)
    payload["task_id"] = task_id
    payload.setdefault("status", "draft")
    target = Path("agent/queue/drafts") / f"{safe_name(task_id)}.json"
    atomic_write_json(target, payload)
    return str(target)

print(data["report_markdown"])

updated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

successor_task_draft = normalize_successor_task(data.get("successor_task_draft"))
task_profile_draft = clean_object(data.get("task_profile_draft"))
queue_request_draft = clean_object(data.get("queue_request_draft"))
route_canonical_update = clean_object(data.get("route_canonical_update"))
task_box_update = clean_object(data.get("task_box_update"))
previous_exact_task_id = str(
    (route_canonical or {}).get("exact_next_task_id")
    or (task_box or {}).get("exact_next_task_id")
    or ""
).strip()

route_canonical_changed = False
task_box_changed = False

if route_canonical_update:
    route_canonical = merge_route_canonical(route_canonical, route_canonical_update, updated)
    route_canonical_changed = True
    if task_box:
        task_box = ensure_task_box(task_box, route_canonical)
        task_box["updated_utc"] = updated
        task_box_changed = True

if task_box_update:
    task_box = merge_task_box(task_box, task_box_update)
    task_box["updated_utc"] = updated
    task_box_changed = True

next_action = data.get("next_safe_action") or {}
initial_experiment_gate_status = infer_experiment_gate_status(route_canonical, task_box)

if not successor_task_draft and route_canonical.get("successor_contract_required") is True and initial_experiment_gate_status != "blocked":
    successor_task_draft = synthesize_successor_task(route_canonical, task_box, next_action, queue_request_draft, task_profile_draft)

if not successor_task_draft and initial_experiment_gate_status != "blocked":
    successor_task_draft = rehydrate_successor_task_from_exact_contract(
        route_canonical,
        task_box,
        next_action,
        task_profile_draft,
        queue_request_draft,
    )

if not task_profile_draft and should_synthesize_successor_profile(successor_task_draft) and initial_experiment_gate_status != "blocked":
    task_profile_draft = synthesize_successor_profile_draft(route_canonical, successor_task_draft)

if not queue_request_draft and should_synthesize_successor_queue_request(successor_task_draft) and initial_experiment_gate_status != "blocked":
    queue_request_draft = synthesize_successor_queue_request(route_canonical, task_box, successor_task_draft)

next_task_draft_path = ""
if successor_task_draft:
    next_task_draft_path = "agent/status/NEXT_TASK_DRAFT.json"
    atomic_write_json(next_task_draft_path, successor_task_draft)
    task_box = ensure_task_box(task_box, route_canonical)
    task_box = upsert_task_box_task(task_box, successor_task_draft)
    task_box["updated_utc"] = updated
    task_box_changed = True
    route_canonical = merge_route_canonical(route_canonical, {
        "exact_next_task_id": successor_task_draft.get("task_id"),
    }, updated)
    route_canonical_changed = True

task_profile_path = write_task_profile_draft(task_profile_draft, successor_task_draft.get("task_id") if successor_task_draft else "")
if task_profile_path:
    route_canonical = merge_route_canonical(route_canonical, {
        "exact_profile_path": task_profile_path,
    }, updated)
    route_canonical_changed = True

queue_request_draft_path = write_queue_request_draft(queue_request_draft, successor_task_draft.get("task_id") if successor_task_draft else "")
if queue_request_draft_path:
    route_canonical = merge_route_canonical(route_canonical, {
        "exact_queue_draft_path": queue_request_draft_path,
    }, updated)
    route_canonical_changed = True

resolved_exact_contract = resolve_exact_successor_contract(
    route_canonical,
    task_box,
    successor_task_draft,
    task_profile_path,
    queue_request_draft_path,
    next_task_draft_path,
    next_action,
)
required_successor_exactness = resolved_exact_contract["required_successor_exactness"]
experiment_gate_status = resolved_exact_contract["experiment_gate_status"]
successor_materialization_status = resolved_exact_contract["successor_materialization_status"]
exact_next_task_id = str(resolved_exact_contract.get("exact_next_task_id") or "").strip()
exact_profile_path = resolved_exact_contract.get("exact_profile_path")
exact_queue_draft_path = resolved_exact_contract.get("exact_queue_draft_path")
exact_next_object_path = resolved_exact_contract.get("exact_next_object_path")
resolved_route_task_id = resolve_route_task_id(route, exact_next_task_id)

task_box = prune_previous_exact_task_from_task_box(task_box, previous_exact_task_id, exact_next_task_id)

if not successor_task_draft:
    try:
        existing_next_task_draft = json.loads(Path("agent/status/NEXT_TASK_DRAFT.json").read_text())
    except Exception:
        existing_next_task_draft = {}
    existing_task_id = str(existing_next_task_draft.get("task_id") or "").strip() if isinstance(existing_next_task_draft, dict) else ""
    if existing_task_id and existing_task_id != exact_next_task_id:
        atomic_write_json("agent/status/NEXT_TASK_DRAFT.json", {})
        next_task_draft_path = ""

route_canonical = merge_route_canonical(route_canonical, {
    "active_task_id": resolved_exact_contract.get("exact_next_task_id"),
    "exact_next_task_id": resolved_exact_contract.get("exact_next_task_id"),
    "exact_profile_path": resolved_exact_contract.get("exact_profile_path"),
    "exact_queue_draft_path": resolved_exact_contract.get("exact_queue_draft_path"),
    "exact_next_object_path": resolved_exact_contract.get("exact_next_object_path"),
    "required_successor_exactness": resolved_exact_contract.get("required_successor_exactness"),
    "successor_materialization_status": resolved_exact_contract.get("successor_materialization_status"),
    "experiment_gate_status": resolved_exact_contract.get("experiment_gate_status"),
    "experiment_decision_gate_required": resolved_exact_contract.get("experiment_decision_gate_required"),
    "experiment_decision_gate_blocking": resolved_exact_contract.get("experiment_decision_gate_blocking"),
    "successor_contract_required": resolved_exact_contract.get("successor_contract_required"),
}, updated)
route_canonical_changed = True
task_box = ensure_task_box(task_box, route_canonical)
task_box["owner_mode"] = route_canonical.get("owner_mode") or task_box.get("owner_mode")
task_box["current_allowed_step"] = route_canonical.get("current_allowed_step") or task_box.get("current_allowed_step")
task_box["successor_contract_required"] = bool(resolved_exact_contract.get("successor_contract_required"))
task_box["active_task_id"] = resolved_exact_contract.get("exact_next_task_id")
task_box["route_task_id"] = resolved_route_task_id
task_box["exact_next_task_id"] = resolved_exact_contract.get("exact_next_task_id")
task_box["exact_profile_path"] = resolved_exact_contract.get("exact_profile_path")
task_box["exact_queue_draft_path"] = resolved_exact_contract.get("exact_queue_draft_path")
task_box["exact_next_object_path"] = resolved_exact_contract.get("exact_next_object_path")
task_box["required_successor_exactness"] = resolved_exact_contract.get("required_successor_exactness")
task_box["successor_materialization_status"] = resolved_exact_contract.get("successor_materialization_status")
task_box["experiment_gate_status"] = resolved_exact_contract.get("experiment_gate_status")
task_box["experiment_decision_gate_required"] = resolved_exact_contract.get("experiment_decision_gate_required")
task_box["experiment_decision_gate_blocking"] = resolved_exact_contract.get("experiment_decision_gate_blocking")
task_box["updated_utc"] = updated
task_box_changed = True

if route_canonical_changed and route_canonical:
    atomic_write_json(route_canonical_path, route_canonical)
if task_box_changed and task_box:
    atomic_write_json(task_box_path, task_box)

try:
    existing_state = json.loads(Path("agent/STATE.json").read_text())
except Exception:
    existing_state = {}
runtime_state_json = derive_runtime_state_json(
    route_canonical,
    task_box,
    successor_task_draft,
    next_action,
    resolved_route_task_id,
    existing_state if isinstance(existing_state, dict) else {},
    exact_next_object_path,
    task_profile_path,
    queue_request_draft_path,
    updated,
    bool(data.get("requires_human_review")),
)
atomic_write_json("agent/STATE.json", runtime_state_json)

state_update = data.get("state_update_markdown", "").strip()
if state_update:
    atomic_write_text("agent/STATE.proposed.md", state_update + "\\n")

runtime_update = data.get("runtime_state_markdown", "").strip()
if runtime_update:
    atomic_write_text("agent/RUNTIME_STATE.md", runtime_update + "\\n")

morning_brief = data.get("morning_brief_markdown", "").strip()
if morning_brief:
    atomic_write_text("agent/MORNING_BRIEF.md", morning_brief + "\\n")

progress_state = {
    "updated_utc": updated,
    "last_model_timestamp_utc": data.get("timestamp_utc"),
    "progress_changed": bool(data.get("progress_changed")),
    "no_progress_cycles": int(data.get("no_progress_cycles") or 0),
    "last_report_type": data.get("report_type", "heartbeat"),
    "primary_skill": data.get("primary_skill"),
    "expected_primary_skill": route.get("primary_skill"),
    "secondary_skills_expected": expected_secondary_skills,
    "secondary_skills_consulted": actual_secondary_skills,
    "route_capability": route.get("route_capability"),
    "skill_route_reason": route.get("reason"),
    "route_id": route_canonical.get("route_id") or task_box.get("route_id"),
    "route_epoch": route_canonical.get("route_epoch") or task_box.get("route_epoch"),
    "task_box_id": task_box.get("task_box_id"),
    "owner_mode": route_canonical.get("owner_mode") or task_box.get("owner_mode"),
    "current_allowed_step": route_canonical.get("current_allowed_step") or task_box.get("current_allowed_step"),
    "recommend_pause": bool(data.get("recommend_pause")),
    "requires_human_review": bool(data.get("requires_human_review")),
    "current_blocker": data.get("human_review_reason") or "; ".join(data.get("blocked_items") or [])[:1000],
    "next_safe_action": next_action,
    "active_task_id": exact_next_task_id or None,
    "route_task_id": resolved_route_task_id,
    "exact_next_task_id": exact_next_task_id,
    "exact_profile_path": exact_profile_path or None,
    "exact_queue_draft_path": exact_queue_draft_path or None,
    "exact_next_object_path": exact_next_object_path,
    "successor_contract_required": bool(resolved_exact_contract.get("successor_contract_required")),
    "required_successor_exactness": required_successor_exactness,
    "successor_materialization_status": successor_materialization_status,
    "experiment_gate_status": experiment_gate_status,
    "experiment_decision_gate_required": experiment_gate_status in {"required_ready", "blocked"},
    "experiment_decision_gate_blocking": experiment_gate_status == "blocked",
    "project_question": task_box.get("project_question"),
    "decision_relevance": task_box.get("decision_relevance"),
    "claim_scope": task_box.get("claim_scope"),
    "diagnosis_target": task_box.get("diagnosis_target"),
}
atomic_write_json("agent/PROGRESS_STATE.json", progress_state)

def blocker_type(blocked_items, requires_review, human_reason):
    text = " ".join(str(x) for x in (blocked_items or [])) + " " + str(human_reason or "")
    lowered = text.lower()
    if not lowered.strip():
        return "none"
    if any(k in lowered for k in ("cuda", "nvml", "conda", "systemd", "gpu", "environment", "env")):
        return "env"
    if "queue" in lowered or "runner" in lowered:
        return "queue"
    if any(k in lowered for k in ("approval", "permission", "allowlist", "sandbox", "policy")):
        return "permission"
    if any(k in lowered for k in ("reviewer", "bluecode", "claude", "external")):
        return "reviewer"
    if any(k in lowered for k in ("model", "loss", "gate", "architecture", "training")):
        return "model"
    if "data" in lowered or "dataset" in lowered:
        return "data"
    if "stale" in lowered or "snowball" in lowered:
        return "stale_state"
    if requires_review:
        return "permission"
    return "stale_state"

def write_lines(path, lines):
    atomic_write_text(path, "\\n".join(lines).rstrip() + "\\n")
blocked_items = data.get("blocked_items") or []
completed_items = data.get("completed_items") or []
running_items = data.get("running_items") or []
evidence = data.get("evidence") or []
human_reason = data.get("human_review_reason") or ""
requires_review = bool(data.get("requires_human_review"))
blocker = blocker_type(blocked_items, requires_review, human_reason)
successor_contract_required_text = str(bool(resolved_exact_contract.get("successor_contract_required"))).lower()
experiment_gate_required_text = str(experiment_gate_status in {"required_ready", "blocked"}).lower()
experiment_gate_blocking_text = str(experiment_gate_status == "blocked").lower()

Path("agent").mkdir(parents=True, exist_ok=True)
write_lines("agent/CURRENT_STATE.md", [
    "# Current State",
    "",
    f"Updated: {updated}",
    f"Role: {os.environ.get('WATCHDOG_ROLE', 'runner')}",
    f"Supervisor mode: {os.environ.get('WATCHDOG_SUPERVISOR_MODE', 'runner')}",
    f"Status: {data.get('overall_status', 'uncertain')}",
    f"Report type: {data.get('report_type', 'heartbeat')}",
    f"Primary skill: {data.get('primary_skill', '')}",
    f"Secondary skills: {', '.join(actual_secondary_skills) if actual_secondary_skills else 'none'}",
    f"Route ID: {route_canonical.get('route_id') or task_box.get('route_id') or 'unknown'}",
    f"Route epoch: {route_canonical.get('route_epoch') or task_box.get('route_epoch') or 'unknown'}",
    f"Owner mode: {route_canonical.get('owner_mode') or task_box.get('owner_mode') or 'unknown'}",
    f"Current allowed step: {route_canonical.get('current_allowed_step') or task_box.get('current_allowed_step') or 'unknown'}",
    f"Task box: {task_box.get('task_box_id') or 'none'}",
    f"Canonical active task: {exact_next_task_id or 'none'}",
    f"Route-selected task: {resolved_route_task_id or 'none'}",
    f"Exact next task: {exact_next_task_id or 'none'}",
    f"Exact profile path: {exact_profile_path or 'none'}",
    f"Exact queue draft path: {exact_queue_draft_path or 'none'}",
    f"Exact next object: {exact_next_object_path or 'none'}",
    f"Successor contract required: {successor_contract_required_text}",
    f"Required successor exactness: {required_successor_exactness or 'task_only'}",
    f"Successor materialization: {successor_materialization_status or 'missing'}",
    f"Experiment gate status: {experiment_gate_status or 'not_required'}",
    f"Experiment gate required: {experiment_gate_required_text}",
    f"Experiment gate blocking: {experiment_gate_blocking_text}",
    f"Project question: {task_box.get('project_question') or 'none'}",
    f"Decision relevance: {task_box.get('decision_relevance') or 'none'}",
    f"Claim scope: {task_box.get('claim_scope') or 'none'}",
    f"Diagnosis target: {task_box.get('diagnosis_target') or 'none'}",
    "",
    "## Current Facts",
    "",
    data.get("work_cycle_summary", "").strip() or "- No summary provided.",
    "",
    "## Completed Items",
    "",
    *(f"- {item}" for item in completed_items),
    *(["- None."] if not completed_items else []),
    "",
    "## Running Items",
    "",
    *(f"- {item}" for item in running_items),
    *(["- None."] if not running_items else []),
    "",
    "## Latest Evidence",
    "",
    *(f"- {item}" for item in evidence),
    *(["- None."] if not evidence else []),
])

runner_started_count = os.environ.get("WATCHDOG_RUNNER_STARTED_COUNT")
runner_completed_count = os.environ.get("WATCHDOG_RUNNER_COMPLETED_COUNT") or os.environ.get("WATCHDOG_RUNNER_RUN_COUNT")
runner_failure_drift = os.environ.get("WATCHDOG_RUNNER_FAILURE_DRIFT")

atomic_write_json("agent/RUN_STATE.json", {
    "schema_version": 1,
    "updated_utc": updated,
    "role": os.environ.get("WATCHDOG_ROLE", "runner"),
    "supervisor_mode": os.environ.get("WATCHDOG_SUPERVISOR_MODE", "runner"),
    "runner_run_count": os.environ.get("WATCHDOG_RUNNER_RUN_COUNT"),
    "runner_completed_count": runner_completed_count,
    "runner_started_count": runner_started_count,
    "runner_failure_drift": runner_failure_drift,
    "supervisor_audit_every_runner_runs": os.environ.get("WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS"),
    "status": data.get("overall_status", "uncertain"),
    "primary_skill": data.get("primary_skill"),
    "secondary_skills_expected": expected_secondary_skills,
    "secondary_skills_consulted": actual_secondary_skills,
    "route_capability": route.get("route_capability"),
    "report_type": data.get("report_type"),
    "progress_changed": bool(data.get("progress_changed")),
    "active_task_id": exact_next_task_id or None,
    "route_task_id": resolved_route_task_id,
    "route_id": route_canonical.get("route_id") or task_box.get("route_id"),
    "route_epoch": route_canonical.get("route_epoch") or task_box.get("route_epoch"),
    "task_box_id": task_box.get("task_box_id"),
    "owner_mode": route_canonical.get("owner_mode") or task_box.get("owner_mode"),
    "current_allowed_step": route_canonical.get("current_allowed_step") or task_box.get("current_allowed_step"),
    "blocker_type": blocker,
    "requires_human_review": requires_review,
    "next_action": next_action,
    "exact_next_task_id": exact_next_task_id or None,
    "exact_profile_path": exact_profile_path or None,
    "exact_queue_draft_path": exact_queue_draft_path or None,
    "exact_next_object_path": exact_next_object_path,
    "successor_contract_required": bool(resolved_exact_contract.get("successor_contract_required")),
    "required_successor_exactness": required_successor_exactness,
    "successor_materialization_status": successor_materialization_status,
    "experiment_gate_status": experiment_gate_status,
    "experiment_decision_gate_required": experiment_gate_status in {"required_ready", "blocked"},
    "experiment_decision_gate_blocking": experiment_gate_status == "blocked",
    "project_question": task_box.get("project_question"),
    "decision_relevance": task_box.get("decision_relevance"),
    "claim_scope": task_box.get("claim_scope"),
    "diagnosis_target": task_box.get("diagnosis_target"),
    "evidence": evidence,
})

if os.environ.get("WATCHDOG_ROLE", "runner") == "runner":
    runner_count = os.environ.get("WATCHDOG_RUNNER_RUN_COUNT")
    if runner_count:
        status_dir = Path("agent/status")
        status_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_text(status_dir / "runner_completed_count", str(runner_count) + "\\n")
        atomic_write_json(status_dir / "RUNNER_COMPLETION.json", {
            "schema_version": 1,
            "updated_utc": updated,
            "runner_run_count": runner_count,
            "runner_completed_count": runner_count,
            "status": data.get("overall_status", "uncertain"),
            "report_type": data.get("report_type"),
        })

write_lines("agent/NEXT_ACTION.md", [
    "# Next Action",
    "",
    f"Updated: {updated}",
    "",
    "## One Next Safe Action",
    "",
    f"- Kind: {next_action.get('kind', 'none')}",
    f"- Description: {next_action.get('description', '') or 'None.'}",
    f"- Automatic: {next_action.get('can_execute_automatically', False)}",
    f"- Reason: {next_action.get('reason', '') or 'No reason provided.'}",
    f"- Canonical active task: {exact_next_task_id or 'none'}",
    f"- Route-selected task: {resolved_route_task_id or 'none'}",
    f"- Exact next task: {exact_next_task_id or 'none'}",
    f"- Exact profile path: {exact_profile_path or 'none'}",
    f"- Exact queue draft path: {exact_queue_draft_path or 'none'}",
    f"- Exact object path: {exact_next_object_path or 'none'}",
    f"- Successor contract required: {successor_contract_required_text}",
    f"- Required successor exactness: {required_successor_exactness or 'task_only'}",
    f"- Successor materialization status: {successor_materialization_status or 'missing'}",
    f"- Experiment gate status: {experiment_gate_status or 'not_required'}",
    f"- Experiment gate required: {experiment_gate_required_text}",
    f"- Experiment gate blocking: {experiment_gate_blocking_text}",
    f"- Decision relevance: {task_box.get('decision_relevance') or 'none'}",
    f"- Claim scope: {task_box.get('claim_scope') or 'none'}",
    "",
    "## Stop Condition",
    "",
    f"- {data.get('skill_stop_condition', 'Stop after one bounded action.')}",
])

write_lines("agent/BLOCKERS.md", [
    "# Blockers",
    "",
    f"Updated: {updated}",
    f"Blocker type: {blocker}",
    "",
    "## Active Blockers",
    "",
    *(f"- {item}" for item in blocked_items),
    *(["- none: no active blocker reported."] if not blocked_items else []),
    "",
    "## Human Review",
    "",
    f"- Required: {requires_review}",
    f"- Reason: {human_reason or 'None.'}",
])

proposal = data.get("proposal_markdown", "").strip()
review_state = "pending_send" if proposal else "none"
if requires_review and not proposal:
    review_state = "review_required_no_bundle"
next_kind = str(next_action.get("kind", "none") or "none").strip()
review_scope = str(data.get("review_scope", "") or "").strip()
if review_scope not in {"none", "report_only", "bookkeeping", "external_review", "unsafe_operation"}:
    if proposal:
        review_scope = "external_review"
    elif requires_review and next_kind in {"report_only", "none"}:
        review_scope = "report_only"
    elif requires_review:
        review_scope = "unsafe_operation"
    else:
        review_scope = "none"
review_resolver = str(data.get("review_resolver", "") or "").strip()
if review_resolver not in {"none", "supervisor", "human", "external"}:
    if review_scope in {"report_only", "bookkeeping"}:
        review_resolver = "supervisor"
    elif review_scope == "external_review":
        review_resolver = "external"
    elif requires_review or proposal:
        review_resolver = "human"
    else:
        review_resolver = "none"
write_lines("agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    f"Updated: {updated}",
    "",
    "## Reviewer Bundle State",
    "",
    f"- state: {review_state}",
    f"- requires_human_review: {requires_review}",
    f"- scope: {review_scope}",
    f"- resolver: {review_resolver}",
    f"- human_review_reason: {human_reason or 'None.'}",
    "",
    "## Notes",
    "",
    "- If external reviewer sending is blocked by policy, write the exact bundle path and policy reason here instead of repeating it in every report.",
])

ledger_update = data.get("ledger_update_markdown", "").strip()
if ledger_update:
    Path("research").mkdir(parents=True, exist_ok=True)
    if ledger_update.startswith("# Research Ledger"):
        Path("research/RESEARCH_LEDGER.md").write_text(ledger_update + "\\n")
    else:
        with Path("research/LEDGER_NOTES.md").open("a") as fh:
            fh.write("\\n\\n## Proposed Ledger Fragment\\n\\n")
            fh.write(ledger_update + "\\n")

append_jsonl("agent/EVIDENCE_LEDGER.jsonl", {
    "timestamp_utc": updated,
    "task_id": route.get("task_id"),
    "artifact_type": data.get("report_type", "heartbeat"),
    "status": data.get("overall_status", "uncertain"),
    "primary_skill": data.get("primary_skill"),
    "secondary_skills_consulted": actual_secondary_skills,
    "route_capability": route.get("route_capability"),
    "route_id": route_canonical.get("route_id") or task_box.get("route_id"),
    "route_epoch": route_canonical.get("route_epoch") or task_box.get("route_epoch"),
    "successor_contract_generated": bool(next_task_draft_path or task_profile_path or queue_request_draft_path),
    "exact_next_task_id": exact_next_task_id or None,
    "exact_profile_path": exact_profile_path or None,
    "exact_queue_draft_path": exact_queue_draft_path or None,
    "exact_next_object_path": exact_next_object_path,
    "required_successor_exactness": required_successor_exactness,
    "successor_materialization_status": successor_materialization_status,
    "experiment_gate_status": experiment_gate_status,
    "experiment_decision_gate_required": experiment_gate_status in {"required_ready", "blocked"},
    "experiment_decision_gate_blocking": experiment_gate_status == "blocked",
    "task_box_id": task_box.get("task_box_id"),
    "input_paths": [],
    "output_paths": [
        "agent/reports/latest.md",
        "agent/STATE.json",
        "agent/CURRENT_STATE.md",
        "agent/RUN_STATE.json",
        "agent/PROGRESS_STATE.json",
        "agent/NEXT_ACTION.md",
        "agent/ROUTE_CANONICAL.json",
        *( [next_task_draft_path] if next_task_draft_path else [] ),
        *( [task_profile_path] if task_profile_path else [] ),
        *( [queue_request_draft_path] if queue_request_draft_path else [] ),
    ],
    "metrics": {},
    "caveats": data.get("blocked_items") or [],
    "next_safe_action": next_action.get("description", ""),
    "requires_review": requires_review,
    "project_question": task_box.get("project_question"),
    "decision_relevance": task_box.get("decision_relevance"),
    "claim_scope": task_box.get("claim_scope"),
    "diagnosis_target": task_box.get("diagnosis_target"),
    "fair_comparability": task_box.get("fair_comparability"),
    "value_of_information": task_box.get("value_of_information"),
})

proposal = data.get("proposal_markdown", "").strip()
if proposal:
    proposal_dir = Path("research/proposals")
    proposal_dir.mkdir(parents=True, exist_ok=True)
    proposal_name = safe_name(data.get("timestamp_utc", "unknown"))
    Path(proposal_dir / f"{proposal_name}.md").write_text(proposal + "\\n")

if data.get("requires_human_review"):
    pending_dir = Path("agent/pending/review_required")
    pending_dir.mkdir(parents=True, exist_ok=True)
    safe_ts = safe_name(data.get("timestamp_utc", "unknown"))
    Path(pending_dir / f"{safe_ts}.json").write_text(json.dumps(data, indent=2))

def finalize_supervisor_decision():
    if os.environ.get("WATCHDOG_ROLE", "runner") != "supervisor":
        return

    state_path = Path("agent/status/supervisor_state.json")
    try:
        state = json.loads(state_path.read_text())
    except Exception:
        state = {
            "schema_version": 2,
            "role": "supervisor",
            "mode": os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby"),
        }

    decision = dict(state.get("decision") or {})
    mode = decision.get("mode") or state.get("mode") or os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")
    target_count = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
    try:
        target_count = int(decision.get("target_runner_completed_count", target_count))
    except Exception:
        pass

    codex_status = os.environ.get("WATCHDOG_CODEX_STATUS", "0")
    success = codex_status == "0"
    decision["mode"] = mode
    decision["target_runner_completed_count"] = target_count

    event = {
        "decision_id": decision.get("decision_id", ""),
        "timestamp": updated,
        "mode": mode,
        "runner_completed_count": target_count,
    }

    if success:
        decision["status"] = "completed"
        decision["completed_at"] = updated
        state["last_seen_runner_completed_count"] = max(int(state.get("last_seen_runner_completed_count") or state.get("last_seen_runner_run_count") or 0), target_count)
        state["last_seen_runner_run_count"] = state["last_seen_runner_completed_count"]
        if mode == "light":
            state["last_light_runner_completed_count"] = max(int(state.get("last_light_runner_completed_count") or 0), target_count)
        if mode == "audit":
            state["last_audit_runner_completed_count"] = max(int(state.get("last_audit_runner_completed_count") or state.get("last_audit_runner_run_count") or 0), target_count)
            state["last_audit_runner_run_count"] = state["last_audit_runner_completed_count"]
        if mode in {"light", "audit"} and state.get("marker_pending") and state.get("marker_fingerprint"):
            state["last_actioned_marker_fingerprint"] = state.get("marker_fingerprint", "")
            state["last_marker_fingerprint"] = state.get("marker_fingerprint", "")
        event["event"] = "completed"
    else:
        decision["status"] = "failed"
        decision["failed_at"] = updated
        decision["failure_reason"] = f"codex_status_{codex_status}"
        event["event"] = "failed"
        event["failure_reason"] = decision["failure_reason"]

    state["schema_version"] = 2
    state["updated_utc"] = updated
    state["role"] = "supervisor"
    state["mode"] = mode
    state["runner_completed_count"] = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
    state["runner_started_count"] = int_env("WATCHDOG_RUNNER_STARTED_COUNT", state["runner_completed_count"])
    state["runner_failure_drift"] = int_env("WATCHDOG_RUNNER_FAILURE_DRIFT", max(0, state["runner_started_count"] - state["runner_completed_count"]))
    state["decision"] = decision

    atomic_write_json(state_path, state)
    atomic_write_json("agent/status/SUPERVISOR_MODE.json", state)
    append_jsonl("agent/status/SUPERVISOR_MODE.events.jsonl", event)

finalize_supervisor_decision()
`
};

module.exports = {
  pythonRenderReportTemplates
};
