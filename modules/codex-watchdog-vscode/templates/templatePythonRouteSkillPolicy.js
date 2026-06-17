"use strict";

const routeSkillPolicy = `def task_is_report_only(task):
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
    failures = []
    seen = set()
    for skill in config.get("skills", []):
        if not isinstance(skill, dict):
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
        if skill.get("required") is True and skill.get("enabled") is not True:
            failures.append({
                "skill_id": skill_id,
                "path": str(skill.get("path") or "").strip(),
                "reason": "required secondary skill is disabled",
            })
            continue
        if skill.get("enabled") is not True:
            continue
        if skill.get("resolved") is not True:
            if skill.get("required") is True:
                failures.append({
                    "skill_id": skill_id,
                    "path": str(skill.get("path") or "").strip(),
                    "reason": str(skill.get("resolution_error") or "required secondary skill could not be resolved"),
                })
            continue
        selected.append({
            "skill_id": skill_id,
            "path": str(skill.get("path") or "").strip(),
        })
    return {
        "selected": selected,
        "failures": failures,
    }

`;

module.exports = {
  routeSkillPolicy
};
