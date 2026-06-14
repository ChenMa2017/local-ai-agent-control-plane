"use strict";

const pythonScriptTemplates = {
  routeSkill: () => `#!/usr/bin/env python3
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
        if not skill_id or not rel_path or Path(rel_path).is_absolute():
            continue
        target_path = root / rel_path
        if not target_path.exists() or not target_path.is_file():
            continue
        selectors = raw.get("selectors") if isinstance(raw.get("selectors"), dict) else {}
        normalized.append({
            "skill_id": skill_id,
            "path": rel_path,
            "enabled": raw.get("enabled") is not False,
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

def task_is_report_only(task):
    runner = str(task.get("allowed_runner") or "").strip().lower()
    kind = str(task.get("kind") or "").strip().lower()
    task_id = str(task.get("task_id") or "").strip().lower()
    text = " ".join(str(task.get(key) or "") for key in ("description", "title", "summary")).lower()
    return runner == "report_only" or kind == "report_only" or "report-only" in text or "report_only" in text or "report" in task_id

DEFAULT_SUPERVISOR_CAPABILITIES = {
    "report_only": True,
    "state_reconcile": True,
    "stale_marker_cleanup": True,
    "local_workspace_copy": True,
    "local_profile_authoring": True,
    "local_queue_draft_authoring": True,
    "bounded_cpu_eval": True,
    "bounded_gpu_probe": False,
    "bounded_training_canary": False,
    "queue_enqueue": False,
    "promotion_prepare": False,
    "promotion_apply": False,
    "external_send": False,
}

CAPABILITY_ALIASES = {
    "report": "report_only",
    "report-only": "report_only",
    "report_only": "report_only",
    "state-reconcile": "state_reconcile",
    "state_reconcile": "state_reconcile",
    "stale-marker-cleanup": "stale_marker_cleanup",
    "stale_marker_cleanup": "stale_marker_cleanup",
    "local-workspace-copy": "local_workspace_copy",
    "local_workspace_copy": "local_workspace_copy",
    "project-local-copy": "local_workspace_copy",
    "project_local_copy": "local_workspace_copy",
    "local-profile-authoring": "local_profile_authoring",
    "local_profile_authoring": "local_profile_authoring",
    "missing-profile": "local_profile_authoring",
    "missing_profile": "local_profile_authoring",
    "local-queue-draft-authoring": "local_queue_draft_authoring",
    "local_queue_draft_authoring": "local_queue_draft_authoring",
    "queue-draft": "local_queue_draft_authoring",
    "queue_draft": "local_queue_draft_authoring",
    "bounded-cpu": "bounded_cpu_eval",
    "bounded_cpu": "bounded_cpu_eval",
    "bounded-cpu-eval": "bounded_cpu_eval",
    "bounded_cpu_eval": "bounded_cpu_eval",
    "cpu32": "bounded_cpu_eval",
    "bounded-gpu": "bounded_gpu_probe",
    "bounded_gpu": "bounded_gpu_probe",
    "bounded-gpu-probe": "bounded_gpu_probe",
    "bounded_gpu_probe": "bounded_gpu_probe",
    "bounded-training-canary": "bounded_training_canary",
    "bounded_training_canary": "bounded_training_canary",
    "queue": "queue_enqueue",
    "queue_enqueue": "queue_enqueue",
    "promotion-prepare": "promotion_prepare",
    "promotion_prepare": "promotion_prepare",
    "promotion-apply": "promotion_apply",
    "promotion_apply": "promotion_apply",
    "external-send": "external_send",
    "external_send": "external_send",
}

def normalize_capability(value):
    key = str(value or "").strip().lower().replace(" ", "_")
    return CAPABILITY_ALIASES.get(key, key if key in DEFAULT_SUPERVISOR_CAPABILITIES else "")

def load_supervisor_capability_policy(root=ROOT):
    policy = {"capabilities": dict(DEFAULT_SUPERVISOR_CAPABILITIES)}
    config = load_json(root / "agent" / "supervisor_capabilities.json", {})
    caps = config.get("capabilities") if isinstance(config, dict) else None
    if isinstance(caps, dict):
        for raw_name, raw_value in caps.items():
            name = normalize_capability(raw_name)
            if not name:
                continue
            if isinstance(raw_value, dict):
                policy["capabilities"][name] = raw_value.get("enabled") is True
            else:
                policy["capabilities"][name] = raw_value is True
    return policy

def capability_enabled(policy, capability):
    return policy.get("capabilities", {}).get(capability) is True

def task_policy_text(task, approval=None):
    parts = []
    for key in (
        "task_id",
        "kind",
        "title",
        "summary",
        "description",
        "allowed_runner",
        "workspace_mode",
        "workspace_path",
    ):
        parts.append(str(task.get(key) or ""))
    if isinstance(approval, dict):
        for key in (
            "approval_class",
            "capability",
            "scope",
            "allowed_runner",
            "workspace_mode",
            "workspace_path",
            "reason",
        ):
            parts.append(str(approval.get(key) or ""))
        for key in ("allowed_write_paths",):
            value = approval.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value)
    return "\\n".join(parts).lower()

def classify_supervisor_capability(task, approval=None):
    if isinstance(approval, dict):
        for key in ("approval_class", "capability", "class"):
            explicit = normalize_capability(approval.get(key))
            if explicit:
                return explicit
    explicit = normalize_capability(task.get("supervisor_approval_class") or task.get("capability"))
    if explicit:
        return explicit

    runner = str(task.get("allowed_runner") or "").strip().lower()
    kind = str(task.get("kind") or "").strip().lower()
    text = task_policy_text(task, approval)

    if task_is_report_only(task):
        return "report_only"
    if kind in {"state_reconcile", "state-reconcile"} or "state reconcile" in text:
        return "state_reconcile"
    if "stale marker" in text or "marker cleanup" in text or "stale_marker_cleanup" in text:
        return "stale_marker_cleanup"
    if (
        "project_local_copy" in text
        or "project-local-copy" in text
        or "local workspace" in text
        or "workspace/<task_id>" in text
        or "workspace/" in text
    ):
        return "local_workspace_copy"
    if (
        "missing_profile" in text
        or "missing profile" in text
        or "task profile" in text
        or "profile package" in text
        or "package object" in text
        or "local profile" in text
    ):
        return "local_profile_authoring"
    if (
        "queue draft" in text
        or "draft queue" in text
        or "queue taskbox draft" in text
        or "prepare queue request" in text
        or "prepare taskbox" in text
        or "author queue request" in text
    ):
        return "local_queue_draft_authoring"
    if (
        "queue_enqueue" in text
        or "queue enqueue" in text
        or "enqueue" in text
        or "agent/queue" in text
        or "gpu_queue" in text
        or "queue request" in text
        or "queue taskbox" in text
    ):
        return "queue_enqueue"
    if "external send" in text or "deep research send" in text or "reviewer send" in text:
        return "external_send"
    if "promotion" in text or "shared_model" in text or "deployment" in text:
        if "proposal" in text or "prepare" in text or "review packet" in text:
            return "promotion_prepare"
        return "promotion_apply"
    if "training" in text or "train " in text or "queue training" in text:
        return "bounded_training_canary" if ("bounded" in text or "canary" in text or "smoke" in text) else "training"
    if runner == "gpu" or "gpu" in text:
        return "bounded_gpu_probe" if ("bounded" in text or "probe" in text or "smoke" in text or "eval" in text or "sample" in text) else "gpu"
    if runner == "cpu" or "cpu32" in text or "cpu-only" in text or "cpu smoke" in text or "cpu eval" in text:
        return "bounded_cpu_eval"
    return ""

def text_has_any(text, terms):
    return any(term in text for term in terms)

def supervisor_policy_rejection(policy, capability, text):
    normalized_text = text
    for phrase in (
        "no promotion",
        "without promotion",
        "promotion blocked",
        "promotion_blocked",
        "no external send",
        "without external send",
        "does not externally send",
        "no dataset mutation",
        "without dataset mutation",
        "does not mutate dataset",
        "does not mutate datasets",
        "no checkpoint mutation",
        "without checkpoint mutation",
        "does not mutate checkpoint",
        "does not mutate checkpoints",
        "no direct gpu execution",
        "without direct gpu execution",
        "does not execute gpu directly",
        "will not execute gpu directly",
        "not execute gpu directly",
        "runner will not execute gpu directly",
        "does not run gpu directly",
        "will not run gpu directly",
        "not run gpu directly",
    ):
        normalized_text = normalized_text.replace(phrase, "")
    always_forbidden = (
        ".env",
        "secret",
        "token",
        "private key",
        "delete original",
        "delete shared",
        "dataset mutation",
        "checkpoint mutation",
        "package install",
        "install package",
        "network fetch",
        "systemd restart",
        "systemctl restart",
        "kill service",
        "restart service",
        "chmod",
        "chown",
        "sudo",
    )
    if text_has_any(normalized_text, always_forbidden):
        return "contains always-forbidden supervisor delegated approval term"

    if capability == "queue_enqueue":
        if not text_has_any(normalized_text, ("queue", "enqueue", "agent/queue", "gpu_queue", "queue request", "queue taskbox")):
            return "queue_enqueue approval requires an explicit controlled queue target"
        direct_execution_terms = (
            "direct gpu",
            "direct_gpu",
            "execute gpu directly",
            "run gpu directly",
            "launch gpu directly",
            "manual gpu execution",
            "bypass queue",
            "without queue",
        )
        if text_has_any(normalized_text, direct_execution_terms):
            return "queue_enqueue cannot approve direct GPU execution or queue bypass"
        return ""

    if capability in {"local_queue_draft_authoring", "local_profile_authoring"}:
        direct_execution_terms = (
            "direct gpu",
            "direct_gpu",
            "execute gpu directly",
            "run gpu directly",
            "launch gpu directly",
            "manual gpu execution",
            "bypass queue",
            "without queue",
            "promotion",
            "external send",
        )
        if text_has_any(normalized_text, direct_execution_terms):
            return f"{capability} cannot approve direct execution, promotion, or external send"
        return ""

    dangerous_by_capability = {
        "bounded_gpu_probe": ("gpu", "gpu0", "gpu1", "run gpu", "execute gpu"),
        "bounded_training_canary": ("training", "train ", "launch training", "start training"),
        "promotion_apply": ("promotion", "promote", "shared_model", "deployment", "public docs"),
        "external_send": ("external send", "deep research send", "reviewer send"),
    }

    for cap_name, terms in dangerous_by_capability.items():
        if text_has_any(normalized_text, terms):
            if capability != cap_name:
                return f"mentions {cap_name} terms but classified as {capability or 'unknown'}"
            if not capability_enabled(policy, cap_name):
                return f"capability {cap_name} is disabled by supervisor_capabilities policy"

    if ("implementation" in normalized_text or "code edit" in normalized_text or "modify source" in normalized_text) and capability != "local_workspace_copy":
        return "code/source edits require local_workspace_copy capability"

    if capability == "bounded_training_canary" and not ("bounded" in normalized_text or "canary" in normalized_text or "smoke" in normalized_text):
        return "training capability requires bounded/canary/smoke scope"

    return ""

def task_is_supervisor_approved(task):
    if task.get("supervisor_approved") is not True:
        return False
    approval = task.get("supervisor_approval")
    if not isinstance(approval, dict):
        return False
    approved_by = str(approval.get("approved_by") or "").lower()
    if "supervisor" not in approved_by:
        return False
    policy = load_supervisor_capability_policy()
    capability = classify_supervisor_capability(task, approval)
    if not capability_enabled(policy, capability):
        return False
    text = task_policy_text(task, approval)
    if supervisor_policy_rejection(policy, capability, text):
        return False
    return capability in DEFAULT_SUPERVISOR_CAPABILITIES

def classify_task_capability(task):
    capability = classify_supervisor_capability(task, task.get("supervisor_approval") if isinstance(task, dict) else None)
    if capability:
        return capability
    if task_is_report_only(task):
        return "report_only"
    runner = str(task.get("allowed_runner") or "").strip().lower()
    if runner == "cpu":
        return "bounded_cpu_eval"
    if runner == "gpu":
        return "bounded_gpu_probe"
    return ""

def permission_guardian_needed(task):
    if task_is_supervisor_approved(task):
        return False
    capability = classify_task_capability(task)
    if capability in {
        "report_only",
        "state_reconcile",
        "stale_marker_cleanup",
        "local_workspace_copy",
        "local_profile_authoring",
        "local_queue_draft_authoring",
        "bounded_cpu_eval",
    }:
        return False
    if capability in {
        "bounded_gpu_probe",
        "bounded_training_canary",
        "queue_enqueue",
        "promotion_prepare",
        "promotion_apply",
        "external_send",
    }:
        return True
    return str(task.get("allowed_runner") or "").strip().lower() in {"cpu", "gpu"}

def safe_autonomous_capability(capability):
    return capability in {
        "report_only",
        "state_reconcile",
        "stale_marker_cleanup",
        "local_workspace_copy",
        "local_profile_authoring",
        "local_queue_draft_authoring",
        "bounded_cpu_eval",
    }

def route_task_lookup(state, task_box, next_task_draft, route_canonical):
    candidates = []
    state_tasks = state.get("tasks") if isinstance(state, dict) else []
    if isinstance(state_tasks, list):
        candidates.extend(task for task in state_tasks if isinstance(task, dict))
    task_box_tasks = task_box.get("tasks") if isinstance(task_box, dict) else []
    if isinstance(task_box_tasks, list):
        for raw in task_box_tasks:
            if not isinstance(raw, dict):
                continue
            task = dict(raw)
            if not task.get("task_id"):
                task["task_id"] = task_box.get("task_box_id") or "task-box-pending-task"
            candidates.append(task)
    if isinstance(next_task_draft, dict) and str(next_task_draft.get("task_id") or "").strip():
        candidates.append(dict(next_task_draft))
    candidates.extend(canonical_exact_pending_task(route_canonical))
    by_id = {}
    for task in candidates:
        task_id = str(task.get("task_id") or "").strip()
        if task_id and task_id not in by_id:
            by_id[task_id] = task
    return by_id

def route_capability_from_result(result, role, supervisor_mode, state, task_box, next_task_draft, route_canonical, run_state, progress):
    if not isinstance(result, dict):
        return ""
    if role == "supervisor" and str(result.get("task_id") or "") == "supervisor-delegated-runner-blocker-approval":
        reason = str(result.get("reason") or "")
        marker = "capability="
        if marker in reason:
            capability = reason.split(marker, 1)[1].split(".", 1)[0].strip().strip(" ,)")
            return normalize_capability(capability)
    lookup = route_task_lookup(state, task_box, next_task_draft, route_canonical)
    task_id = str(result.get("task_id") or "").strip()
    if task_id and task_id in lookup:
        return classify_task_capability(lookup[task_id])
    local_capability, _ = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
    if local_capability:
        return local_capability
    return ""

def selector_matches(selectors, key, actual, normalizer=None):
    values = selectors.get(key) if isinstance(selectors, dict) else None
    if not values:
        return True
    normalized = []
    for value in values:
        candidate = normalizer(value) if normalizer else str(value or "").strip().lower()
        if candidate:
            normalized.append(candidate)
    if not normalized:
        return True
    actual_value = normalizer(actual) if normalizer else str(actual or "").strip().lower()
    if not actual_value:
        return False
    return actual_value in normalized

def selected_secondary_skills(result, role, supervisor_mode, capability):
    config = load_secondary_skills_config(ROOT)
    selected = []
    seen = set()
    for skill in config.get("skills", []):
        if not isinstance(skill, dict) or skill.get("enabled") is not True:
            continue
        selectors = skill.get("selectors") if isinstance(skill.get("selectors"), dict) else {}
        if not selector_matches(selectors, "primary_skills", result.get("primary_skill")):
            continue
        if not selector_matches(selectors, "roles", role):
            continue
        if not selector_matches(selectors, "supervisor_modes", supervisor_mode):
            continue
        if not selector_matches(selectors, "task_capabilities", capability, normalize_capability):
            continue
        skill_id = str(skill.get("skill_id") or "").strip()
        if not skill_id or skill_id in seen:
            continue
        seen.add(skill_id)
        selected.append({
            "skill_id": skill_id,
            "path": str(skill.get("path") or "").strip(),
        })
    return selected

def research_gate_policy(task_box):
    policy = task_box.get("gate_policy") if isinstance(task_box, dict) else {}
    if not isinstance(policy, dict):
        policy = {}
    return {
        "topic_alignment_check": policy.get("topic_alignment_check") is True,
        "claim_scope_gate": policy.get("claim_scope_gate") is True,
        "fair_comparability_gate": policy.get("fair_comparability_gate") is True,
        "value_of_information_gate": policy.get("value_of_information_gate") is True,
        "successor_contract_gate": policy.get("successor_contract_gate") is True,
        "causal_path_verification": str(policy.get("causal_path_verification") or "disabled"),
        "enforcement": str(policy.get("enforcement") or "disabled"),
    }

def task_contract_value(task, task_box, key):
    if isinstance(task, dict):
        value = task.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if isinstance(task_box, dict):
        value = task_box.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

def task_contract_list(task, task_box, key):
    if isinstance(task, dict):
        value = task.get(key)
        if isinstance(value, list) and value:
            return value
    if isinstance(task_box, dict):
        value = task_box.get(key)
        if isinstance(value, list) and value:
            return value
    return []

def task_contract_object(task, task_box, key):
    if isinstance(task, dict):
        value = task.get(key)
        if isinstance(value, dict) and value:
            return value
    if isinstance(task_box, dict):
        value = task_box.get(key)
        if isinstance(value, dict) and value:
            return value
    return {}

def research_gate_applicable(capability):
    return capability in {
        "bounded_cpu_eval",
        "bounded_gpu_probe",
        "queue_enqueue",
        "local_workspace_copy",
        "bounded_training_canary",
    }

def task_research_gate_gaps(task, task_box, route_canonical=None):
    capability = classify_task_capability(task)
    policy = research_gate_policy(task_box)
    if policy.get("enforcement") == "disabled" or not research_gate_applicable(capability):
        return []

    gaps = []
    if policy.get("topic_alignment_check"):
        if not task_contract_value(task, task_box, "project_question"):
            gaps.append("project_question")
        if not task_contract_value(task, task_box, "decision_relevance"):
            gaps.append("decision_relevance")

    if policy.get("claim_scope_gate"):
        if not task_contract_value(task, task_box, "claim_scope"):
            gaps.append("claim_scope")
        if not task_contract_value(task, task_box, "diagnosis_target"):
            gaps.append("diagnosis_target")
        if not task_contract_list(task, task_box, "forbidden_conclusions"):
            gaps.append("forbidden_conclusions")

    if policy.get("fair_comparability_gate"):
        fair = task_contract_object(task, task_box, "fair_comparability")
        for key in (
            "same_family_or_not",
            "same_budget_or_not",
            "same_training_contract_or_not",
            "same_eval_contract_or_not",
        ):
            if not isinstance(fair.get(key), str) or not str(fair.get(key) or "").strip():
                gaps.append(key)

    if policy.get("value_of_information_gate"):
        voi = task_contract_object(task, task_box, "value_of_information")
        for key in (
            "expected_information_gain",
            "decision_change_if_positive",
            "decision_change_if_negative",
        ):
            if not isinstance(voi.get(key), str) or not str(voi.get(key) or "").strip():
                gaps.append(key)
        if "cheaper_alternative_exists" not in voi or not isinstance(voi.get("cheaper_alternative_exists"), bool):
            gaps.append("cheaper_alternative_exists")

    return sorted(set(gaps))

def successor_contract_gap(route_canonical, next_task_draft):
    if not isinstance(route_canonical, dict):
        return False
    if route_canonical.get("successor_contract_required") is not True:
        return False
    required_exactness = str(route_canonical.get("required_successor_exactness") or "").strip()
    experiment_gate_status = str(route_canonical.get("experiment_gate_status") or "").strip().lower()
    if experiment_gate_status == "blocked":
        return False
    exact_task = str(route_canonical.get("exact_next_task_id") or "").strip()
    exact_profile = str(route_canonical.get("exact_profile_path") or "").strip()
    exact_queue = str(route_canonical.get("exact_queue_draft_path") or "").strip()
    exact_object = str(route_canonical.get("exact_next_object_path") or "").strip()
    draft_task = str((next_task_draft or {}).get("task_id") or "").strip() if isinstance(next_task_draft, dict) else ""
    if required_exactness == "queue_exact":
        return not (exact_task and exact_queue and exact_object)
    if required_exactness == "profile_exact":
        return not (exact_task and exact_profile and exact_object)
    return not any((exact_task, exact_profile, exact_queue, exact_object, draft_task))

def load_exact_queue_draft(route_canonical):
    if not isinstance(route_canonical, dict):
        return {}
    rel_path = str(route_canonical.get("exact_queue_draft_path") or "").strip()
    if not rel_path:
        return {}
    target = ROOT / rel_path
    if not target.exists() or not target.is_file():
        return {}
    try:
        data = json.loads(target.read_text())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}

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

def load_exact_profile_draft(route_canonical):
    if not isinstance(route_canonical, dict):
        return {}
    rel_path = str(route_canonical.get("exact_profile_path") or "").strip()
    if not rel_path:
        return {}
    target = ROOT / rel_path
    if not target.exists() or not target.is_file():
        return {}
    try:
        data = json.loads(target.read_text())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}

def exact_profile_followup_allowed(task, task_box, route_canonical):
    capability = classify_task_capability(task)
    if capability not in {"bounded_cpu_eval", "local_workspace_copy"}:
        return False, ""
    if infer_experiment_gate_status(route_canonical, task_box) == "blocked":
        return False, ""
    if task_research_gate_gaps(task, task_box, route_canonical):
        return False, ""

    profile = load_exact_profile_draft(route_canonical)
    if not profile:
        return False, ""

    exact_task_id = str(route_canonical.get("exact_next_task_id") or "").strip() if isinstance(route_canonical, dict) else ""
    profile_task_id = str(profile.get("task_id") or "").strip()
    task_id = str(task.get("task_id") or "").strip()
    if exact_task_id and profile_task_id and profile_task_id != exact_task_id:
        return False, ""
    if exact_task_id and task_id and task_id != exact_task_id:
        return False, ""

    budget_contract = str(
        task.get("budget_contract")
        or profile.get("budget_contract")
        or (route_canonical.get("current_budget_contract") if isinstance(route_canonical, dict) else "")
        or ""
    ).strip()
    timeout_value = (
        task.get("max_runtime_minutes")
        or task.get("timeout_minutes")
        or profile.get("max_runtime_minutes")
        or profile.get("timeout_minutes")
    )
    expected_outputs = task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else task.get("outputs")
    if not isinstance(expected_outputs, list):
        expected_outputs = profile.get("expected_outputs") if isinstance(profile.get("expected_outputs"), list) else profile.get("outputs")

    if capability == "bounded_cpu_eval":
        profile_kind = str(profile.get("profile_kind") or "").strip().lower()
        allowed_runner = str(profile.get("allowed_runner") or task.get("allowed_runner") or "").strip().lower()
        if profile_kind not in {"cpu_followup", "bounded_cpu_eval"}:
            return False, ""
        if allowed_runner and allowed_runner != "cpu":
            return False, ""
        if not budget_contract or not timeout_value or not isinstance(expected_outputs, list) or not any(str(item or "").strip() for item in expected_outputs):
            return False, ""
        return True, "Autonomous route allows one bounded CPU follow-up because the exact profile already defines budget, timeout, and expected outputs."

    profile_kind = str(profile.get("profile_kind") or "").strip().lower()
    workspace_mode = str(profile.get("workspace_mode") or task.get("workspace_mode") or "").strip().lower()
    workspace_root = str(profile.get("workspace_root") or task.get("workspace_root") or "").strip()
    allowed_write_paths = profile.get("allowed_write_paths") if isinstance(profile.get("allowed_write_paths"), list) else task.get("allowed_write_paths")
    if profile_kind != "local_workspace_copy":
        return False, ""
    if workspace_mode not in {"project_local_copy", "local_workspace_copy"}:
        return False, ""
    if not workspace_root:
        return False, ""
    if not isinstance(allowed_write_paths, list) or not any(str(item or "").strip() for item in allowed_write_paths):
        return False, ""
    if not budget_contract or not timeout_value or not isinstance(expected_outputs, list) or not any(str(item or "").strip() for item in expected_outputs):
        return False, ""
    return True, "Autonomous route allows one bounded local workspace follow-up because the exact profile already defines workspace root, write paths, budget, timeout, and expected outputs."

def conditional_queue_enqueue_allowed(task, task_box, route_canonical):
    if classify_task_capability(task) != "queue_enqueue":
        return False, ""
    policy = task_box.get("queue_policy") if isinstance(task_box, dict) else {}
    if not isinstance(policy, dict) or policy.get("allow_conditional_enqueue") is not True:
        return False, ""
    if task_research_gate_gaps(task, task_box, route_canonical):
        return False, ""

    queue_draft = load_exact_queue_draft(route_canonical)
    queue_target = str(
        task.get("queue_target")
        or task.get("queue_name")
        or task.get("queue")
        or queue_draft.get("queue_target")
        or queue_draft.get("queue_name")
        or queue_draft.get("queue")
        or ""
    ).strip()
    command_profile = str(
        task.get("command_profile")
        or task.get("task_profile")
        or task.get("profile_path")
        or queue_draft.get("command_profile")
        or queue_draft.get("task_profile")
        or queue_draft.get("profile_path")
        or ""
    ).strip()
    budget_contract = str(task.get("budget_contract") or policy.get("budget_contract") or (route_canonical.get("current_budget_contract") if isinstance(route_canonical, dict) else "") or "").strip()
    if not budget_contract:
        budget_contract = str(queue_draft.get("budget_contract") or "").strip()
    expected_outputs = task.get("expected_outputs") if isinstance(task.get("expected_outputs"), list) else task.get("outputs")
    if not isinstance(expected_outputs, list):
        expected_outputs = queue_draft.get("expected_outputs") if isinstance(queue_draft.get("expected_outputs"), list) else queue_draft.get("outputs")
    timeout_value = task.get("max_runtime_minutes") or task.get("timeout_minutes") or queue_draft.get("max_runtime_minutes") or queue_draft.get("timeout_minutes")

    if not queue_target or not command_profile or not budget_contract or not expected_outputs or not timeout_value:
        return False, ""
    if not isinstance(expected_outputs, list) or not any(str(item or "").strip() for item in expected_outputs):
        return False, ""

    text = task_policy_text(task, task.get("supervisor_approval") if isinstance(task, dict) else None)
    queue_only_policy = {"capabilities": {"queue_enqueue": True}}
    rejection = supervisor_policy_rejection(queue_only_policy, "queue_enqueue", text)
    if rejection:
        return False, ""
    if queue_draft:
        return True, "Autonomous queue policy allows one controlled queue enqueue because the exact queue draft already defines queue target, profile, budget, timeout, and expected outputs."
    return True, "Autonomous queue policy allows one controlled queue enqueue because exact queue target, profile, budget, timeout, and expected outputs are all defined."

def local_unblock_reason(state, task_box, route_canonical, run_state=None, progress=None):
    review_text = read_text("agent/REVIEW_PENDING.md")
    blockers_text = read_text("agent/BLOCKERS.md")
    run_summary = {
        "blocker_type": str((run_state or {}).get("blocker_type") or ""),
        "requires_human_review": bool((run_state or {}).get("requires_human_review")),
        "next_action": (run_state or {}).get("next_action") or {},
        "exact_next_task_id": str((run_state or {}).get("exact_next_task_id") or ""),
        "exact_profile_path": str((run_state or {}).get("exact_profile_path") or ""),
        "exact_queue_draft_path": str((run_state or {}).get("exact_queue_draft_path") or ""),
        "exact_next_object_path": str((run_state or {}).get("exact_next_object_path") or ""),
        "required_successor_exactness": str((run_state or {}).get("required_successor_exactness") or ""),
        "successor_materialization_status": str((run_state or {}).get("successor_materialization_status") or ""),
        "experiment_gate_status": str((run_state or {}).get("experiment_gate_status") or ""),
    }
    progress_summary = {
        "current_blocker": str((progress or {}).get("current_blocker") or ""),
        "requires_human_review": bool((progress or {}).get("requires_human_review")),
        "next_safe_action": (progress or {}).get("next_safe_action") or {},
        "exact_next_task_id": str((progress or {}).get("exact_next_task_id") or ""),
        "exact_profile_path": str((progress or {}).get("exact_profile_path") or ""),
        "exact_queue_draft_path": str((progress or {}).get("exact_queue_draft_path") or ""),
        "exact_next_object_path": str((progress or {}).get("exact_next_object_path") or ""),
        "required_successor_exactness": str((progress or {}).get("required_successor_exactness") or ""),
        "successor_materialization_status": str((progress or {}).get("successor_materialization_status") or ""),
        "experiment_gate_status": str((progress or {}).get("experiment_gate_status") or ""),
    }
    combined = "\\n".join([
        review_text,
        blockers_text,
        json.dumps(run_summary, sort_keys=True),
        json.dumps(progress_summary, sort_keys=True),
    ]).lower()
    scope = field_value(review_text, "scope")
    resolver = field_value(review_text, "resolver")
    autonomous = autonomous_mode(state, task_box, route_canonical)
    exact_profile_exists = bool(load_exact_profile_draft(route_canonical))
    exact_queue_exists = bool(load_exact_queue_draft(route_canonical))

    mismatch = route_epoch_mismatch(route_canonical, state, progress or {}, run_state or {})
    if mismatch:
        return "state_reconcile", mismatch

    exact_task_id = str((route_canonical or {}).get("exact_next_task_id") or "").strip()
    if autonomous and exact_task_id:
        task_box_ids = [str(task.get("task_id") or "").strip() for task in task_box_pending_tasks(task_box)]
        state_ids = [str(task.get("task_id") or "").strip() for task in pending_tasks(state)]
        draft_id = str(load_next_task_draft(ROOT).get("task_id") or "").strip()
        if task_box_ids and exact_task_id not in task_box_ids:
            return "state_reconcile", f"Canonical route exact_next_task_id={exact_task_id} but TASK_BOX.json pending tasks still point at {', '.join(task_box_ids)}; reconcile derived task mirrors before continuing."
        if draft_id and draft_id != exact_task_id:
            return "state_reconcile", f"Canonical route exact_next_task_id={exact_task_id} but NEXT_TASK_DRAFT.json still points at {draft_id}; reconcile derived task mirrors before continuing."
        if state_ids and exact_task_id not in state_ids:
            return "state_reconcile", f"Canonical route exact_next_task_id={exact_task_id} but STATE.json pending tasks still point at {', '.join(state_ids)}; reconcile derived task mirrors before continuing."

    if autonomous and infer_experiment_gate_status(route_canonical, task_box) == "blocked" and str(route_canonical.get("exact_next_task_id") or "").strip():
        return "state_reconcile", "Experiment decision gate is explicitly blocked; keep the exact successor contract synchronized, but do not execute the successor until the gate clears."

    if autonomous and isinstance(state, dict) and state.get("requires_review") is True:
        return "state_reconcile", "Canonical autonomy says requires_review=false but STATE.json still says requires_review=true; reconcile the stale derived state locally."

    if autonomous and (
        field_value(blockers_text, "blocker type") in {"stale_state", "stale_route_text"}
        or str((run_state or {}).get("blocker_type") or "").strip().lower() in {"stale_state", "stale_route_text"}
    ):
        return "state_reconcile", "Autonomous route is blocked only by stale local watchdog state; reconcile derived files locally."

    if autonomous and field_value(review_text, "state") in REVIEW_STATES:
        if scope in {"", "none", "report_only", "bookkeeping"} and resolver in {"", "none", "supervisor"}:
            return "stale_marker_cleanup", "Autonomous route is blocked by a stale bookkeeping review marker; clear the stale marker and continue."

    if autonomous and (
        "missing_profile" in combined
        or "missing profile" in combined
        or "profile package" in combined
        or "task profile" in combined
    ) and not exact_profile_exists:
        return "local_profile_authoring", "Autonomous route is blocked only by a missing local task/profile package; author it locally and continue."

    if autonomous and (
        "queue draft" in combined
        or "draft queue" in combined
        or "prepare queue request" in combined
        or "prepare taskbox" in combined
    ) and not exact_queue_exists:
        return "local_queue_draft_authoring", "Autonomous route can prepare a local queue draft/taskbox without performing a controlled enqueue yet."

    next_task_draft = load_next_task_draft(ROOT)
    if autonomous and successor_contract_gap(route_canonical, next_task_draft):
        return "state_reconcile", "Canonical route says a successor contract is required, but no exact next task/profile/queue object exists yet; repair the successor contract locally before continuing."

    if autonomous and (
        "nvidia-smi" in combined
        or "sandbox visibility" in combined
        or "unknown_in_current_environment" in combined
        or "sandbox_visibility_limited" in combined
    ) and not (
        "host_has_no_gpu" in combined
        or "real gpu outage" in combined
        or "queue runner failed" in combined
    ):
        return "state_reconcile", "Only sandbox-local GPU visibility is failing; treat it as advisory and continue via queue-aware local reconciliation."

    return "", ""

def supervisor_targets():
    targets = []
    raw_targets = os.environ.get("WATCHDOG_SUPERVISOR_TARGETS", "")
    for item in raw_targets.split(":"):
        item = item.strip()
        if item:
            targets.append(Path(item))
    config = load_json(ROOT / "agent" / "supervisor_targets.json", {})
    config_targets = config.get("targets") if isinstance(config, dict) else None
    if isinstance(config_targets, list):
        for item in config_targets:
            if isinstance(item, str) and item.strip():
                targets.append(ROOT / item.strip())
    return targets

def classify_delegable_next_action(next_action):
    kind = str(next_action.get("kind") or "").lower()
    desc = str(next_action.get("description") or "").lower()
    reason = str(next_action.get("reason") or "").lower()
    text = f"{kind}\\n{desc}\\n{reason}"
    if kind != "propose_review":
        return "", text
    if "report-only" in text or "report_only" in text or "static audit" in text or "proposal" in text or "inventory" in text:
        return "report_only", text
    if (
        "project_local_copy" in text
        or "project-local-copy" in text
        or "local workspace" in text
        or "workspace/<task_id>" in text
        or "copy into workspace" in text
    ):
        return "local_workspace_copy", text
    if "missing_profile" in text or "missing profile" in text or "task profile" in text or "profile package" in text:
        return "local_profile_authoring", text
    if "queue draft" in text or "draft queue" in text or "prepare taskbox" in text or "prepare queue request" in text:
        return "local_queue_draft_authoring", text
    if ("cpu-only" in text or "cpu32" in text or "bounded cpu" in text or "32-sample" in text or "sample_count=32" in text) and (
        "eval" in text or "smoke" in text or "helper" in text or "probe" in text
    ):
        return "bounded_cpu_eval", text
    if "queue" in text or "enqueue" in text or "agent/queue" in text or "gpu_queue" in text:
        return "queue_enqueue", text
    if "gpu" in text and ("bounded" in text or "probe" in text or "smoke" in text or "eval" in text or "sample" in text):
        return "bounded_gpu_probe", text
    if ("training" in text or "train " in text) and ("bounded" in text or "canary" in text or "smoke" in text):
        return "bounded_training_canary", text
    return "", text

def supervisor_delegable_blocker():
    for target in supervisor_targets():
        target_policy = load_supervisor_capability_policy(target)
        target_state = load_json(target / "agent" / "STATE.json", {})
        target_task_box = load_task_box(target)
        target_route = load_route_canonical(target)
        target_run_state = load_json(target / "agent" / "RUN_STATE.json", {})
        target_progress = load_json(target / "agent" / "PROGRESS_STATE.json", {})
        target_review_text = read_text_path(target / "agent" / "REVIEW_PENDING.md").lower()
        target_blockers_text = read_text_path(target / "agent" / "BLOCKERS.md").lower()
        combined = "\\n".join([
            target_review_text,
            target_blockers_text,
            json.dumps(target_run_state or {}, sort_keys=True),
            json.dumps(target_progress or {}, sort_keys=True),
        ])
        if "missing_profile" in combined or "missing profile" in combined or "task profile" in combined:
            if capability_enabled(target_policy, "local_profile_authoring"):
                return {"target": str(target), "capability": "local_profile_authoring"}
        if field_value(target_blockers_text, "blocker type") in {"stale_state", "stale_route_text"} or str((target_run_state or {}).get("blocker_type") or "").strip().lower() in {"stale_state", "stale_route_text"}:
            if capability_enabled(target_policy, "state_reconcile"):
                return {"target": str(target), "capability": "state_reconcile"}
        if field_value(target_review_text, "state") in REVIEW_STATES and field_value(target_review_text, "scope") in {"", "none", "report_only", "bookkeeping"}:
            if capability_enabled(target_policy, "stale_marker_cleanup"):
                return {"target": str(target), "capability": "stale_marker_cleanup"}
        if "queue draft" in combined or "draft queue" in combined or "prepare queue request" in combined or "prepare taskbox" in combined:
            if capability_enabled(target_policy, "local_queue_draft_authoring"):
                return {"target": str(target), "capability": "local_queue_draft_authoring"}

        progress = load_json(target / "agent" / "PROGRESS_STATE.json", {})
        if not isinstance(progress, dict) or progress.get("requires_human_review") is not True:
            continue
        next_action = progress.get("next_safe_action")
        if not isinstance(next_action, dict):
            continue
        capability, text = classify_delegable_next_action(next_action)
        if not capability:
            continue
        if not capability_enabled(target_policy, capability):
            continue
        if supervisor_policy_rejection(target_policy, capability, text):
            continue
        return {"target": str(target), "capability": capability}
    return ""

def route():
    state = load_json(ROOT / "agent" / "STATE.json", {})
    task_box = load_task_box(ROOT)
    route_canonical = load_route_canonical(ROOT)
    next_task_draft = load_next_task_draft(ROOT)
    progress = load_json(ROOT / "agent" / "PROGRESS_STATE.json", {})
    run_state = load_json(ROOT / "agent" / "RUN_STATE.json", {})
    paused = (ROOT / "agent" / "control" / "PAUSE").exists()
    compaction_due = os.environ.get("WATCHDOG_COMPACTION_DUE") == "1"
    role = os.environ.get("WATCHDOG_ROLE", "runner")
    supervisor_mode = os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")

    if paused:
        return {
            "primary_skill": "watchdog-handoff-writer",
            "reason": "agent/control/PAUSE exists; no Codex work should be started.",
            "stop_condition": "Write paused status and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if role == "supervisor":
        delegable = supervisor_delegable_blocker()
        if supervisor_mode in ("audit", "light") and delegable:
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"Supervisor delegated runner blocker found in {delegable.get('target')} with capability={delegable.get('capability')}.",
                "stop_condition": "Resolve one safe local runner blocker by writing compact approval/status notes, a reconciliation patch, or a bounded local package/draft, then stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": "supervisor-delegated-runner-blocker-approval"
            }
        if supervisor_mode == "audit":
            return {
                "primary_skill": "watchdog-cleanup-auditor",
                "reason": "Supervisor heavy audit is due by runner-cycle cadence.",
                "stop_condition": "Run one read-only audit for anti-snowball, leakage, environment, stale state, and blocker hygiene; write compact handoff outputs and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        if supervisor_mode == "light":
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": "Supervisor lightweight follow-up is due after a runner cycle or reviewer/blocker marker.",
                "stop_condition": "Repair only safe stale-state, stale-marker, missing-profile, queue-draft, or blocker-bookkeeping issues and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        return {
            "primary_skill": "watchdog-handoff-writer",
            "reason": "Supervisor standby: no new runner cycle and heavy audit cadence is not due.",
            "stop_condition": "Write a short heartbeat and stop without operational changes.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if has_files("agent/queue/running", "gpu_running", "cpu_running"):
        return {
            "primary_skill": "watchdog-job-queue",
            "reason": "A running job is present; monitor exactly one running job.",
            "stop_condition": "Update queue status and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if has_files("agent/queue/done", "gpu_done", "cpu_done", freshness_minutes=RESULT_FRESH_MINUTES):
        return {
            "primary_skill": "watchdog-gate-evaluator",
            "reason": "A completed job/result is present and may need gate evaluation.",
            "stop_condition": "Evaluate one completed result or write a blocker, then stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if has_files("agent/queue/queued", "gpu_queue", "cpu_queue"):
        return {
            "primary_skill": "watchdog-job-queue",
            "reason": "A queued job is present; inspect queue state and avoid duplicate submission.",
            "stop_condition": "Update queue status and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    pending, pending_source = preferred_pending_tasks(state, task_box, next_task_draft, route_canonical)
    if pending:
        local_capability, local_reason = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
        if local_capability:
            task = pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": local_reason,
                "stop_condition": "Perform exactly one safe local unblock or derived-state reconcile, refresh compact state, and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        research_gap_pending = []
        for task in pending:
            gaps = task_research_gate_gaps(task, task_box, route_canonical)
            if gaps:
                research_gap_pending.append((task, gaps))
        if research_gap_pending:
            task, gaps = research_gap_pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected task is missing research-contract fields: {', '.join(gaps)}. Repair TASK_BOX/task metadata locally before executing the bounded step.",
                "stop_condition": "Add the missing topic/claim/fairness/value-of-information fields to the structured task contract, refresh compact state, and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        report_only_pending = [t for t in pending if task_is_report_only(t)]
        if report_only_pending:
            task = report_only_pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected report-only task can proceed without human-review handoff.",
                "stop_condition": "Choose one report-only next safe action or write a blocker, then stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        supervisor_approved_pending = [t for t in pending if task_is_supervisor_approved(t)]
        if supervisor_approved_pending:
            task = supervisor_approved_pending[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected bounded task has explicit supervisor approval.",
                "stop_condition": "Execute or prepare exactly one supervisor-approved bounded task within its approval scope; write outputs/provenance or a blocker, then stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        if autonomous_mode(state, task_box, route_canonical):
            for task in pending:
                capability = classify_task_capability(task)
                if capability == "queue_enqueue":
                    queue_allowed, queue_reason = conditional_queue_enqueue_allowed(task, task_box, route_canonical)
                    if queue_allowed:
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; {queue_reason}",
                            "stop_condition": "Perform exactly one controlled queue enqueue inside the declared queue boundary, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                    queue_draft = load_exact_queue_draft(route_canonical)
                    if queue_draft:
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; exact queue draft is already materialized, but autonomous enqueue is still disabled by queue policy, so keep the draft explicit and refresh NEXT_ACTION instead of stalling.",
                            "stop_condition": "Do not enqueue yet; keep the exact queue/profile draft coherent, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                    queue_text = task_policy_text(task, task.get("supervisor_approval") if isinstance(task, dict) else None)
                    queue_only_policy = {"capabilities": {"queue_enqueue": True}}
                    if not supervisor_policy_rejection(queue_only_policy, "queue_enqueue", queue_text):
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; queue enqueue is not yet executable, so prepare the exact queue/profile draft locally and refresh NEXT_ACTION instead of stalling.",
                            "stop_condition": "Author or repair exactly one local queue draft/profile package, do not enqueue yet, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                if capability in {"bounded_cpu_eval", "local_workspace_copy"}:
                    profile_allowed, profile_reason = exact_profile_followup_allowed(task, task_box, route_canonical)
                    if profile_allowed:
                        return {
                            "primary_skill": "watchdog-orchestrator",
                            "reason": f"{len(pending)} pending task(s) exist in {pending_source}; {profile_reason}",
                            "stop_condition": "Execute or prepare exactly one bounded local follow-up inside the exact profile contract, refresh compact state, and stop.",
                            "permission_guardian_required": False,
                            "permission_guardian_result": "not_required",
                            "route_locked": True,
                            "task_id": task.get("task_id")
                        }
                if safe_autonomous_capability(capability):
                    return {
                        "primary_skill": "watchdog-orchestrator",
                        "reason": f"{len(pending)} pending task(s) exist in {pending_source}; autonomous mode allows one bounded {capability} step without waiting on unrelated review markers.",
                        "stop_condition": "Execute or prepare exactly one bounded local autonomous task, refresh compact state, and stop.",
                        "permission_guardian_required": False,
                        "permission_guardian_result": "not_required",
                        "route_locked": True,
                        "task_id": task.get("task_id")
                    }
        review_blocked, review_reason = active_review_marker(state)
        if review_blocked:
            return {
                "primary_skill": "watchdog-handoff-writer",
                "reason": review_reason,
                "stop_condition": "Write one review-required handoff and stop; do not auto-approve executable or mutation work.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        selected = pending[0]
        guardian_needed = permission_guardian_needed(selected)
        return {
            "primary_skill": "watchdog-orchestrator",
            "reason": f"{len(pending)} pending task(s) exist in {pending_source}.",
            "stop_condition": "Choose one next safe bounded action or write a blocker, then stop.",
            "permission_guardian_required": guardian_needed,
            "permission_guardian_result": "not_required" if not guardian_needed else "pending",
            "route_locked": True,
            "task_id": selected.get("task_id")
        }

    if todo_has_pending():
        local_capability, local_reason = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
        if local_capability:
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": local_reason,
                "stop_condition": "Perform one safe local unblock, refresh compact state, and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True
            }
        return {
            "primary_skill": "watchdog-orchestrator",
            "reason": "agent/TODO.md contains a pending or unchecked task but STATE/TASK_BOX has no runnable structured task; continue with one bounded next step while asking daily mode to structure the task box if needed.",
            "stop_condition": "Choose one bounded next step or write a blocker asking daily mode to structure TASK_BOX.json/STATE.json, then stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    if compaction_due:
        return {
            "primary_skill": "watchdog-report-curator",
            "reason": "Scheduled compaction cycle is due and no higher-priority active work was found.",
            "stop_condition": "Refresh compact state/report outputs and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    review_blocked, review_reason = active_review_marker(state)
    local_capability, local_reason = local_unblock_reason(state, task_box, route_canonical, run_state, progress)
    if local_capability:
        return {
            "primary_skill": "watchdog-orchestrator",
            "reason": local_reason,
            "stop_condition": "Perform one safe local unblock or state reconcile and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }
    if review_blocked:
        return {
            "primary_skill": "watchdog-handoff-writer",
            "reason": review_reason,
            "stop_condition": "Write one review-required handoff and stop.",
            "permission_guardian_required": False,
            "permission_guardian_result": "not_required",
            "route_locked": True
        }

    return {
        "primary_skill": "watchdog-handoff-writer",
        "reason": "No paused state, running job, completed result, review request, queued job, or pending STATE/TASK_BOX task was found.",
        "stop_condition": "Write idle/blocked status and stop.",
        "permission_guardian_required": False,
        "permission_guardian_result": "not_required",
        "route_locked": True
    }

state = load_json(ROOT / "agent" / "STATE.json", {})
task_box = load_task_box(ROOT)
route_canonical = load_route_canonical(ROOT)
next_task_draft = load_next_task_draft(ROOT)
progress = load_json(ROOT / "agent" / "PROGRESS_STATE.json", {})
run_state = load_json(ROOT / "agent" / "RUN_STATE.json", {})
role = os.environ.get("WATCHDOG_ROLE", "runner")
supervisor_mode = os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")

result = route()
route_capability = route_capability_from_result(result, role, supervisor_mode, state, task_box, next_task_draft, route_canonical, run_state, progress)
result["secondary_skills"] = selected_secondary_skills(result, role, supervisor_mode, route_capability)
result["route_capability"] = route_capability or None
payload = {
    "route_version": 1,
    "updated_utc": now_utc(),
    **result
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(payload, indent=2) + "\\n")
print(json.dumps(payload, indent=2))
`,

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
    for key in ("project_question", "decision_relevance", "uncertainty_reduced_if_success", "uncertainty_reduced_if_failure", "claim_scope", "diagnosis_target"):
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
    for key in ("exact_next_task_id", "exact_profile_path", "exact_queue_draft_path", "exact_next_object_path", "required_successor_exactness", "successor_materialization_status", "experiment_gate_status"):
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
`,

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
  pythonScriptTemplates
};
