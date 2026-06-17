from __future__ import annotations

import re
from typing import Any


INTAKE_QUESTION_MAX = 3
WRITE_SCOPE_HINT_RE = re.compile(r"(/|\.(?:md|txt|json|py|js|ts|tsx|jsx|yaml|yml|sh)\b|README|agent/|workspace/|runs/)", re.I)
DEICTIC_HINT_RE = re.compile(r"\b(this|that|it|these|those|here|there)\b|这个|这个问题|这个任务|它|上述|前面的", re.I)


def intake_words(text: str) -> str:
    return " ".join(str(text or "").split()).lower()


def evidence_index_markers_present(text: str) -> bool:
    lowered = intake_words(text)
    markers = (
        "current conclusion",
        "current best",
        "best candidate",
        "formal result",
        "official conclusion",
        "verify whether",
        "compare",
        "versus",
        "vs ",
        "replace baseline",
        "adopt",
        "current status of the conclusion",
        "当前",
        "结论",
        "最佳",
        "比较",
        "验证",
        "是否采用",
        "是否替换",
        "基线",
    )
    return any(marker in lowered for marker in markers)


def parse_intent_signals(prompt: str, answers: str) -> dict[str, bool]:
    text = intake_words(f"{prompt}\n{answers}")
    return {
        "wants_write": any(term in text for term in ("fix", "update", "modify", "change", "edit", "rewrite", "implement", "修复", "修改", "更新", "实现", "改一下")),
        "wants_report_only": any(term in text for term in ("summarize", "summary", "explain", "review", "analyze", "status", "report", "总结", "说明", "检查", "分析", "状态")),
        "wants_local_workspace_copy": any(term in text for term in ("local workspace", "project_local_copy", "workspace/", "copy into workspace", "本地副本", "副本")),
        "wants_cpu_eval": any(term in text for term in ("cpu", "cpu32", "smoke", "eval", "probe", "bounded cpu", "sample_count", "cpu-only", "cpu only")),
        "wants_gpu": "gpu" in text,
        "wants_training": any(term in text for term in ("train", "training", "finetune", "qat", "训练")),
        "wants_promotion": any(term in text for term in ("promote", "promotion", "shared_model", "deployment", "public docs", "合并到共享", "发布")),
        "wants_external_send": any(term in text for term in ("external send", "reviewer send", "deep research send", "发给 reviewer", "外部发送")),
        "wants_secret_or_service": any(term in text for term in ("token", "secret", ".env", "systemd", "restart service", "private key", "密码")),
        "mentions_experiment": any(term in text for term in ("experiment", "ablation", "baseline", "control arm", "control", "curriculum", "checkpoint sweep", "official eval", "long eval", "compare", "vs ", "versus", "实验", "对照", "基线", "比较", "消融")),
        "mentions_metric_goal": any(term in text for term in ("success criterion", "metric", "psnr", "ssim", "accuracy", "loss", "fixed epoch", "curve comparison", "指标", "成功标准", "loss")),
        "mentions_fairness_constraint": any(term in text for term in ("one factor", "fair", "same budget", "same data", "same checkpoint", "same eval", "单一变量", "公平", "同预算", "同数据")),
        "wants_evidence_index": evidence_index_markers_present(text),
    }


def explicit_scope_present(prompt: str, answers: str) -> bool:
    text = f"{prompt}\n{answers}"
    if WRITE_SCOPE_HINT_RE.search(text):
        return True
    return any(term in text.lower() for term in ("file ", "files ", "folder ", "directory ", "path ", "目录", "文件", "路径"))


def infer_objective(signals: dict[str, bool]) -> str:
    if signals["wants_external_send"]:
        return "external_send"
    if signals["wants_promotion"]:
        return "promotion_apply"
    if signals["wants_training"]:
        return "bounded_training_canary" if signals["wants_cpu_eval"] else "training"
    if signals["wants_gpu"]:
        return "bounded_gpu_probe" if signals["wants_cpu_eval"] else "gpu"
    if signals["wants_local_workspace_copy"]:
        return "local_workspace_copy"
    if signals["wants_cpu_eval"]:
        return "bounded_cpu_eval"
    if signals["wants_write"]:
        return "local_workspace_copy"
    return "report_only"


def clarification_questions(gray_areas: list[str], signals: dict[str, bool]) -> list[str]:
    questions: list[str] = []
    if "target_reference_missing" in gray_areas:
        questions.append("你指的是哪个具体对象？请给出文件、目录、工作区，或提供 reference_task_id。")
    if "write_scope_missing" in gray_areas:
        questions.append("如果允许修改，请明确允许改动的文件或目录范围；如果只想先分析，也可以直接说明“先只读总结”。")
    if signals["wants_write"] and not signals["wants_local_workspace_copy"] and not signals["wants_cpu_eval"]:
        questions.append("这次是希望先做本地副本修复方案，还是只整理可执行 task contract？")
    if "experiment_question_missing" in gray_areas:
        questions.append("这次高成本实验要回答的核心问题是什么？请尽量用 A/B/C 或一句明确结论来确认，例如：A. 比较基线 vs 新机制；B. 验证某个 curriculum 是否有效。")
    if "control_definition_missing" in gray_areas:
        questions.append("这次实验的 control / baseline 到底指什么？请明确一个对照臂定义，不要只说 baseline。")
    if "fairness_constraint_missing" in gray_areas:
        questions.append("这次是否要求单一变量对比？请明确回答 Yes/No，或说明哪些因素允许同时变化。")
    if "success_criterion_missing" in gray_areas:
        questions.append("这次以什么结果算成功？请明确 metric / checkpoint / fixed epoch / curve comparison 中的判断标准。")
    return questions[:INTAKE_QUESTION_MAX]


def experiment_decision_gate_required(objective: str, signals: dict[str, bool]) -> bool:
    if signals.get("wants_training") or signals.get("wants_gpu"):
        return True
    if objective in {"training", "gpu", "bounded_training_canary", "bounded_gpu_probe"}:
        return True
    if objective == "bounded_cpu_eval" and signals["mentions_experiment"]:
        return True
    return False


def experiment_field_present(text: str, kind: str) -> bool:
    lowered = intake_words(text)
    if kind == "experiment_question":
        return any(term in lowered for term in ("question", "goal", "test whether", "hypothesis", "验证", "目标", "问题", "比较", "compare", "vs ", "versus"))
    if kind == "control_definition":
        return any(term in lowered for term in ("control", "baseline", "对照", "基线", "control arm"))
    if kind == "fairness_constraint":
        return any(term in lowered for term in ("one factor", "fair", "same budget", "same data", "same checkpoint", "same eval", "单一变量", "公平", "同预算", "同数据"))
    if kind == "success_criterion":
        return any(term in lowered for term in ("success criterion", "metric", "psnr", "ssim", "accuracy", "loss", "fixed epoch", "curve comparison", "指标", "成功标准"))
    return False


def build_experiment_decision_gate(prompt: str, answers: str, objective: str, signals: dict[str, bool]) -> dict[str, Any]:
    required = experiment_decision_gate_required(objective, signals)
    combined = f"{prompt}\n{answers}"
    decisions = [
        {
            "decision_id": "D-01",
            "key": "experiment_question",
            "title": "Experimental question",
            "required": required,
            "resolved": experiment_field_present(combined, "experiment_question") if required else False,
        },
        {
            "decision_id": "D-02",
            "key": "control_definition",
            "title": "Control-arm definition",
            "required": required,
            "resolved": experiment_field_present(combined, "control_definition") if required else False,
        },
        {
            "decision_id": "D-05",
            "key": "fairness_constraint",
            "title": "Fairness constraint",
            "required": required,
            "resolved": experiment_field_present(combined, "fairness_constraint") if required else False,
        },
        {
            "decision_id": "D-06",
            "key": "success_criterion",
            "title": "Success criterion",
            "required": required,
            "resolved": experiment_field_present(combined, "success_criterion") if required else False,
        },
    ]
    unresolved_items = []
    if required:
        for item in decisions:
            if not item["resolved"]:
                unresolved_items.append(f"{item['key']}_missing")
    return {
        "schema_version": 1,
        "required": required,
        "objective": objective,
        "decision_count": len(decisions) if required else 0,
        "resolved_count": sum(1 for item in decisions if item["resolved"]) if required else 0,
        "unresolved_items": unresolved_items,
        "decisions": decisions if required else [],
        "blocking": required and bool(unresolved_items),
    }


def build_gray_areas(prompt: str, answers: str, reference_task_id: str, signals: dict[str, bool]) -> list[str]:
    gray: list[str] = []
    merged = f"{prompt}\n{answers}"
    if signals["wants_write"] and not explicit_scope_present(prompt, answers):
        gray.append("write_scope_missing")
    if DEICTIC_HINT_RE.search(merged) and not reference_task_id and not explicit_scope_present(prompt, answers):
        gray.append("target_reference_missing")
    if not prompt.strip():
        gray.append("empty_prompt")
    gate = build_experiment_decision_gate(prompt, answers, infer_objective(signals), signals)
    if gate["required"]:
        gray.extend(gate["unresolved_items"])
    return gray


def should_consult_evidence_index(prompt: str, answers: str, objective: str, signals: dict[str, bool]) -> bool:
    if signals.get("wants_evidence_index"):
        return True
    if objective == "bounded_cpu_eval" and bool(signals.get("mentions_experiment")):
        return True
    return False


def evidence_retrieval_summary(evidence: dict[str, Any]) -> dict[str, Any]:
    return {
        "required": bool(evidence.get("required")),
        "available": bool(evidence.get("available")),
        "consulted": bool(evidence.get("consulted")),
        "query": str(evidence.get("query") or ""),
        "decision": evidence.get("decision"),
        "warnings": list(evidence.get("warnings") or []),
        "read_plan": list(evidence.get("read_plan") or []),
        "reason": str(evidence.get("reason") or ""),
    }


def read_plan_markdown(evidence: dict[str, Any]) -> str:
    lines = [
        "# Evidence Retrieval",
        "",
        f"- required: {'true' if evidence.get('required') else 'false'}",
        f"- available: {'true' if evidence.get('available') else 'false'}",
        f"- consulted: {'true' if evidence.get('consulted') else 'false'}",
        f"- decision: {evidence.get('decision') or 'none'}",
        f"- reason: {evidence.get('reason') or 'none'}",
        "",
    ]
    warnings = evidence.get("warnings") if isinstance(evidence.get("warnings"), list) else []
    if warnings:
        lines.append("## Warnings")
        lines.append("")
        for item in warnings:
            lines.append(f"- {item}")
        lines.append("")
    read_plan = evidence.get("read_plan") if isinstance(evidence.get("read_plan"), list) else []
    if read_plan:
        lines.append("## Read Plan")
        lines.append("")
        for item in read_plan:
            if isinstance(item, dict):
                path = item.get("path") or "unknown"
                reason = item.get("reason") or ""
                lines.append(f"- {path}: {reason}")
        lines.append("")
    else:
        lines.extend(["## Read Plan", "", "- No read-plan entries were produced.", ""])
    return "\n".join(lines).rstrip() + "\n"


def intake_risk_class(objective: str, signals: dict[str, bool]) -> str:
    if objective in {"external_send", "promotion_apply", "training", "gpu"} or signals["wants_secret_or_service"]:
        return "high"
    if objective in {"bounded_gpu_probe", "bounded_training_canary", "local_workspace_copy", "bounded_cpu_eval"}:
        return "medium"
    return "low"
