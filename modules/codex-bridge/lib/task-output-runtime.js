"use strict";

const os = require("os");
const path = require("path");

function createTaskOutputRuntime(deps) {
  const {
    fsp,
    defaultConfig,
    DEFAULT_REFERENCE_CONTEXT_CHARS,
    FINAL_STATUSES,
    resolveMaybeRelative,
    safeResultFile,
    safeLogsFile,
    patchTask,
    readTask
  } = deps;

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function applyReplacement(text, pattern, replacement, state) {
    const next = text.replace(pattern, replacement);
    if (next !== text) {
      state.redacted = true;
    }
    return next;
  }

  function configuredProjectPaths(config, task) {
    const items = [];
    if (task && task.project_path && task.project) {
      items.push([String(task.project_path), String(task.project)]);
    }
    if (task && task.execution_project_path && task.project) {
      items.push([String(task.execution_project_path), String(task.project)]);
    }
    if (task && task.write_audit_root_path && task.project) {
      items.push([String(task.write_audit_root_path), String(task.project)]);
    }
    if (task && task.worktree_path && task.project) {
      items.push([String(task.worktree_path), String(task.project)]);
    }
    for (const [name, entry] of Object.entries(config.projects || {})) {
      const rawPath = typeof entry === "string" ? entry : entry && entry.path;
      if (!rawPath) {
        continue;
      }
      try {
        items.push([resolveMaybeRelative(rawPath, config.__baseDir), name]);
      } catch (_error) {
        // Ignore invalid project entries here; validation happens before running tasks.
      }
    }
    const seen = new Set();
    return items
      .filter(([workspacePath]) => {
        const key = path.resolve(workspacePath);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .sort((a, b) => b[0].length - a[0].length);
  }

  function sanitizeOutput(text, context = {}) {
    const config = context.config || {};
    const redaction = Object.assign({}, defaultConfig().redaction, config.redaction || {});
    const state = { redacted: false };
    let safe = String(text || "");

    if (redaction.enabled === false) {
      return { text: safe, redacted: false };
    }

    if (redaction.redactProjectPaths !== false) {
      for (const [workspacePath, name] of configuredProjectPaths(config, context.task || {})) {
        safe = applyReplacement(safe, new RegExp(escapeRegExp(workspacePath), "g"), `[workspace:${name}]`, state);
      }
    }

    if (redaction.redactHomePath !== false) {
      safe = applyReplacement(safe, new RegExp(escapeRegExp(os.homedir()), "g"), "~", state);
    }

    if (redaction.redactTokens !== false) {
      safe = applyReplacement(
        safe,
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        "[REDACTED_PRIVATE_KEY]",
        state
      );
      safe = applyReplacement(safe, /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Authorization: Bearer [REDACTED]", state);
      safe = applyReplacement(safe, /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]", state);
      safe = applyReplacement(safe, /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]", state);
      safe = applyReplacement(
        safe,
        /^([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*=\s*).+$/gim,
        "$1[REDACTED_ENV]",
        state
      );
    }

    return { text: safe, redacted: state.redacted };
  }

  function truncateText(text, maxChars) {
    const value = String(text || "");
    const limit = Number(maxChars || 0);
    if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) {
      return { text: value, truncated: false };
    }
    const marker = `[truncated to last ${limit} chars]\n`;
    return {
      text: marker + value.slice(Math.max(0, value.length - limit + marker.length)),
      truncated: true
    };
  }

  async function ensureSafeResult(config, task) {
    const raw = await fsp.readFile(task.result_file, "utf8").catch(() => "");
    const sanitized = sanitizeOutput(raw, { config, task });
    const truncated = truncateText(sanitized.text, config.redaction.maxResultChars);
    const file = safeResultFile(config, task);
    await fsp.writeFile(file, truncated.text, "utf8").catch(() => {});
    if (task.safe_result_file !== file) {
      await patchTask(config, task.task_id, { safe_result_file: file }).catch(() => {});
    }
    return {
      text: truncated.text,
      redacted: sanitized.redacted,
      truncated: truncated.truncated,
      file
    };
  }

  function referenceContextLimit(config) {
    const value = Number(
      config.referenceContextChars ||
      (config.redaction && config.redaction.referenceContextChars) ||
      DEFAULT_REFERENCE_CONTEXT_CHARS
    );
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_REFERENCE_CONTEXT_CHARS;
    }
    return value;
  }

  async function safeReferenceResultText(config, referenceTask) {
    const safeFile = safeResultFile(config, referenceTask);
    let safeText = await fsp.readFile(safeFile, "utf8").catch(() => "");
    if (!safeText && FINAL_STATUSES.has(referenceTask.status || "")) {
      await ensureSafeResult(config, referenceTask).catch(() => {});
      safeText = await fsp.readFile(safeFile, "utf8").catch(() => "");
    }
    const sanitized = sanitizeOutput(safeText, { config, task: referenceTask });
    return truncateText(sanitized.text, referenceContextLimit(config)).text.trim();
  }

  async function effectivePromptForTask(config, task) {
    if (!task.reference_task_id) {
      return task.prompt;
    }

    const referenceTask = await readTask(config, task.reference_task_id);
    const safeResult = await safeReferenceResultText(config, referenceTask);
    const safeReferencePrompt = truncateText(
      sanitizeOutput(referenceTask.prompt || "", { config, task: referenceTask }).text,
      2000
    ).text.trim();

    return [
      "You are continuing a Codex task chain.",
      "",
      `Reference task id: ${referenceTask.task_id}`,
      `Reference workspace: ${referenceTask.project || "unknown"}`,
      `Reference status: ${referenceTask.status || "unknown"}`,
      `Reference mode: ${referenceTask.mode || "unknown"}`,
      "",
      "Reference prompt:",
      safeReferencePrompt || "(empty)",
      "",
      "Reference safe result excerpt:",
      safeResult || "(safe result is not available yet)",
      "",
      "Current user request:",
      task.prompt
    ].join("\n");
  }

  async function resultPayload(config, task, options = {}) {
    if (options.raw) {
      const raw = await fsp.readFile(task.result_file, "utf8").catch(() => "");
      const truncated = truncateText(raw, Number(options.maxChars || config.redaction.maxResultChars));
      return {
        task_id: task.task_id,
        text: truncated.text,
        raw: true,
        redacted: false,
        truncated: truncated.truncated
      };
    }
    const safe = await ensureSafeResult(config, task);
    return {
      task_id: task.task_id,
      text: safe.text,
      raw: false,
      redacted: safe.redacted,
      truncated: safe.truncated
    };
  }

  async function collectLogText(task, tail) {
    const sections = [
      ["bridge.log", task.bridge_log_file],
      ["stdout.jsonl", task.stdout_file],
      ["stderr.log", task.stderr_file]
    ];
    const chunks = [];
    let linesReturned = 0;
    const lineLimit = Math.max(1, Number(tail || 80));
    for (const [label, file] of sections) {
      const text = await fsp.readFile(file, "utf8").catch(() => "");
      const lines = text.trimEnd().split("\n").filter(Boolean).slice(-lineLimit);
      linesReturned += lines.length;
      chunks.push(`\n## ${label}`);
      chunks.push(lines.length ? lines.join("\n") : "(empty)");
    }
    return {
      text: chunks.join("\n").trimStart(),
      linesReturned
    };
  }

  async function logsPayload(config, task, options = {}) {
    const rawLogs = await collectLogText(task, options.tail);
    const maxChars = Number(options.maxChars || config.redaction.maxLogChars);
    if (options.raw) {
      const truncated = truncateText(rawLogs.text, maxChars);
      return {
        task_id: task.task_id,
        text: truncated.text,
        raw: true,
        redacted: false,
        truncated: truncated.truncated,
        lines_returned: rawLogs.linesReturned
      };
    }

    const sanitized = sanitizeOutput(rawLogs.text, { config, task });
    const truncated = truncateText(sanitized.text, maxChars);
    const file = safeLogsFile(config, task);
    await fsp.writeFile(file, truncated.text, "utf8").catch(() => {});
    if (task.safe_logs_file !== file) {
      await patchTask(config, task.task_id, { safe_logs_file: file }).catch(() => {});
    }
    return {
      task_id: task.task_id,
      text: truncated.text,
      raw: false,
      redacted: sanitized.redacted,
      truncated: truncated.truncated,
      lines_returned: rawLogs.linesReturned
    };
  }

  return {
    sanitizeOutput,
    truncateText,
    ensureSafeResult,
    referenceContextLimit,
    safeReferenceResultText,
    effectivePromptForTask,
    resultPayload,
    collectLogText,
    logsPayload
  };
}

module.exports = {
  createTaskOutputRuntime
};
