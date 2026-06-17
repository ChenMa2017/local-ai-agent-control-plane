"use strict";

const routeSkillPrelude = `#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(".")
OUT = ROOT / "agent" / "status" / "SKILL_ROUTE.json"

def int_env(name, default):
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default

RESULT_FRESH_MINUTES = int_env("WATCHDOG_QUEUE_RESULT_FRESH_MINUTES", 240)

def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default

def load_task_box(root=ROOT):
    data = load_json(root / "agent" / "TASK_BOX.json", {})
    return data if isinstance(data, dict) else {}

def load_route_canonical(root=ROOT):
    data = load_json(root / "agent" / "ROUTE_CANONICAL.json", {})
    return data if isinstance(data, dict) else {}

def load_research_program(root=ROOT):
    data = load_json(root / "research" / "RESEARCH_PROGRAM.json", {})
    return data if isinstance(data, dict) else {}

def load_next_task_draft(root=ROOT):
    data = load_json(root / "agent" / "status" / "NEXT_TASK_DRAFT.json", {})
    return data if isinstance(data, dict) else {}

def normalize_string_list(values):
    if not isinstance(values, list):
        return []
    result = []
    for value in values:
        text = str(value or "").strip()
        if text:
            result.append(text)
    return result

def load_secondary_skills_config(root=ROOT):
    data = load_json(root / "agent" / "SECONDARY_SKILLS.json", {})
    if not isinstance(data, dict):
        return {"skills": []}
    skills = data.get("skills")
    if not isinstance(skills, list):
        return {"skills": []}
    normalized = []
    for raw in skills:
        if not isinstance(raw, dict):
            continue
        skill_id = str(raw.get("skill_id") or "").strip()
        rel_path = str(raw.get("path") or "").strip()
        selectors = raw.get("selectors") if isinstance(raw.get("selectors"), dict) else {}
        resolution_error = ""
        resolved = True
        if not skill_id:
            resolved = False
            resolution_error = "missing skill_id"
        elif not rel_path:
            resolved = False
            resolution_error = "missing path"
        elif Path(rel_path).is_absolute():
            resolved = False
            resolution_error = "path must stay project-relative"
        else:
            target_path = root / rel_path
            if not target_path.exists() or not target_path.is_file():
                resolved = False
                resolution_error = f"path does not exist: {rel_path}"
        normalized.append({
            "skill_id": skill_id,
            "path": rel_path,
            "enabled": raw.get("enabled") is not False,
            "required": raw.get("required") is True,
            "resolved": resolved,
            "resolution_error": resolution_error,
            "selectors": {
                "primary_skills": normalize_string_list(selectors.get("primary_skills")),
                "roles": normalize_string_list(selectors.get("roles")),
                "supervisor_modes": normalize_string_list(selectors.get("supervisor_modes")),
                "task_capabilities": normalize_string_list(selectors.get("task_capabilities")),
            }
        })
    return {
        "schema_version": data.get("schema_version"),
        "skills": normalized,
    }

def has_files(*dirs, freshness_minutes=None):
    cutoff = None
    if freshness_minutes is not None:
        cutoff = datetime.now(timezone.utc).timestamp() - (max(0, int(freshness_minutes)) * 60)
    for dirname in dirs:
        d = ROOT / dirname
        if d.is_dir():
            for item in d.iterdir():
                if item.is_file() and not item.name.startswith("."):
                    if cutoff is not None:
                        try:
                            if item.stat().st_mtime < cutoff:
                                continue
                        except OSError:
                            continue
                    return True
    return False

TRUE_VALUES = {"1", "true", "yes", "on", "required"}
REVIEW_STATES = {"pending_send", "review_required_no_bundle"}
BLOCKER_TYPES = {"permission", "reviewer", "allowlist", "stale_state"}

def read_text_path(p):
    if not p.exists():
        return ""
    try:
        return p.read_text(errors="ignore")
    except Exception:
        return ""

def read_text(rel):
    return read_text_path(ROOT / rel)

def field_value(raw_text, key):
    key = key.lower()
    for line in raw_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("-"):
            stripped = stripped[1:].strip()
        if ":" not in stripped:
            continue
        left, right = stripped.split(":", 1)
        if left.strip().lower() == key:
            return right.strip().lower()
    return ""

def is_true(value):
    return str(value or "").strip().lower() in TRUE_VALUES

def active_review_marker(state):
    if isinstance(state, dict) and state.get("requires_review") is True:
        return True, "STATE.json requires_review=true."

    review_text = read_text("agent/REVIEW_PENDING.md")
    review_state = field_value(review_text, "state")
    if review_state in REVIEW_STATES:
        return True, f"REVIEW_PENDING.md state={review_state}."
    if is_true(field_value(review_text, "requires_human_review")):
        return True, "REVIEW_PENDING.md requires_human_review=true."
    if is_true(field_value(review_text, "pending_send")):
        return True, "REVIEW_PENDING.md pending_send=true."

    blockers_text = read_text("agent/BLOCKERS.md")
    blocker_type = field_value(blockers_text, "blocker type")
    if blocker_type in BLOCKER_TYPES:
        return True, f"BLOCKERS.md blocker type={blocker_type}."
    if is_true(field_value(blockers_text, "required")):
        return True, "BLOCKERS.md review required."

    run_state = load_json(ROOT / "agent" / "RUN_STATE.json", {})
    blocker = str(run_state.get("blocker_type") or "").strip().lower() if isinstance(run_state, dict) else ""
    if blocker in {"permission", "reviewer", "stale_state"}:
        return True, f"RUN_STATE.json blocker_type={blocker}."

    return False, ""

def todo_has_pending():
    p = ROOT / "agent" / "TODO.md"
    if not p.exists():
        return False
    text = p.read_text(errors="ignore").lower()
    return "pending" in text or "- [ ]" in text or "| pending |" in text

def pending_tasks(state):
    tasks = state.get("tasks") if isinstance(state, dict) else []
    if not isinstance(tasks, list):
        return []
    return [t for t in tasks if isinstance(t, dict) and t.get("status") == "pending"]

def autonomous_mode(state, task_box, route_canonical):
    for source in (task_box, route_canonical, state):
        if isinstance(source, dict) and isinstance(source.get("requires_review"), bool):
            return source.get("requires_review") is False
    return False

def task_box_pending_tasks(task_box):
    tasks = task_box.get("tasks") if isinstance(task_box, dict) else []
    if not isinstance(tasks, list):
        return []
    pending = []
    for raw in tasks:
        if not isinstance(raw, dict):
            continue
        task = dict(raw)
        if not task.get("status"):
            task["status"] = "pending"
        if task.get("status") != "pending":
            continue
        if not task.get("task_id"):
            task["task_id"] = task_box.get("task_box_id") or "task-box-pending-task"
        pending.append(task)
    return pending

def next_task_draft_pending_task(next_task_draft, route_canonical):
    if not isinstance(next_task_draft, dict):
        return []
    task_id = str(next_task_draft.get("task_id") or "").strip()
    if not task_id:
        return []
    expected_task_id = str(route_canonical.get("exact_next_task_id") or "").strip() if isinstance(route_canonical, dict) else ""
    if expected_task_id and task_id != expected_task_id:
        return []
    task = dict(next_task_draft)
    if not task.get("status"):
        task["status"] = "pending"
    if task.get("status") != "pending":
        return []
    return [task]

def canonical_exact_pending_task(route_canonical):
    if not isinstance(route_canonical, dict):
        return []
    exact_task_id = str(route_canonical.get("exact_next_task_id") or "").strip()
    if not exact_task_id:
        return []

    queue_draft = load_exact_queue_draft(route_canonical)
    if queue_draft:
        return [{
            "task_id": exact_task_id,
            "status": "pending",
            "allowed_runner": str(queue_draft.get("runner") or "gpu").strip().lower() or "gpu",
            "kind": "queue_enqueue",
            "queue_target": str(queue_draft.get("queue_target") or "").strip(),
            "command_profile": str(queue_draft.get("command_profile") or "").strip(),
            "expected_outputs": queue_draft.get("expected_outputs") if isinstance(queue_draft.get("expected_outputs"), list) else [],
            "max_runtime_minutes": queue_draft.get("max_runtime_minutes"),
            "budget_contract": str(queue_draft.get("budget_contract") or "").strip(),
            "derived_from_route_canonical": True,
        }]

    profile = load_exact_profile_draft(route_canonical)
    if not profile:
        return []

    profile_kind = str(profile.get("profile_kind") or "").strip().lower()
    task = {
        "task_id": exact_task_id,
        "status": "pending",
        "allowed_runner": str(profile.get("allowed_runner") or "cpu").strip().lower() or "cpu",
        "derived_from_route_canonical": True,
    }
    if profile_kind == "local_workspace_copy":
        task.update({
            "kind": "local_workspace_copy",
            "workspace_mode": str(profile.get("workspace_mode") or "project_local_copy"),
            "workspace_root": str(profile.get("workspace_root") or f"workspace/{safe_name(exact_task_id)}/"),
            "allowed_write_paths": profile.get("allowed_write_paths") if isinstance(profile.get("allowed_write_paths"), list) else [],
            "expected_outputs": profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else [],
            "max_runtime_minutes": profile.get("max_runtime_minutes"),
            "budget_contract": str(profile.get("budget_contract") or "").strip(),
        })
        return [task]
    if profile_kind in {"cpu_followup", "bounded_cpu_eval"}:
        task.update({
            "kind": "bounded_cpu_eval",
            "expected_outputs": profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else [],
            "max_runtime_minutes": profile.get("max_runtime_minutes"),
            "budget_contract": str(profile.get("budget_contract") or "").strip(),
        })
        return [task]
    if profile_kind == "gpu_queue_followup":
        task.update({
            "kind": "queue_enqueue",
            "queue_target": "gpu_queue",
            "command_profile": str(profile.get("command_profile") or safe_name(exact_task_id)),
            "expected_outputs": profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else [],
        })
        return [task]
    return []

def matching_pending_tasks(tasks, exact_task_id):
    if not exact_task_id:
        return tasks
    return [
        task for task in tasks
        if isinstance(task, dict) and str(task.get("task_id") or "").strip() == exact_task_id
    ]

def preferred_pending_tasks(state, task_box, next_task_draft, route_canonical):
    exact_task_id = str(route_canonical.get("exact_next_task_id") or "").strip() if isinstance(route_canonical, dict) else ""
    canonical_tasks = canonical_exact_pending_task(route_canonical)
    task_box_tasks = task_box_pending_tasks(task_box)
    task_box_matches = matching_pending_tasks(task_box_tasks, exact_task_id)
    if task_box_matches:
        return task_box_matches, "TASK_BOX.json"
    draft_tasks = next_task_draft_pending_task(next_task_draft, route_canonical)
    if draft_tasks:
        return draft_tasks, "NEXT_TASK_DRAFT.json"
    if canonical_tasks:
        return canonical_tasks, "ROUTE_CANONICAL.json"
    state_tasks = pending_tasks(state)
    state_matches = matching_pending_tasks(state_tasks, exact_task_id)
    if state_matches:
        return state_matches, "STATE.json"
    if task_box_tasks:
        return task_box_tasks, "TASK_BOX.json"
    if state_tasks:
        return state_tasks, "STATE.json"
    return [], ""

def route_epoch_mismatch(route_canonical, state, progress, run_state):
    if not isinstance(route_canonical, dict):
        return ""
    canonical_epoch = str(route_canonical.get("route_epoch") or "").strip()
    if not canonical_epoch:
        return ""
    mismatches = []
    for label, record in (
        ("STATE.json", state),
        ("PROGRESS_STATE.json", progress),
        ("RUN_STATE.json", run_state),
    ):
        if not isinstance(record, dict):
            continue
        record_epoch = str(record.get("route_epoch") or "").strip()
        if record_epoch and record_epoch != canonical_epoch:
            mismatches.append(f"{label} route_epoch={record_epoch}")
    if mismatches:
        return f"Canonical route_epoch={canonical_epoch} differs from " + ", ".join(mismatches) + "."
    return ""

`;

module.exports = {
  routeSkillPrelude
};
