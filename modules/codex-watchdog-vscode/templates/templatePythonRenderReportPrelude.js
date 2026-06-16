"use strict";

const renderReportPrelude = `#!/usr/bin/env python3
import hashlib
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
research_program_path = Path("research/RESEARCH_PROGRAM.json")
try:
    research_program = json.loads(research_program_path.read_text()) if research_program_path.exists() else {}
except Exception:
    research_program = {}

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

def normalized_string_list(value):
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item or "").strip()]

def summarize_research_program(program):
    if not isinstance(program, dict):
        return {
            "program_id": "none",
            "domain_name": "none",
            "autonomy_mode": "unknown",
            "allowed_project_areas": [],
            "baseline_required": False,
        }
    domain = program.get("domain") if isinstance(program.get("domain"), dict) else {}
    autonomy = program.get("autonomy_policy") if isinstance(program.get("autonomy_policy"), dict) else {}
    baseline = program.get("baseline_policy") if isinstance(program.get("baseline_policy"), dict) else {}
    return {
        "program_id": str(program.get("program_id") or "none"),
        "domain_name": str(domain.get("name") or "none"),
        "autonomy_mode": str(autonomy.get("mode") or "unknown"),
        "allowed_project_areas": normalized_string_list(domain.get("allowed_project_areas")),
        "baseline_required": baseline.get("required") is True,
    }

research_program_info = summarize_research_program(research_program)

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

`;

module.exports = {
  renderReportPrelude
};
