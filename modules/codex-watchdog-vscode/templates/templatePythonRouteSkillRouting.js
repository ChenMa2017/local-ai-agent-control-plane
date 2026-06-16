"use strict";

const routeSkillRouting = `def research_gate_policy(task_box):
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

def research_program_task_type(capability):
    return {
        "local_workspace_copy": "bounded_execution",
        "local_profile_authoring": "experiment_design",
        "local_queue_draft_authoring": "experiment_design",
        "bounded_cpu_eval": "bounded_execution",
        "bounded_gpu_probe": "bounded_execution",
        "bounded_training_canary": "bounded_execution",
        "queue_enqueue": "bounded_execution",
    }.get(capability, "")

def task_research_program_assessment(task, task_box, route_canonical=None, research_program=None):
    capability = classify_task_capability(task)
    task_type = research_program_task_type(capability)
    assessment = {
        "task_type": task_type,
        "project_area": task_contract_value(task, task_box, "project_area"),
        "repair_fields": [],
        "violations": [],
    }
    if not task_type:
        return assessment

    if research_program is None:
        research_program = load_research_program(ROOT)
    if not isinstance(research_program, dict) or not research_program:
        assessment["violations"].append("research/RESEARCH_PROGRAM.json is missing or unreadable")
        return assessment
    if research_program.get("schema_version") != "research_program.v0.1":
        assessment["violations"].append("research/RESEARCH_PROGRAM.json schema_version must be research_program.v0.1")
        return assessment

    domain = research_program.get("domain") if isinstance(research_program.get("domain"), dict) else {}
    autonomy = research_program.get("autonomy_policy") if isinstance(research_program.get("autonomy_policy"), dict) else {}

    allowed_task_types = set(normalize_string_list(autonomy.get("allowed_task_types")))
    forbidden_task_types = set(normalize_string_list(autonomy.get("forbidden_task_types")))
    if allowed_task_types and task_type not in allowed_task_types:
        assessment["violations"].append(
            f"RESEARCH_PROGRAM autonomy_policy.allowed_task_types does not allow task_type={task_type}"
        )
    if task_type in forbidden_task_types:
        assessment["violations"].append(
            f"RESEARCH_PROGRAM autonomy_policy.forbidden_task_types forbids task_type={task_type}"
        )

    allowed_project_areas = set(normalize_string_list(domain.get("allowed_project_areas")))
    forbidden_project_areas = set(normalize_string_list(domain.get("forbidden_project_areas")))
    project_area = assessment["project_area"]
    if allowed_project_areas or forbidden_project_areas:
        if not project_area:
            assessment["repair_fields"].append("project_area")
        else:
            if allowed_project_areas and project_area not in allowed_project_areas:
                assessment["violations"].append(
                    f"project_area={project_area} is outside RESEARCH_PROGRAM domain.allowed_project_areas"
                )
            if project_area in forbidden_project_areas:
                assessment["violations"].append(
                    f"project_area={project_area} is forbidden by RESEARCH_PROGRAM domain.forbidden_project_areas"
                )

    return assessment

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

def exact_profile_followup_allowed(task, task_box, route_canonical, research_program=None):
    capability = classify_task_capability(task)
    if capability not in {"bounded_cpu_eval", "local_workspace_copy"}:
        return False, ""
    if infer_experiment_gate_status(route_canonical, task_box) == "blocked":
        return False, ""
    if task_research_gate_gaps(task, task_box, route_canonical):
        return False, ""
    assessment = task_research_program_assessment(task, task_box, route_canonical, research_program)
    if assessment.get("repair_fields") or assessment.get("violations"):
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

def conditional_queue_enqueue_allowed(task, task_box, route_canonical, research_program=None):
    if classify_task_capability(task) != "queue_enqueue":
        return False, ""
    policy = task_box.get("queue_policy") if isinstance(task_box, dict) else {}
    if not isinstance(policy, dict) or policy.get("allow_conditional_enqueue") is not True:
        return False, ""
    if task_research_gate_gaps(task, task_box, route_canonical):
        return False, ""
    assessment = task_research_program_assessment(task, task_box, route_canonical, research_program)
    if assessment.get("repair_fields") or assessment.get("violations"):
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
    research_program = load_research_program(ROOT)
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
        research_program_repairs = []
        research_program_violations = []
        for task in pending:
            assessment = task_research_program_assessment(task, task_box, route_canonical, research_program)
            if assessment.get("violations"):
                research_program_violations.append((task, assessment))
            elif assessment.get("repair_fields"):
                research_program_repairs.append((task, assessment))
        if research_program_violations:
            task, assessment = research_program_violations[0]
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected task violates the RESEARCH_PROGRAM boundary: {'; '.join(assessment.get('violations', []))}. Align TASK_BOX or research/RESEARCH_PROGRAM.json before executing the bounded step.",
                "stop_condition": "Repair one RESEARCH_PROGRAM/task alignment issue locally, refresh compact state, and stop.",
                "permission_guardian_required": False,
                "permission_guardian_result": "not_required",
                "route_locked": True,
                "task_id": task.get("task_id")
            }
        if research_program_repairs:
            task, assessment = research_program_repairs[0]
            repair_fields = sorted(set(assessment.get("repair_fields", [])))
            return {
                "primary_skill": "watchdog-orchestrator",
                "reason": f"{len(pending)} pending task(s) exist in {pending_source}; selected task is missing RESEARCH_PROGRAM alignment fields: {', '.join(repair_fields)}. Repair TASK_BOX/task metadata locally before executing the bounded step.",
                "stop_condition": "Add the missing RESEARCH_PROGRAM alignment fields to the structured task contract, refresh compact state, and stop.",
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
                    queue_allowed, queue_reason = conditional_queue_enqueue_allowed(task, task_box, route_canonical, research_program)
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
                    profile_allowed, profile_reason = exact_profile_followup_allowed(task, task_box, route_canonical, research_program)
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
`;

module.exports = {
  routeSkillRouting
};
