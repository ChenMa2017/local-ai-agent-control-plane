"use strict";

const pythonRouteSkillTemplates = {
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
`
};

module.exports = {
  pythonRouteSkillTemplates
};
