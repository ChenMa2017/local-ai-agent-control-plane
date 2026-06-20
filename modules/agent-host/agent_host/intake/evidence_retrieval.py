from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


def evidence_index_root(project_root: Path) -> Path:
    return project_root / "project_index"


def evidence_search_script(project_root: Path) -> Path:
    return project_root / "agent" / "bin" / "watchdog_doc_search.py"


def maybe_run_evidence_retrieval(
    project_root: Path,
    prompt: str,
    answers: str,
    objective: str,
    signals: dict[str, bool],
    safe_text: Callable[[str, int], str],
    should_consult_evidence_index: Callable[[str, str, str, dict[str, bool]], bool],
) -> dict[str, Any]:
    query = safe_text(prompt or answers or "", 2000)
    required = should_consult_evidence_index(prompt, answers, objective, signals)
    result: dict[str, Any] = {
        "schema_version": 1,
        "required": required,
        "available": False,
        "consulted": False,
        "query": query,
        "decision": None,
        "warnings": [],
        "read_plan": [],
        "hits": [],
        "reason": "",
        "tool": "",
    }
    if not required:
        result["reason"] = "query does not currently require metadata-first evidence retrieval"
        return result

    index_root = evidence_index_root(project_root)
    if not index_root.exists():
        result["reason"] = f"project_index is not available under {index_root}"
        return result

    script = evidence_search_script(project_root)
    if not script.exists():
        result["available"] = True
        result["reason"] = f"evidence search tool is missing: {script}"
        return result

    result["available"] = True
    result["tool"] = str(script)
    try:
        completed = subprocess.run(
            [
                sys.executable or "python3",
                str(script),
                "--project-root",
                str(project_root),
                "--query",
                query,
                "--json",
            ],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except Exception as exc:
        result["consulted"] = True
        result["decision"] = "index_error"
        result["warnings"] = [f"evidence retrieval failed to start: {exc}"]
        result["reason"] = "subprocess invocation failed"
        return result

    result["consulted"] = True
    stderr = (completed.stderr or "").strip()
    stdout = (completed.stdout or "").strip()
    if completed.returncode != 0:
        result["decision"] = "index_error"
        result["warnings"] = [stderr or f"evidence retrieval exited with code {completed.returncode}"]
        result["reason"] = "watchdog_doc_search.py returned a nonzero exit code"
        return result
    try:
        payload = json.loads(stdout or "{}")
    except json.JSONDecodeError as exc:
        result["decision"] = "index_error"
        result["warnings"] = [f"invalid JSON from evidence retrieval: {exc}"]
        if stderr:
            result["warnings"].append(stderr)
        result["reason"] = "watchdog_doc_search.py returned invalid JSON"
        return result
    if not isinstance(payload, dict):
        result["decision"] = "index_error"
        result["warnings"] = ["evidence retrieval returned a non-object payload"]
        result["reason"] = "watchdog_doc_search.py returned an unexpected payload shape"
        return result

    result["decision"] = payload.get("decision")
    result["warnings"] = payload.get("warnings") if isinstance(payload.get("warnings"), list) else []
    result["read_plan"] = payload.get("read_plan") if isinstance(payload.get("read_plan"), list) else []
    result["hits"] = payload.get("hits") if isinstance(payload.get("hits"), list) else []
    if not result["decision"]:
        result["decision"] = "index_error"
        result["warnings"].append("evidence retrieval did not return a decision")
        result["reason"] = "missing decision in watchdog_doc_search.py payload"
    else:
        result["reason"] = "retrieval completed"
    return result
