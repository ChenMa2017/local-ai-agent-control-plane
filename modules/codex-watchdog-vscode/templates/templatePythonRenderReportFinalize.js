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

VALID_DOC_TYPES = {
    "official_conclusion",
    "formal_report",
    "requirement",
    "execution_plan",
    "experiment_card",
    "primary_result",
    "smoke_result",
    "bounded_experiment",
    "daily_log",
    "meeting_minutes",
    "auxiliary_diagnostic",
    "debug_note",
    "in_progress",
    "legacy_note",
    "unknown",
}
VALID_RECORD_STATUSES = {"active", "draft", "superseded", "deprecated", "archived", "invalidated"}
VALID_EVIDENCE_SCOPES = {"primary_only", "mixed", "auxiliary_only", "none"}
VALID_CONCLUSION_STATUSES = {"confirmed", "tentative", "auxiliary_only", "invalidated"}
VALID_SEARCH_DECISIONS = {
    "safe_to_answer",
    "insufficient_primary_evidence",
    "only_auxiliary_found",
    "stale_conclusion",
    "conflicting_evidence",
    "no_index_hit",
    "index_error",
}

def safe_optional_string(value):
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None

def ordered_unique_strings(items):
    result = []
    for item in items:
        value = str(item or "").strip()
        if value and value not in result:
            result.append(value)
    return result

def require_nonempty_string(value, label, errors, allow_null=False):
    if allow_null and value in (None, ""):
        return
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{label} must be a nonempty string")

def require_string_array(value, label, errors):
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")
        return
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{label}[{index}] must be a nonempty string")

def validate_primary_metrics(value, label, errors):
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")
        return []
    normalized = []
    for index, metric in enumerate(value):
        metric_label = f"{label}[{index}]"
        if not isinstance(metric, dict):
            errors.append(f"{metric_label} must be an object")
            continue
        require_nonempty_string(metric.get("name"), f"{metric_label}.name", errors)
        metric_value = metric.get("value")
        if metric_value not in (None, "") and not isinstance(metric_value, (int, float)):
            errors.append(f"{metric_label}.value must be a number or null")
        if not isinstance(metric.get("higher_is_better"), bool):
            errors.append(f"{metric_label}.higher_is_better must be a boolean")
        notes = metric.get("notes")
        if notes not in (None, "") and not isinstance(notes, str):
            errors.append(f"{metric_label}.notes must be a string or null")
        normalized.append({
            "name": str(metric.get("name") or "").strip(),
            "value": metric_value if metric_value not in ("",) else None,
            "higher_is_better": metric.get("higher_is_better") is True,
            "notes": safe_optional_string(notes),
        })
    return normalized

def is_safe_relative_project_path(value):
    if not isinstance(value, str) or not value.strip():
        return False
    candidate = Path(value)
    return not candidate.is_absolute() and ".." not in candidate.parts

def is_safe_project_area(value):
    if not isinstance(value, str) or not value.strip():
        return False
    return all(char.isalnum() or char in {"_", "-", "/", "."} for char in value)

def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def write_jsonl_records(path, records):
    lines = [json.dumps(record, sort_keys=True) for record in records]
    atomic_write_text(path, ("\\n".join(lines) + "\\n") if lines else "")

def route_or_task_box_value(key):
    for source in (task_box, route_canonical):
        if not isinstance(source, dict):
            continue
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

def route_or_task_box_conclusion_gate_required():
    for source in (task_box, route_canonical):
        if not isinstance(source, dict):
            continue
        policy = source.get("gate_policy")
        if isinstance(policy, dict) and policy.get("conclusion_retrieval_gate") is True:
            return True
    return False

def run_watchdog_doc_search(query):
    script_path = Path("agent/bin/watchdog_doc_search.py")
    if not script_path.exists():
        raise SystemExit("current_conclusion_update requires agent/bin/watchdog_doc_search.py, but the script is missing")
    result = subprocess.run(
        ["python3", str(script_path), "--project-root", ".", "--query", query, "--json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise SystemExit(
            "current_conclusion_update could not verify local evidence retrieval because watchdog_doc_search.py failed"
            + (f": {stderr}" if stderr else "")
        )
    try:
        payload = json.loads(result.stdout or "{}")
    except Exception as exc:
        raise SystemExit(f"current_conclusion_update could not parse watchdog_doc_search.py JSON output: {exc}")
    if not isinstance(payload, dict):
        raise SystemExit("current_conclusion_update verification expected watchdog_doc_search.py to return a JSON object")
    return payload

def load_golden_queries_registry():
    golden_queries = load_json_default("project_index/golden_queries.json", {})
    if not isinstance(golden_queries, dict):
        raise SystemExit("current_conclusion_update requires project_index/golden_queries.json to be a JSON object")
    if golden_queries.get("schema_version") != "golden_queries.v0.1":
        raise SystemExit("current_conclusion_update requires project_index/golden_queries.json schema_version=golden_queries.v0.1")
    queries = golden_queries.get("queries")
    if not isinstance(queries, list):
        raise SystemExit("current_conclusion_update requires project_index/golden_queries.json queries to be an array")
    registry = {}
    duplicate_queries = []
    for index, item in enumerate(queries):
        label = f"project_index/golden_queries.json queries[{index}]"
        if not isinstance(item, dict):
            raise SystemExit(f"current_conclusion_update requires {label} to be an object")
        query = str(item.get("query") or "").strip()
        if not query:
            raise SystemExit(f"current_conclusion_update requires {label}.query to be a nonempty string")
        expected_decision = safe_optional_string(item.get("expected_decision"))
        if expected_decision and expected_decision not in VALID_SEARCH_DECISIONS:
            raise SystemExit(
                f"current_conclusion_update requires {label}.expected_decision to be one of {sorted(VALID_SEARCH_DECISIONS)}"
            )
        if query in registry:
            duplicate_queries.append(query)
            continue
        registry[query] = {
            "query": query,
            "expected_decision": expected_decision,
            "notes": safe_optional_string(item.get("notes")),
        }
    if duplicate_queries:
        raise SystemExit(
            "current_conclusion_update requires unique project_index/golden_queries.json query values; duplicates: "
            + ", ".join(sorted(set(duplicate_queries)))
        )
    return registry

def require_safe_to_answer_golden_query(query):
    normalized_query = str(query or "").strip()
    if not normalized_query:
        raise SystemExit("current_conclusion_update requires a nonempty retrieval query before checking golden_queries.json")
    entry = load_golden_queries_registry().get(normalized_query)
    if not entry:
        raise SystemExit(
            "current_conclusion_update requires project_index/golden_queries.json to contain the exact retrieval query with expected_decision=safe_to_answer: "
            + repr(normalized_query)
        )
    expected_decision = str(entry.get("expected_decision") or "").strip()
    if expected_decision != "safe_to_answer":
        raise SystemExit(
            "current_conclusion_update requires project_index/golden_queries.json expected_decision=safe_to_answer for query "
            + repr(normalized_query)
            + f"; found {expected_decision!r}"
        )
    return entry

def upsert_records_by_key(existing_records, updates, key):
    remaining = {}
    ordered_keys = []
    for record in existing_records if isinstance(existing_records, list) else []:
        if not isinstance(record, dict):
            continue
        record_key = str(record.get(key) or "").strip()
        if not record_key:
            continue
        remaining[record_key] = record
        if record_key not in ordered_keys:
            ordered_keys.append(record_key)
    for update in updates if isinstance(updates, list) else []:
        if not isinstance(update, dict):
            continue
        record_key = str(update.get(key) or "").strip()
        if not record_key:
            continue
        remaining[record_key] = update
        if record_key not in ordered_keys:
            ordered_keys.append(record_key)
    return [remaining[record_key] for record_key in ordered_keys if record_key in remaining]

def research_program_policy(program):
    domain = program.get("domain") if isinstance(program.get("domain"), dict) else {}
    baseline_policy = program.get("baseline_policy") if isinstance(program.get("baseline_policy"), dict) else {}
    evidence_policy = program.get("evidence_policy") if isinstance(program.get("evidence_policy"), dict) else {}
    conclusion_policy = program.get("conclusion_policy") if isinstance(program.get("conclusion_policy"), dict) else {}
    return {
        "allowed_project_areas": set(normalized_string_list(domain.get("allowed_project_areas"))),
        "forbidden_project_areas": set(normalized_string_list(domain.get("forbidden_project_areas"))),
        "baseline_required": baseline_policy.get("required") is True,
        "allowed_conclusion_statuses": set(normalized_string_list(conclusion_policy.get("allowed_conclusion_statuses"))),
        "publish_only_after_review": conclusion_policy.get("publish_only_after_review") is True,
        "require_staleness_tracking": conclusion_policy.get("require_staleness_tracking") is True,
        "require_invalidation_path": conclusion_policy.get("require_invalidation_path") is True,
        "require_primary_evidence_for_confirmed_claims": evidence_policy.get("require_primary_evidence_for_confirmed_claims") is True,
        "require_index_entry_for_cited_files": evidence_policy.get("require_index_entry_for_cited_files") is True,
    }

def normalize_document_index_update(update, existing_record, updated_utc):
    existing = existing_record if isinstance(existing_record, dict) else {}
    checksum_scope = safe_optional_string(update.get("checksum_scope")) or safe_optional_string(existing.get("checksum_scope")) or "raw_file_bytes"
    return {
        "doc_id": str(update.get("doc_id") or "").strip(),
        "path": str(update.get("path") or "").strip(),
        "title": str(update.get("title") or "").strip(),
        "doc_type": str(update.get("doc_type") or "").strip(),
        "status": str(update.get("status") or "").strip(),
        "evidence_scope": str(update.get("evidence_scope") or "").strip(),
        "evidence_scope_note": str(update.get("evidence_scope_note") or "").strip(),
        "project_area": str(update.get("project_area") or "").strip(),
        "summary": str(update.get("summary") or "").strip(),
        "tags": normalized_string_list(update.get("tags")),
        "supersedes": normalized_string_list(update.get("supersedes")),
        "superseded_by": normalized_string_list(update.get("superseded_by")),
        "created_at": safe_optional_string(update.get("created_at")) or safe_optional_string(existing.get("created_at")) or updated_utc,
        "updated_at": safe_optional_string(update.get("updated_at")) or updated_utc,
        "checksum": safe_optional_string(update.get("checksum")) or safe_optional_string(existing.get("checksum")),
        "checksum_scope": checksum_scope,
        "indexed_at": safe_optional_string(update.get("indexed_at")) or updated_utc,
    }

def validate_document_index_update(update, existing_record, root, policy, updated_utc):
    errors = []
    if not isinstance(update, dict):
        return None, ["document_index_updates item must be an object"]
    normalized = normalize_document_index_update(update, existing_record, updated_utc)
    for field in (
        "doc_id",
        "path",
        "title",
        "doc_type",
        "status",
        "evidence_scope",
        "evidence_scope_note",
        "project_area",
        "summary",
    ):
        require_nonempty_string(normalized.get(field), f"document_index_updates.{normalized.get('doc_id') or '<unknown>'}.{field}", errors)
    require_string_array(update.get("tags"), f"document_index_updates.{normalized.get('doc_id') or '<unknown>'}.tags", errors)
    require_string_array(update.get("supersedes"), f"document_index_updates.{normalized.get('doc_id') or '<unknown>'}.supersedes", errors)
    require_string_array(update.get("superseded_by"), f"document_index_updates.{normalized.get('doc_id') or '<unknown>'}.superseded_by", errors)
    if normalized.get("doc_type") and normalized["doc_type"] not in VALID_DOC_TYPES:
        errors.append(f"document_index_updates.{normalized['doc_id']}.doc_type is invalid: {normalized['doc_type']!r}")
    if normalized.get("status") and normalized["status"] not in VALID_RECORD_STATUSES:
        errors.append(f"document_index_updates.{normalized['doc_id']}.status is invalid: {normalized['status']!r}")
    if normalized.get("evidence_scope") and normalized["evidence_scope"] not in VALID_EVIDENCE_SCOPES:
        errors.append(f"document_index_updates.{normalized['doc_id']}.evidence_scope is invalid: {normalized['evidence_scope']!r}")
    if normalized.get("checksum_scope") != "raw_file_bytes":
        errors.append(f"document_index_updates.{normalized['doc_id']}.checksum_scope must be raw_file_bytes")
    project_area = normalized.get("project_area")
    if project_area and not is_safe_project_area(project_area):
        errors.append(f"document_index_updates.{normalized['doc_id']}.project_area must be a safe nonempty label")
    elif project_area and policy.get("allowed_project_areas") and project_area not in policy.get("allowed_project_areas"):
        errors.append(f"document_index_updates.{normalized['doc_id']}.project_area is outside RESEARCH_PROGRAM allowed_project_areas: {project_area!r}")
    if project_area and project_area in policy.get("forbidden_project_areas", set()):
        errors.append(f"document_index_updates.{normalized['doc_id']}.project_area is forbidden by RESEARCH_PROGRAM: {project_area!r}")
    target = None
    rel_path = normalized.get("path")
    if rel_path and not is_safe_relative_project_path(rel_path):
        errors.append(f"document_index_updates.{normalized['doc_id']}.path must be a safe relative path")
    elif rel_path:
        target = root / rel_path
        if not target.exists():
            errors.append(f"document_index_updates.{normalized['doc_id']}.path does not exist: {rel_path}")
    for field in ("created_at", "updated_at", "indexed_at"):
        try:
            parse_timestamp_or_none(normalized.get(field))
        except Exception:
            errors.append(f"document_index_updates.{normalized['doc_id']}.{field} must be ISO-8601 or null")
    if target and target.exists():
        computed_checksum = sha256_file(target)
        if normalized.get("checksum") in (None, ""):
            normalized["checksum"] = computed_checksum
        elif normalized.get("checksum") != computed_checksum:
            errors.append(f"document_index_updates.{normalized['doc_id']}.checksum does not match file bytes for {rel_path}")
    return normalized, errors

def normalize_experiment_index_update(update):
    return {
        "experiment_id": str(update.get("experiment_id") or "").strip(),
        "experiment_type": str(update.get("experiment_type") or "").strip(),
        "status": str(update.get("status") or "").strip(),
        "evidence_scope": str(update.get("evidence_scope") or "").strip(),
        "name": str(update.get("name") or "").strip(),
        "purpose": str(update.get("purpose") or "").strip(),
        "model": safe_optional_string(update.get("model")),
        "baseline_model": safe_optional_string(update.get("baseline_model")),
        "train_data": safe_optional_string(update.get("train_data")),
        "test_data": safe_optional_string(update.get("test_data")),
        "eval_protocol": safe_optional_string(update.get("eval_protocol")),
        "with_definition": safe_optional_string(update.get("with_definition")),
        "without_definition": safe_optional_string(update.get("without_definition")),
        "primary_metrics": update.get("primary_metrics"),
        "primary_metric_name": safe_optional_string(update.get("primary_metric_name")),
        "best_epoch": update.get("best_epoch"),
        "primary_eval_path": safe_optional_string(update.get("primary_eval_path")),
        "config_path": safe_optional_string(update.get("config_path")),
        "code_commit": safe_optional_string(update.get("code_commit")),
        "run_id": safe_optional_string(update.get("run_id")),
        "official_conclusion_doc": safe_optional_string(update.get("official_conclusion_doc")),
    }

def validate_experiment_index_update(update, docs_by_id, root, policy):
    errors = []
    if not isinstance(update, dict):
        return None, ["experiment_index_updates item must be an object"]
    normalized = normalize_experiment_index_update(update)
    for field in ("experiment_id", "experiment_type", "status", "evidence_scope", "name", "purpose"):
        require_nonempty_string(normalized.get(field), f"experiment_index_updates.{normalized.get('experiment_id') or '<unknown>'}.{field}", errors)
    if normalized.get("status") and normalized["status"] not in VALID_RECORD_STATUSES:
        errors.append(f"experiment_index_updates.{normalized['experiment_id']}.status is invalid: {normalized['status']!r}")
    if normalized.get("evidence_scope") and normalized["evidence_scope"] not in VALID_EVIDENCE_SCOPES:
        errors.append(f"experiment_index_updates.{normalized['experiment_id']}.evidence_scope is invalid: {normalized['evidence_scope']!r}")
    if policy.get("baseline_required") and normalized.get("status") == "active" and normalized.get("baseline_model") in (None, ""):
        errors.append(f"experiment_index_updates.{normalized['experiment_id']}.baseline_model must be set because RESEARCH_PROGRAM baseline_policy.required=true")
    normalized["primary_metrics"] = validate_primary_metrics(
        normalized.get("primary_metrics"),
        f"experiment_index_updates.{normalized.get('experiment_id') or '<unknown>'}.primary_metrics",
        errors,
    )
    primary_metric_name = normalized.get("primary_metric_name")
    if primary_metric_name and not any(metric.get("name") == primary_metric_name for metric in normalized["primary_metrics"]):
        errors.append(
            f"experiment_index_updates.{normalized['experiment_id']}.primary_metric_name must match one primary_metrics.name"
        )
    best_epoch = normalized.get("best_epoch")
    if best_epoch not in (None, "") and not isinstance(best_epoch, int):
        errors.append(f"experiment_index_updates.{normalized['experiment_id']}.best_epoch must be an integer or null")
    for field in ("model", "baseline_model", "train_data", "test_data", "eval_protocol", "with_definition", "without_definition", "code_commit", "run_id"):
        value = normalized.get(field)
        if value not in (None, "") and not isinstance(value, str):
            errors.append(f"experiment_index_updates.{normalized['experiment_id']}.{field} must be a string or null")
    for path_field in ("primary_eval_path", "config_path"):
        path_value = normalized.get(path_field)
        if path_value not in (None, ""):
            if not is_safe_relative_project_path(path_value):
                errors.append(f"experiment_index_updates.{normalized['experiment_id']}.{path_field} must be a safe relative path or null")
            elif not (root / path_value).exists():
                errors.append(f"experiment_index_updates.{normalized['experiment_id']}.{path_field} does not exist: {path_value}")
    conclusion_doc = normalized.get("official_conclusion_doc")
    if conclusion_doc not in (None, "") and conclusion_doc not in docs_by_id:
        errors.append(
            f"experiment_index_updates.{normalized['experiment_id']}.official_conclusion_doc references unknown doc_id: {conclusion_doc}"
        )
    return normalized, errors

def validate_current_conclusion_evidence_search(search_payload):
    errors = []
    if not search_payload:
        return errors
    require_nonempty_string(search_payload.get("query"), "current_conclusion_evidence_search.query", errors)
    decision = str(search_payload.get("decision") or "").strip()
    if not decision:
        errors.append("current_conclusion_evidence_search.decision must be a nonempty string")
    elif decision not in VALID_SEARCH_DECISIONS:
        errors.append(f"current_conclusion_evidence_search.decision is invalid: {decision!r}")
    require_string_array(search_payload.get("warnings"), "current_conclusion_evidence_search.warnings", errors)
    require_string_array(search_payload.get("read_plan_paths"), "current_conclusion_evidence_search.read_plan_paths", errors)
    return errors

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

def clean_object_list(value):
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]

document_index_updates = clean_object_list(data.get("document_index_updates"))
experiment_index_updates = clean_object_list(data.get("experiment_index_updates"))
current_conclusion_evidence_search = clean_object(data.get("current_conclusion_evidence_search"))
current_conclusion_update = clean_object(data.get("current_conclusion_update"))
document_index_update_ids = []
experiment_index_update_ids = []
document_index_update_count = 0
experiment_index_update_count = 0
document_index_output_path = ""
experiment_index_output_path = ""
current_conclusion_evidence_query = ""
current_conclusion_evidence_status = "none"
current_conclusion_evidence_decision = ""
current_conclusion_evidence_output_path = ""
current_conclusion_evidence_warnings = []
current_conclusion_evidence_read_plan_paths = []
current_conclusion_update_status = "none"
current_conclusion_output_path = ""
current_conclusion_proposal_path = ""
current_conclusion_golden_query_status = "none"
current_conclusion_golden_query_expected_decision = ""
current_conclusion_topic_id = str(current_conclusion_update.get("topic_id") or "").strip() if current_conclusion_update else ""
contract_current_conclusion_topic_id = route_or_task_box_value("current_conclusion_topic_id")
contract_current_conclusion_query = route_or_task_box_value("current_conclusion_query")
contract_current_conclusion_gate_required = route_or_task_box_conclusion_gate_required()
secondary_skill_failures = clean_object_list(route.get("secondary_skill_failures"))
existing_document_records = load_jsonl_records("project_index/document_index.jsonl")
existing_experiment_records = load_jsonl_records("project_index/experiment_index.jsonl")
docs_by_id = records_by_id(existing_document_records, "doc_id")
experiments_by_id = records_by_id(existing_experiment_records, "experiment_id")
program_policy = research_program_policy(research_program if isinstance(research_program, dict) else {})
staged_document_updates = []
seen_document_ids = set()
for index, update in enumerate(document_index_updates):
    update_doc_id = str(update.get("doc_id") or "").strip()
    if update_doc_id and update_doc_id in seen_document_ids:
        raise SystemExit(f"document_index_updates contains duplicate doc_id in one wakeup: {update_doc_id}")
    normalized_doc, doc_errors = validate_document_index_update(
        update,
        docs_by_id.get(update_doc_id),
        Path("."),
        program_policy,
        updated,
    )
    if doc_errors:
        raise SystemExit("document_index_updates violates RESEARCH_PROGRAM/project_index policy: " + "; ".join(doc_errors))
    seen_document_ids.add(update_doc_id)
    staged_document_updates.append(normalized_doc)
staged_docs_by_id = dict(docs_by_id)
for record in staged_document_updates:
    staged_docs_by_id[record["doc_id"]] = record
staged_experiment_updates = []
seen_experiment_ids = set()
for update in experiment_index_updates:
    update_experiment_id = str(update.get("experiment_id") or "").strip()
    if update_experiment_id and update_experiment_id in seen_experiment_ids:
        raise SystemExit(f"experiment_index_updates contains duplicate experiment_id in one wakeup: {update_experiment_id}")
    normalized_experiment, experiment_errors = validate_experiment_index_update(
        update,
        staged_docs_by_id,
        Path("."),
        program_policy,
    )
    if experiment_errors:
        raise SystemExit("experiment_index_updates violates RESEARCH_PROGRAM/project_index policy: " + "; ".join(experiment_errors))
    seen_experiment_ids.add(update_experiment_id)
    staged_experiment_updates.append(normalized_experiment)
staged_experiments_by_id = dict(experiments_by_id)
for record in staged_experiment_updates:
    staged_experiments_by_id[record["experiment_id"]] = record
if staged_document_updates:
    updated_document_records = upsert_records_by_key(existing_document_records, staged_document_updates, "doc_id")
    document_index_output_path = "project_index/document_index.jsonl"
    write_jsonl_records(document_index_output_path, updated_document_records)
    document_index_update_ids = [record["doc_id"] for record in staged_document_updates]
    document_index_update_count = len(document_index_update_ids)
if staged_experiment_updates:
    updated_experiment_records = upsert_records_by_key(existing_experiment_records, staged_experiment_updates, "experiment_id")
    experiment_index_output_path = "project_index/experiment_index.jsonl"
    write_jsonl_records(experiment_index_output_path, updated_experiment_records)
    experiment_index_update_ids = [record["experiment_id"] for record in staged_experiment_updates]
    experiment_index_update_count = len(experiment_index_update_ids)
if current_conclusion_update:
    if contract_current_conclusion_gate_required:
        if not contract_current_conclusion_topic_id:
            raise SystemExit("current_conclusion_update requires TASK_BOX/ROUTE_CANONICAL current_conclusion_topic_id because conclusion_retrieval_gate=true")
        if not contract_current_conclusion_query:
            raise SystemExit("current_conclusion_update requires TASK_BOX/ROUTE_CANONICAL current_conclusion_query because conclusion_retrieval_gate=true")
    if contract_current_conclusion_topic_id and current_conclusion_topic_id != contract_current_conclusion_topic_id:
        raise SystemExit(
            "current_conclusion_update.topic_id does not match TASK_BOX/ROUTE_CANONICAL current_conclusion_topic_id: "
            + f"{current_conclusion_topic_id!r} != {contract_current_conclusion_topic_id!r}"
        )
    if not current_conclusion_evidence_search:
        raise SystemExit("current_conclusion_update requires current_conclusion_evidence_search from watchdog_doc_search.py")
    search_payload_errors = validate_current_conclusion_evidence_search(current_conclusion_evidence_search)
    if search_payload_errors:
        raise SystemExit(
            "current_conclusion_evidence_search is invalid: " + "; ".join(search_payload_errors)
        )
    current_conclusion_evidence_query = str(current_conclusion_evidence_search.get("query") or "").strip()
    verified_conclusion_search = run_watchdog_doc_search(current_conclusion_evidence_query)
    current_conclusion_evidence_decision = str(verified_conclusion_search.get("decision") or "").strip()
    current_conclusion_evidence_warnings = ordered_unique_strings(verified_conclusion_search.get("warnings") or [])
    current_conclusion_evidence_read_plan_paths = ordered_unique_strings(
        item.get("path")
        for item in verified_conclusion_search.get("read_plan", [])
        if isinstance(item, dict)
    )
    reported_decision = str(current_conclusion_evidence_search.get("decision") or "").strip()
    if reported_decision != current_conclusion_evidence_decision:
        raise SystemExit(
            "current_conclusion_evidence_search.decision does not match verified watchdog_doc_search.py output: "
            + f"reported {reported_decision!r}, verified {current_conclusion_evidence_decision!r}"
        )
    if contract_current_conclusion_query and current_conclusion_evidence_query != contract_current_conclusion_query:
        raise SystemExit(
            "current_conclusion_evidence_search.query does not match TASK_BOX/ROUTE_CANONICAL current_conclusion_query: "
            + f"{current_conclusion_evidence_query!r} != {contract_current_conclusion_query!r}"
        )
    reported_warnings = ordered_unique_strings(current_conclusion_evidence_search.get("warnings") or [])
    unexpected_reported_warnings = [
        warning for warning in reported_warnings if warning not in current_conclusion_evidence_warnings
    ]
    if unexpected_reported_warnings:
        raise SystemExit(
            "current_conclusion_evidence_search.warnings include values not returned by watchdog_doc_search.py: "
            + ", ".join(unexpected_reported_warnings)
        )
    reported_read_plan_paths = ordered_unique_strings(current_conclusion_evidence_search.get("read_plan_paths") or [])
    unexpected_reported_paths = [
        path for path in reported_read_plan_paths if path not in current_conclusion_evidence_read_plan_paths
    ]
    if unexpected_reported_paths:
        raise SystemExit(
            "current_conclusion_evidence_search.read_plan_paths include values not returned by watchdog_doc_search.py: "
            + ", ".join(unexpected_reported_paths)
        )
    current_conclusion_evidence_output_path = "agent/status/CURRENT_CONCLUSION_EVIDENCE_SEARCH.json"
    atomic_write_json(current_conclusion_evidence_output_path, {
        "schema_version": 1,
        "generated_at": updated,
        "query": current_conclusion_evidence_query,
        "reported_receipt": current_conclusion_evidence_search,
        "verified_receipt": verified_conclusion_search,
        "supporting_docs": current_conclusion_update.get("supporting_docs", []),
        "supporting_experiments": current_conclusion_update.get("supporting_experiments", []),
    })
    current_conclusion_evidence_status = "verified"
    if current_conclusion_evidence_decision != "safe_to_answer":
        warning_text = "; ".join(current_conclusion_evidence_warnings) or "watchdog_doc_search.py did not approve a formal answer"
        raise SystemExit(
            "current_conclusion_update requires a safe_to_answer retrieval decision from watchdog_doc_search.py; "
            + f"got {current_conclusion_evidence_decision}: {warning_text}"
        )
    matched_golden_query = require_safe_to_answer_golden_query(current_conclusion_evidence_query)
    current_conclusion_golden_query_status = "matched_safe_to_answer"
    current_conclusion_golden_query_expected_decision = str(matched_golden_query.get("expected_decision") or "").strip()
    conclusion_errors = validate_current_conclusion_update(
        current_conclusion_update,
        staged_docs_by_id,
        staged_experiments_by_id,
        program_policy,
    )
    if conclusion_errors:
        raise SystemExit("current_conclusion_update violates RESEARCH_PROGRAM/current_conclusions policy: " + "; ".join(conclusion_errors))
    if program_policy.get("publish_only_after_review") and not bool(data.get("requires_human_review")):
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
            "publish_only_after_review": program_policy.get("publish_only_after_review"),
            "current_conclusion_update": current_conclusion_update,
            "current_conclusion_evidence_search": {
                "query": current_conclusion_evidence_query,
                "decision": current_conclusion_evidence_decision,
                "warnings": current_conclusion_evidence_warnings,
                "read_plan_paths": current_conclusion_evidence_read_plan_paths,
                "receipt_path": current_conclusion_evidence_output_path or None,
            },
            "document_index_update_ids": document_index_update_ids,
            "experiment_index_update_ids": experiment_index_update_ids,
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
elif current_conclusion_evidence_search:
    raise SystemExit("current_conclusion_evidence_search must be null unless current_conclusion_update is present")

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
successor_provenance = route_canonical.get("successor_provenance") if isinstance(route_canonical, dict) else None
if not isinstance(successor_provenance, dict):
    successor_provenance = task_box.get("successor_provenance") if isinstance(task_box, dict) else None
successor_task_provenance = successor_provenance.get("successor_task_draft") if isinstance(successor_provenance, dict) else {}
if not isinstance(successor_task_provenance, dict):
    successor_task_provenance = {}
successor_task_source_text = str(successor_task_provenance.get("source") or "none")
successor_task_origin_text = str(successor_task_provenance.get("repair_origin") or "none")
successor_task_parent_epoch_text = str(successor_task_provenance.get("parent_route_epoch") or "none")

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
    f"Successor task source: {successor_task_source_text}",
    f"Successor task origin: {successor_task_origin_text}",
    f"Successor task parent route epoch: {successor_task_parent_epoch_text}",
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
    f"Document index updates: {document_index_update_count}",
    f"Experiment index updates: {experiment_index_update_count}",
    f"Current conclusion contract topic: {contract_current_conclusion_topic_id or 'none'}",
    f"Current conclusion contract query: {contract_current_conclusion_query or 'none'}",
    f"Current conclusion golden query: {current_conclusion_golden_query_status}",
    f"Current conclusion golden expected decision: {current_conclusion_golden_query_expected_decision or 'none'}",
    f"Current conclusion evidence search: {current_conclusion_evidence_status}",
    f"Current conclusion evidence decision: {current_conclusion_evidence_decision or 'none'}",
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
    "successor_provenance": successor_provenance if isinstance(successor_provenance, dict) and successor_provenance else None,
    "project_question": task_box.get("project_question"),
    "decision_relevance": task_box.get("decision_relevance"),
    "claim_scope": task_box.get("claim_scope"),
    "diagnosis_target": task_box.get("diagnosis_target"),
    "research_program_id": research_program_info.get("program_id"),
    "research_domain": research_program_info.get("domain_name"),
    "research_autonomy_mode": research_program_info.get("autonomy_mode"),
    "research_allowed_project_areas": research_program_info.get("allowed_project_areas"),
    "research_baseline_required": research_program_info.get("baseline_required"),
    "document_index_update_count": document_index_update_count,
    "document_index_update_ids": document_index_update_ids,
    "document_index_output_path": document_index_output_path or None,
    "experiment_index_update_count": experiment_index_update_count,
    "experiment_index_update_ids": experiment_index_update_ids,
    "experiment_index_output_path": experiment_index_output_path or None,
    "current_conclusion_contract_topic_id": contract_current_conclusion_topic_id or None,
    "current_conclusion_contract_query": contract_current_conclusion_query or None,
    "current_conclusion_gate_required": contract_current_conclusion_gate_required,
    "current_conclusion_golden_query_status": current_conclusion_golden_query_status,
    "current_conclusion_golden_query_expected_decision": current_conclusion_golden_query_expected_decision or None,
    "current_conclusion_evidence_status": current_conclusion_evidence_status,
    "current_conclusion_evidence_query": current_conclusion_evidence_query or None,
    "current_conclusion_evidence_decision": current_conclusion_evidence_decision or None,
    "current_conclusion_evidence_warnings": current_conclusion_evidence_warnings,
    "current_conclusion_evidence_read_plan_paths": current_conclusion_evidence_read_plan_paths,
    "current_conclusion_evidence_output_path": current_conclusion_evidence_output_path or None,
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
    f"- Successor task source: {successor_task_source_text}",
    f"- Successor task origin: {successor_task_origin_text}",
    f"- Successor task parent route epoch: {successor_task_parent_epoch_text}",
    f"- Experiment gate status: {experiment_gate_status or 'not_required'}",
    f"- Experiment gate required: {experiment_gate_required_text}",
    f"- Experiment gate blocking: {experiment_gate_blocking_text}",
    f"- Decision relevance: {task_box.get('decision_relevance') or 'none'}",
    f"- Claim scope: {task_box.get('claim_scope') or 'none'}",
    f"- Research program: {research_program_info.get('program_id') or 'none'}",
    f"- Research domain: {research_program_info.get('domain_name') or 'none'}",
    f"- Document index updates: {document_index_update_count}",
    f"- Experiment index updates: {experiment_index_update_count}",
    f"- Current conclusion contract topic: {contract_current_conclusion_topic_id or 'none'}",
    f"- Current conclusion contract query: {contract_current_conclusion_query or 'none'}",
    f"- Current conclusion golden query: {current_conclusion_golden_query_status}",
    f"- Current conclusion golden expected decision: {current_conclusion_golden_query_expected_decision or 'none'}",
    f"- Current conclusion evidence search: {current_conclusion_evidence_status}",
    f"- Current conclusion evidence decision: {current_conclusion_evidence_decision or 'none'}",
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

current_conclusion_gate_status = "not_required"
if not contract_current_conclusion_gate_required:
    if current_conclusion_update_status == "review_required":
        current_conclusion_gate_status = "review_required"
    elif current_conclusion_update_status == "applied":
        current_conclusion_gate_status = "satisfied"
    elif current_conclusion_update and current_conclusion_evidence_status == "verified":
        current_conclusion_gate_status = "verified_ready"
elif contract_current_conclusion_gate_required:
    if not contract_current_conclusion_topic_id or not contract_current_conclusion_query:
        current_conclusion_gate_status = "contract_incomplete"
    elif current_conclusion_golden_query_status != "matched_safe_to_answer":
        current_conclusion_gate_status = "golden_query_unmet"
    elif current_conclusion_update and current_conclusion_evidence_status != "verified":
        current_conclusion_gate_status = "awaiting_verified_evidence"
    elif current_conclusion_update_status == "review_required":
        current_conclusion_gate_status = "review_required"
    elif current_conclusion_update_status == "applied":
        current_conclusion_gate_status = "satisfied"
    elif current_conclusion_update:
        current_conclusion_gate_status = "verified_ready"
    else:
        current_conclusion_gate_status = "contract_ready"

gate_missing_requirements = []
gate_blocking_reasons = []
gate_unblock_recommendations = []
for item in blocked_items:
    gate_blocking_reasons.append(f"Blocked item: {item}")
if secondary_skill_failures:
    gate_missing_requirements.append("required_secondary_skill_resolution")
    gate_blocking_reasons.append("Required secondary skill resolution is blocking the selected route.")
    gate_unblock_recommendations.append("Repair agent/SECONDARY_SKILLS.json or restore the missing required skill files.")
if experiment_gate_status == "blocked":
    gate_missing_requirements.append("experiment_decision_gate_resolution")
    gate_blocking_reasons.append("Experiment decision gate is explicitly blocked.")
    gate_unblock_recommendations.append(
        str(next_action.get("description") or "").strip()
        or "Resolve the experiment decision gate fields before continuing."
    )
if requires_review:
    gate_missing_requirements.append("human_review_resolution")
    gate_blocking_reasons.append("Human review is required before this route can proceed.")
    gate_unblock_recommendations.append(
        str(next_action.get("description") or "").strip()
        or "Send or resolve the pending review bundle before continuing."
    )
if contract_current_conclusion_gate_required:
    if not contract_current_conclusion_topic_id:
        gate_missing_requirements.append("current_conclusion_topic_id")
        gate_blocking_reasons.append("Current conclusion gate requires current_conclusion_topic_id.")
        gate_unblock_recommendations.append("Add current_conclusion_topic_id to TASK_BOX/ROUTE_CANONICAL for this decision-bearing route.")
    if not contract_current_conclusion_query:
        gate_missing_requirements.append("current_conclusion_query")
        gate_blocking_reasons.append("Current conclusion gate requires current_conclusion_query.")
        gate_unblock_recommendations.append("Add current_conclusion_query to TASK_BOX/ROUTE_CANONICAL for this decision-bearing route.")
    if contract_current_conclusion_query and current_conclusion_golden_query_status != "matched_safe_to_answer":
        gate_missing_requirements.append("golden_query_safe_to_answer_registration")
        gate_blocking_reasons.append("Current conclusion query is not yet backed by a safe_to_answer golden query registration.")
        gate_unblock_recommendations.append("Register the exact current_conclusion_query in project_index/golden_queries.json with expected_decision=safe_to_answer.")
    if current_conclusion_update and current_conclusion_evidence_status != "verified":
        gate_missing_requirements.append("verified_current_conclusion_evidence_search")
        gate_blocking_reasons.append("Current conclusion update does not yet have a verified local evidence search receipt.")
        gate_unblock_recommendations.append("Run watchdog_doc_search.py for the exact current_conclusion_query and carry the verified receipt into current_conclusion_evidence_search.")
    if current_conclusion_update_status == "review_required":
        gate_blocking_reasons.append("Current conclusion update is packaged for review instead of immediate publication.")

gate_missing_requirements = ordered_unique_strings(gate_missing_requirements)
gate_blocking_reasons = ordered_unique_strings(gate_blocking_reasons)
gate_unblock_recommendations = ordered_unique_strings(gate_unblock_recommendations)
if not gate_unblock_recommendations:
    gate_unblock_recommendations = ["None. Current gate conditions do not require an extra unblock step."]

gate_hard_blocked = bool(
    blocked_items
    or secondary_skill_failures
    or experiment_gate_status == "blocked"
    or requires_review
    or current_conclusion_gate_status in {"contract_incomplete", "golden_query_unmet"}
)

atomic_write_json("agent/status/GATE_STATUS.json", {
    "schema_version": 1,
    "updated_utc": updated,
    "status": data.get("overall_status", "uncertain"),
    "report_type": data.get("report_type", "heartbeat"),
    "hard_blocked": gate_hard_blocked,
    "blocker_type": blocker,
    "primary_skill": data.get("primary_skill"),
    "route_id": route_canonical.get("route_id") or task_box.get("route_id"),
    "route_epoch": route_canonical.get("route_epoch") or task_box.get("route_epoch"),
    "task_box_id": task_box.get("task_box_id"),
    "task_id": route.get("task_id"),
    "blocked_items": blocked_items,
    "blocking_reasons": gate_blocking_reasons,
    "missing_requirements": gate_missing_requirements,
    "required_secondary_skills": {
        "blocking": bool(secondary_skill_failures),
        "failures": secondary_skill_failures,
    },
    "experiment_decision_gate": {
        "status": experiment_gate_status,
        "required": experiment_gate_status in {"required_ready", "blocked"},
        "blocking": experiment_gate_status == "blocked",
    },
    "current_conclusion_gate": {
        "required": contract_current_conclusion_gate_required,
        "status": current_conclusion_gate_status,
        "contract_topic_id": contract_current_conclusion_topic_id or None,
        "contract_query": contract_current_conclusion_query or None,
        "golden_query_status": current_conclusion_golden_query_status,
        "golden_query_expected_decision": current_conclusion_golden_query_expected_decision or None,
        "evidence_status": current_conclusion_evidence_status,
        "evidence_query": current_conclusion_evidence_query or None,
        "evidence_decision": current_conclusion_evidence_decision or None,
        "evidence_warnings": current_conclusion_evidence_warnings,
        "evidence_read_plan_paths": current_conclusion_evidence_read_plan_paths,
        "update_status": current_conclusion_update_status,
        "topic_id": current_conclusion_topic_id or None,
    },
    "review": {
        "required": requires_review,
        "state": review_state,
        "scope": review_scope,
        "resolver": review_resolver,
        "reason": human_reason or None,
    },
    "next_safe_action": next_action,
    "unblock_recommendations": gate_unblock_recommendations,
})

write_lines("agent/status/GATE_STATUS.md", [
    "# Gate Status",
    "",
    f"Updated: {updated}",
    f"Status: {data.get('overall_status', 'uncertain')}",
    f"Report type: {data.get('report_type', 'heartbeat')}",
    f"Primary skill: {data.get('primary_skill', '') or 'none'}",
    f"Hard blocked: {str(gate_hard_blocked).lower()}",
    f"Blocker type: {blocker}",
    f"Route ID: {route_canonical.get('route_id') or task_box.get('route_id') or 'unknown'}",
    f"Route epoch: {route_canonical.get('route_epoch') or task_box.get('route_epoch') or 'unknown'}",
    "",
    "## Gate Summary",
    "",
    f"- Experiment gate status: {experiment_gate_status or 'not_required'}",
    f"- Current conclusion gate required: {str(contract_current_conclusion_gate_required).lower()}",
    f"- Current conclusion gate status: {current_conclusion_gate_status}",
    f"- Current conclusion contract topic: {contract_current_conclusion_topic_id or 'none'}",
    f"- Current conclusion contract query: {contract_current_conclusion_query or 'none'}",
    f"- Current conclusion golden query: {current_conclusion_golden_query_status}",
    f"- Current conclusion golden expected decision: {current_conclusion_golden_query_expected_decision or 'none'}",
    f"- Current conclusion evidence search: {current_conclusion_evidence_status}",
    f"- Current conclusion evidence decision: {current_conclusion_evidence_decision or 'none'}",
    f"- Current conclusion update: {current_conclusion_update_status}",
    f"- Required secondary skill failures: {len(secondary_skill_failures)}",
    f"- Human review required: {str(requires_review).lower()}",
    "",
    "## Blocking Reasons",
    "",
    *(f"- {item}" for item in gate_blocking_reasons),
    *(["- None."] if not gate_blocking_reasons else []),
    "",
    "## Missing Requirements",
    "",
    *(f"- {item}" for item in gate_missing_requirements),
    *(["- None."] if not gate_missing_requirements else []),
    "",
    "## Unblock Recommendations",
    "",
    *(f"- {item}" for item in gate_unblock_recommendations),
    "",
    "## Next Safe Action",
    "",
    f"- Kind: {next_action.get('kind', 'none')}",
    f"- Description: {next_action.get('description', '') or 'None.'}",
    f"- Automatic: {next_action.get('can_execute_automatically', False)}",
    f"- Reason: {next_action.get('reason', '') or 'No reason provided.'}",
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
    "input_paths": ordered_unique_strings([
        "research/RESEARCH_PROGRAM.json",
        *([ "agent/bin/watchdog_doc_search.py" ] if current_conclusion_update else []),
        *([ "project_index/current_conclusions.json" ] if current_conclusion_update else []),
        *([ "project_index/golden_queries.json" ] if current_conclusion_update else []),
        *([ "project_index/document_index.jsonl" ] if document_index_updates or current_conclusion_update else []),
        *([ "project_index/experiment_index.jsonl" ] if experiment_index_updates or current_conclusion_update else []),
        *[record.get("path") for record in staged_document_updates],
        *[record.get("primary_eval_path") for record in staged_experiment_updates if record.get("primary_eval_path")],
        *[record.get("config_path") for record in staged_experiment_updates if record.get("config_path")],
    ]),
    "output_paths": ordered_unique_strings([
        "agent/reports/latest.md",
        "agent/STATE.json",
        "agent/CURRENT_STATE.md",
        "agent/RUN_STATE.json",
        "agent/PROGRESS_STATE.json",
        "agent/NEXT_ACTION.md",
        "agent/status/GATE_STATUS.json",
        "agent/status/GATE_STATUS.md",
        "agent/ROUTE_CANONICAL.json",
        *( [current_conclusion_evidence_output_path] if current_conclusion_evidence_output_path else [] ),
        *( [document_index_output_path] if document_index_output_path else [] ),
        *( [experiment_index_output_path] if experiment_index_output_path else [] ),
        *( [current_conclusion_output_path] if current_conclusion_output_path else [] ),
        *( [current_conclusion_proposal_path] if current_conclusion_proposal_path else [] ),
        *( [next_task_draft_path] if next_task_draft_path else [] ),
        *( [task_profile_path] if task_profile_path else [] ),
        *( [queue_request_draft_path] if queue_request_draft_path else [] ),
    ]),
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
    "document_index_update_count": document_index_update_count,
    "document_index_update_ids": document_index_update_ids,
    "experiment_index_update_count": experiment_index_update_count,
    "experiment_index_update_ids": experiment_index_update_ids,
    "current_conclusion_contract_topic_id": contract_current_conclusion_topic_id or None,
    "current_conclusion_contract_query": contract_current_conclusion_query or None,
    "current_conclusion_gate_required": contract_current_conclusion_gate_required,
    "current_conclusion_golden_query_status": current_conclusion_golden_query_status,
    "current_conclusion_golden_query_expected_decision": current_conclusion_golden_query_expected_decision or None,
    "current_conclusion_evidence_status": current_conclusion_evidence_status,
    "current_conclusion_evidence_query": current_conclusion_evidence_query or None,
    "current_conclusion_evidence_decision": current_conclusion_evidence_decision or None,
    "current_conclusion_evidence_warnings": current_conclusion_evidence_warnings,
    "current_conclusion_evidence_read_plan_paths": current_conclusion_evidence_read_plan_paths,
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
