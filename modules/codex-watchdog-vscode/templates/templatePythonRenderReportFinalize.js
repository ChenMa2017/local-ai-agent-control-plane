"use strict";

const renderReportFinalize = `def blocker_type(blocked_items, requires_review, human_reason):
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

def load_json_default(path, default):
    target = Path(path)
    if not target.exists():
        return default
    try:
        return json.loads(target.read_text())
    except Exception:
        return default

def load_jsonl_records(path):
    target = Path(path)
    if not target.exists():
        return []
    records = []
    for line in target.read_text().splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except Exception:
            continue
    return records

def parse_timestamp_or_none(value):
    if value in (None, ""):
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))

def records_by_id(records, key):
    result = {}
    for record in records:
        if not isinstance(record, dict):
            continue
        record_id = str(record.get(key) or "").strip()
        if record_id:
            result[record_id] = record
    return result

def research_conclusion_policy(program):
    evidence_policy = program.get("evidence_policy") if isinstance(program.get("evidence_policy"), dict) else {}
    conclusion_policy = program.get("conclusion_policy") if isinstance(program.get("conclusion_policy"), dict) else {}
    return {
        "allowed_conclusion_statuses": set(normalized_string_list(conclusion_policy.get("allowed_conclusion_statuses"))),
        "publish_only_after_review": conclusion_policy.get("publish_only_after_review") is True,
        "require_staleness_tracking": conclusion_policy.get("require_staleness_tracking") is True,
        "require_invalidation_path": conclusion_policy.get("require_invalidation_path") is True,
        "require_primary_evidence_for_confirmed_claims": evidence_policy.get("require_primary_evidence_for_confirmed_claims") is True,
        "require_index_entry_for_cited_files": evidence_policy.get("require_index_entry_for_cited_files") is True,
    }

def validate_current_conclusion_update(update, docs_by_id, experiments_by_id, policy):
    errors = []
    if not update:
        return errors
    for field in ("topic_id", "topic", "conclusion_status", "claim", "evidence_scope"):
        if not isinstance(update.get(field), str) or not str(update.get(field) or "").strip():
            errors.append(f"current_conclusion_update.{field} must be a nonempty string")
    supporting_docs = update.get("supporting_docs")
    supporting_experiments = update.get("supporting_experiments")
    if not isinstance(supporting_docs, list):
        errors.append("current_conclusion_update.supporting_docs must be an array")
        supporting_docs = []
    if not isinstance(supporting_experiments, list):
        errors.append("current_conclusion_update.supporting_experiments must be an array")
        supporting_experiments = []
    if not isinstance(update.get("risk_flags"), list):
        errors.append("current_conclusion_update.risk_flags must be an array")
    try:
        parse_timestamp_or_none(update.get("last_reviewed_at"))
    except Exception:
        errors.append("current_conclusion_update.last_reviewed_at must be ISO-8601 or null")
    stale_after_days = update.get("stale_after_days")
    if stale_after_days not in (None, "") and (not isinstance(stale_after_days, int) or stale_after_days < 0):
        errors.append("current_conclusion_update.stale_after_days must be a nonnegative integer or null")
    allowed_statuses = policy.get("allowed_conclusion_statuses") or set()
    status = str(update.get("conclusion_status") or "").strip()
    if allowed_statuses and status not in allowed_statuses:
        errors.append(f"current_conclusion_update.conclusion_status is outside RESEARCH_PROGRAM allowed_conclusion_statuses: {status!r}")
    if policy.get("require_staleness_tracking"):
        if update.get("last_reviewed_at") in (None, ""):
            errors.append("current_conclusion_update.last_reviewed_at is required by RESEARCH_PROGRAM conclusion_policy.require_staleness_tracking")
        if stale_after_days in (None, ""):
            errors.append("current_conclusion_update.stale_after_days is required by RESEARCH_PROGRAM conclusion_policy.require_staleness_tracking")
    invalidated_by = str(update.get("invalidated_by") or "").strip()
    if status == "invalidated" and policy.get("require_invalidation_path") and not invalidated_by:
        errors.append("current_conclusion_update.invalidated_by is required for invalidated conclusions by RESEARCH_PROGRAM")
    if policy.get("require_index_entry_for_cited_files"):
        for doc_id in supporting_docs:
            if str(doc_id or "").strip() not in docs_by_id:
                errors.append(f"current_conclusion_update.supporting_docs references unknown doc_id: {doc_id}")
        for experiment_id in supporting_experiments:
            if str(experiment_id or "").strip() not in experiments_by_id:
                errors.append(f"current_conclusion_update.supporting_experiments references unknown experiment_id: {experiment_id}")
    support_scopes = []
    for doc_id in supporting_docs:
        record = docs_by_id.get(str(doc_id or "").strip())
        if isinstance(record, dict):
            support_scopes.append(str(record.get("evidence_scope") or ""))
    for experiment_id in supporting_experiments:
        record = experiments_by_id.get(str(experiment_id or "").strip())
        if isinstance(record, dict):
            support_scopes.append(str(record.get("evidence_scope") or ""))
    if status == "confirmed":
        if not supporting_docs and not supporting_experiments:
            errors.append("current_conclusion_update confirmed conclusion must cite supporting_docs or supporting_experiments")
        if policy.get("require_primary_evidence_for_confirmed_claims") and not any(
            scope in {"primary_only", "mixed"} for scope in support_scopes
        ):
            errors.append("current_conclusion_update confirmed conclusion must include primary or mixed evidence per RESEARCH_PROGRAM")
    return errors

def upsert_current_conclusions(current_conclusions, update, updated_utc):
    data = current_conclusions if isinstance(current_conclusions, dict) else {}
    items = data.get("items") if isinstance(data.get("items"), list) else []
    normalized_update = dict(update)
    normalized_update["topic_id"] = str(update.get("topic_id") or "").strip()
    replaced = False
    next_items = []
    for item in items:
        if isinstance(item, dict) and str(item.get("topic_id") or "").strip() == normalized_update["topic_id"]:
            next_items.append(normalized_update)
            replaced = True
        else:
            next_items.append(item)
    if not replaced:
        next_items.append(normalized_update)
    return {
        "schema_version": "current_conclusions.v0.1",
        "updated_at": updated_utc,
        "items": next_items,
    }

current_conclusion_update = clean_object(data.get("current_conclusion_update"))
current_conclusion_update_status = "none"
current_conclusion_output_path = ""
current_conclusion_proposal_path = ""
current_conclusion_topic_id = str(current_conclusion_update.get("topic_id") or "").strip() if current_conclusion_update else ""
if current_conclusion_update:
    docs_by_id = records_by_id(load_jsonl_records("project_index/document_index.jsonl"), "doc_id")
    experiments_by_id = records_by_id(load_jsonl_records("project_index/experiment_index.jsonl"), "experiment_id")
    conclusion_policy = research_conclusion_policy(research_program if isinstance(research_program, dict) else {})
    conclusion_errors = validate_current_conclusion_update(
        current_conclusion_update,
        docs_by_id,
        experiments_by_id,
        conclusion_policy,
    )
    if conclusion_errors:
        raise SystemExit("current_conclusion_update violates RESEARCH_PROGRAM/current_conclusions policy: " + "; ".join(conclusion_errors))
    if conclusion_policy.get("publish_only_after_review") and not bool(data.get("requires_human_review")):
        raise SystemExit("current_conclusion_update requires requires_human_review=true because RESEARCH_PROGRAM conclusion_policy.publish_only_after_review=true")
    if bool(data.get("requires_human_review")):
        proposal_dir = Path("research/proposals/current_conclusions")
        proposal_dir.mkdir(parents=True, exist_ok=True)
        proposal_name = safe_name(data.get("timestamp_utc", updated))
        current_conclusion_proposal_path = str(proposal_dir / f"{proposal_name}.json")
        atomic_write_json(current_conclusion_proposal_path, {
            "schema_version": 1,
            "generated_at": updated,
            "research_program_id": research_program_info.get("program_id"),
            "publish_only_after_review": conclusion_policy.get("publish_only_after_review"),
            "current_conclusion_update": current_conclusion_update,
        })
        current_conclusion_update_status = "review_required"
    else:
        current_conclusions = load_json_default("project_index/current_conclusions.json", {
            "schema_version": "current_conclusions.v0.1",
            "updated_at": None,
            "items": [],
        })
        updated_current_conclusions = upsert_current_conclusions(current_conclusions, current_conclusion_update, updated)
        current_conclusion_output_path = "project_index/current_conclusions.json"
        atomic_write_json(current_conclusion_output_path, updated_current_conclusions)
        current_conclusion_update_status = "applied"

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
    f"Research program: {research_program_info.get('program_id') or 'none'}",
    f"Research domain: {research_program_info.get('domain_name') or 'none'}",
    f"Research autonomy mode: {research_program_info.get('autonomy_mode') or 'unknown'}",
    f"Research allowed areas: {', '.join(research_program_info.get('allowed_project_areas') or []) or 'unbounded'}",
    f"Research baseline required: {research_program_info.get('baseline_required')}",
    f"Current conclusion update: {current_conclusion_update_status}",
    f"Current conclusion topic: {current_conclusion_topic_id or 'none'}",
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
    "research_program_id": research_program_info.get("program_id"),
    "research_domain": research_program_info.get("domain_name"),
    "research_autonomy_mode": research_program_info.get("autonomy_mode"),
    "research_allowed_project_areas": research_program_info.get("allowed_project_areas"),
    "research_baseline_required": research_program_info.get("baseline_required"),
    "current_conclusion_update_status": current_conclusion_update_status,
    "current_conclusion_topic_id": current_conclusion_topic_id or None,
    "current_conclusion_output_path": current_conclusion_output_path or None,
    "current_conclusion_proposal_path": current_conclusion_proposal_path or None,
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
    f"- Research program: {research_program_info.get('program_id') or 'none'}",
    f"- Research domain: {research_program_info.get('domain_name') or 'none'}",
    f"- Current conclusion update: {current_conclusion_update_status}",
    f"- Current conclusion topic: {current_conclusion_topic_id or 'none'}",
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
review_bundle_present = bool(proposal or current_conclusion_proposal_path)
review_state = "pending_send" if review_bundle_present else "none"
if requires_review and not review_bundle_present:
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
    "input_paths": [
        "research/RESEARCH_PROGRAM.json",
        *([ "project_index/current_conclusions.json" ] if current_conclusion_update else []),
        *([ "project_index/document_index.jsonl" ] if current_conclusion_update else []),
        *([ "project_index/experiment_index.jsonl" ] if current_conclusion_update else []),
    ],
    "output_paths": [
        "agent/reports/latest.md",
        "agent/STATE.json",
        "agent/CURRENT_STATE.md",
        "agent/RUN_STATE.json",
        "agent/PROGRESS_STATE.json",
        "agent/NEXT_ACTION.md",
        "agent/ROUTE_CANONICAL.json",
        *( [current_conclusion_output_path] if current_conclusion_output_path else [] ),
        *( [current_conclusion_proposal_path] if current_conclusion_proposal_path else [] ),
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
    "research_program_id": research_program_info.get("program_id"),
    "research_domain": research_program_info.get("domain_name"),
    "research_autonomy_mode": research_program_info.get("autonomy_mode"),
    "research_allowed_project_areas": research_program_info.get("allowed_project_areas"),
    "research_baseline_required": research_program_info.get("baseline_required"),
    "current_conclusion_update_status": current_conclusion_update_status,
    "current_conclusion_topic_id": current_conclusion_topic_id or None,
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
`;

module.exports = {
  renderReportFinalize
};
