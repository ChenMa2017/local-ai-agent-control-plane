from __future__ import annotations

import re
from typing import Any, Callable


def load_intake_questions_from_sources(
    questions_data: dict[str, Any] | None,
    questions_markdown: str,
) -> list[str]:
    if isinstance(questions_data, dict):
        items = questions_data.get("items")
        if isinstance(items, list):
            return [str(item) for item in items if str(item or "").strip()]
    questions: list[str] = []
    for raw_line in str(questions_markdown or "").splitlines():
        match = re.match(r"^\s*\d+\.\s+(.*)$", raw_line)
        if match:
            text = match.group(1).strip()
            if text:
                questions.append(text)
    return questions


def count_jsonl_records(text: str) -> int:
    return sum(1 for raw_line in str(text or "").splitlines() if raw_line.strip())


def filter_source_task_artifact(
    artifact: dict[str, Any],
    source_task_id: str,
    source_key: str,
) -> dict[str, Any]:
    if not isinstance(artifact, dict):
        return {}
    if str(artifact.get(source_key) or "") not in {"", source_task_id}:
        return {}
    return artifact


def prepared_run_summary(bundle: dict[str, Any]) -> dict[str, Any]:
    contract = bundle.get("contract") if isinstance(bundle.get("contract"), dict) else {}
    taskbox = bundle.get("taskbox") if isinstance(bundle.get("taskbox"), dict) else {}
    evidence = bundle.get("evidence_retrieval") if isinstance(bundle.get("evidence_retrieval"), dict) else {}
    return {
        "used": True,
        "intake_id": bundle.get("intake_id"),
        "objective": str(contract.get("objective") or ""),
        "workspace_mode": str(taskbox.get("workspace_mode") or ""),
        "allowed_runner": str(taskbox.get("allowed_runner") or ""),
        "evidence_retrieval_decision": evidence.get("decision"),
        "read_plan": list(evidence.get("read_plan") or []),
    }


def prepared_run_prompt(
    bundle: dict[str, Any],
    run_note: str,
    safe_text: Callable[[str, int], str],
    max_task_chars: int,
) -> str:
    contract = bundle.get("contract") if isinstance(bundle.get("contract"), dict) else {}
    taskbox = bundle.get("taskbox") if isinstance(bundle.get("taskbox"), dict) else {}
    evidence = bundle.get("evidence_retrieval") if isinstance(bundle.get("evidence_retrieval"), dict) else {}
    prompt = str(contract.get("prompt") or "").strip()
    answers = str(contract.get("answers_summary") or "").strip()
    intake_id = str(bundle.get("intake_id") or "")
    lines = [
        "You are executing a prepared Codex task from Agent Host.",
        "",
        f"Prepared intake id: {intake_id or 'unknown'}",
        f"Prepared objective: {contract.get('objective') or 'unknown'}",
        f"Workspace mode: {taskbox.get('workspace_mode') or 'unknown'}",
        f"Allowed runner: {taskbox.get('allowed_runner') or 'unknown'}",
        f"Evidence decision: {evidence.get('decision') or 'none'}",
        "",
        "Prepared request:",
        prompt or "(empty)",
        "",
    ]
    if answers:
        lines.extend([
            "Prepare answers / constraints:",
            answers,
            "",
        ])
    read_plan = evidence.get("read_plan") if isinstance(evidence.get("read_plan"), list) else []
    if read_plan:
        lines.append("Read these sources before making conclusion-style claims:")
        for item in read_plan[:5]:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "unknown")
            reason = str(item.get("reason") or "")
            lines.append(f"- {path}" + (f": {reason}" if reason else ""))
        lines.append("")
    warnings = evidence.get("warnings") if isinstance(evidence.get("warnings"), list) else []
    if warnings:
        lines.append("Evidence warnings:")
        for warning in warnings[:3]:
            lines.append(f"- {warning}")
        lines.append("")
    if evidence.get("required") and evidence.get("decision") not in {None, "", "safe_to_answer"}:
        lines.extend([
            "Claim boundary:",
            "- Do not present the answer as a finalized formal conclusion until the referenced evidence is reviewed.",
            "- Prefer bounded analysis, verification, or reviewer-ready summaries over confident result claims.",
            "",
        ])
    if run_note:
        lines.extend([
            "Additional run note from the user:",
            run_note,
            "",
        ])
    lines.extend([
        "Current task:",
        "Execute the prepared request while respecting the prepared evidence/read-plan context above.",
    ])
    return safe_text("\n".join(lines).strip(), max_task_chars)
