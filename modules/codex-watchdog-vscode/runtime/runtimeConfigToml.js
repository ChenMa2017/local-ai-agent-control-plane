"use strict";

function parseTomlBasicString(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${key}\\s*=\\s*\"([^\"\\\\]*(?:\\\\.[^\"\\\\]*)*)\"\\s*$`, "m"));
  if (!match) {
    return "";
  }
  return match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function hasTomlAssignment(text, key) {
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(String(text || ""));
}

function tomlStringLiteral(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function insertRootTomlAssignments(text, assignments) {
  const lines = assignments.filter(Boolean);
  if (!lines.length) {
    return String(text || "");
  }
  const source = String(text || "");
  const withTrailingNewline = source.endsWith("\n") ? source : `${source}\n`;
  const sectionMatch = withTrailingNewline.match(/^\s*\[[^\n]+\]\s*$/m);
  if (!sectionMatch) {
    const prefix = withTrailingNewline.trimEnd();
    return `${prefix}${prefix ? "\n" : ""}${lines.join("\n")}\n`;
  }
  const before = withTrailingNewline.slice(0, sectionMatch.index).trimEnd();
  const after = withTrailingNewline.slice(sectionMatch.index).trimStart();
  return `${before}${before ? "\n" : ""}${lines.join("\n")}\n\n${after}`;
}

function ensureHooksFeature(text) {
  const source = String(text || "");
  if (/^\s*hooks\s*=/m.test(source)) {
    return source;
  }
  if (/^\s*\[features\]\s*$/m.test(source)) {
    return source.replace(/(^\s*\[features\]\s*$)/m, "$1\nhooks = true");
  }
  const prefix = source.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}[features]\nhooks = true\n`;
}

function createRuntimeConfigTomlHelpers({
  fs,
  path,
  os
}) {
  function watcherProfileModelDefaults() {
    const profilePath = path.join(os.homedir(), ".codex", "config.toml");
    if (!fs.existsSync(profilePath)) {
      return { model: "", modelReasoningEffort: "" };
    }
    try {
      const text = fs.readFileSync(profilePath, "utf8");
      return {
        model: parseTomlBasicString(text, "model"),
        modelReasoningEffort: parseTomlBasicString(text, "model_reasoning_effort")
      };
    } catch (_error) {
      return { model: "", modelReasoningEffort: "" };
    }
  }

  function mergeWatcherConfigText(existingText, profileDefaults = watcherProfileModelDefaults()) {
    let next = String(existingText || "");
    let changed = false;

    const migratedHooks = next.replace(/(^|\n)codex_hooks\s*=\s*true(\s*(?:\n|$))/g, "$1hooks = true$2");
    if (migratedHooks !== next) {
      next = migratedHooks;
      changed = true;
    }

    const rootAssignments = [];
    if (!hasTomlAssignment(next, "approval_policy")) {
      rootAssignments.push('approval_policy = "never"');
    }
    if (!hasTomlAssignment(next, "sandbox_mode")) {
      rootAssignments.push('sandbox_mode = "read-only"');
    }
    if (!hasTomlAssignment(next, "allow_login_shell")) {
      rootAssignments.push("allow_login_shell = false");
    }
    if (profileDefaults.model && !hasTomlAssignment(next, "model")) {
      rootAssignments.push(`model = ${tomlStringLiteral(profileDefaults.model)}`);
    }
    if (profileDefaults.modelReasoningEffort && !hasTomlAssignment(next, "model_reasoning_effort")) {
      rootAssignments.push(`model_reasoning_effort = ${tomlStringLiteral(profileDefaults.modelReasoningEffort)}`);
    }
    if (rootAssignments.length) {
      next = insertRootTomlAssignments(next, rootAssignments);
      changed = true;
    }

    const withHooks = ensureHooksFeature(next);
    if (withHooks !== next) {
      next = withHooks;
      changed = true;
    }

    return {
      text: next.endsWith("\n") ? next : `${next}\n`,
      changed,
      inheritedModel: Boolean(profileDefaults.model),
      inheritedReasoning: Boolean(profileDefaults.modelReasoningEffort)
    };
  }

  return {
    parseTomlBasicString,
    hasTomlAssignment,
    watcherProfileModelDefaults,
    mergeWatcherConfigText
  };
}

module.exports = {
  createRuntimeConfigTomlHelpers,
  parseTomlBasicString,
  hasTomlAssignment
};
