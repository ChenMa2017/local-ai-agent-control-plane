"use strict";

const renderReportSuccessor = `def infer_successor_allowed_runner(next_action, route_canonical, queue_request_draft, task_profile_draft):
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
        "current_conclusion_topic_id": (task_box or {}).get("current_conclusion_topic_id") or (route_canonical or {}).get("current_conclusion_topic_id") or state.get("current_conclusion_topic_id"),
        "current_conclusion_query": (task_box or {}).get("current_conclusion_query") or (route_canonical or {}).get("current_conclusion_query") or state.get("current_conclusion_query"),
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

`;

module.exports = {
  renderReportSuccessor
};
