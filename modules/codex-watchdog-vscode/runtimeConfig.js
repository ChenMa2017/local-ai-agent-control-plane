"use strict";

function createRuntimeConfigHelpers({
  fs,
  path,
  os,
  output,
  defaultWatchdogRole,
  defaultServicePrefix,
  extensionSetting,
  extensionSettingWithSource,
  projectSetting,
  projectSettingWithSource,
  expandHome
}) {
  function positiveNumberSetting(root, key, fallback, min, hardFallback) {
    const raw = projectSetting(root, key, fallback);
    const value = Number(raw);
    if (Number.isFinite(value) && value >= min) {
      return Math.floor(value);
    }
    output.appendLine(`[warning] Ignoring invalid ${key}=${JSON.stringify(raw)}; using ${hardFallback}.`);
    return hardFallback;
  }

  function booleanSetting(root, key, fallback, hardFallback) {
    const raw = projectSetting(root, key, fallback);
    if (typeof raw === "boolean") {
      return raw;
    }
    if (typeof raw === "number") {
      if (raw === 1) {
        return true;
      }
      if (raw === 0) {
        return false;
      }
    }
    if (typeof raw === "string") {
      const value = raw.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(value)) {
        return true;
      }
      if (["0", "false", "no", "off"].includes(value)) {
        return false;
      }
    }
    output.appendLine(`[warning] Ignoring invalid ${key}=${JSON.stringify(raw)}; using ${hardFallback}.`);
    return hardFallback;
  }

  function sandboxModeSetting(root) {
    const value = String(projectSetting(root, "codexWatchdog.sandboxMode", extensionSetting("sandboxMode", "read-only")) || "read-only");
    if (value === "read-only") {
      return value;
    }
    if (value === "workspace-write") {
      if (workspaceWritePolicyAllowed(root)) {
        return value;
      }
      output.appendLine("[warning] workspace-write requested but agent/workspace_write_policy.json is missing or invalid; using read-only.");
      return "read-only";
    }
    output.appendLine(`[warning] Ignoring invalid codexWatchdog.sandboxMode=${JSON.stringify(value)}; using read-only.`);
    return "read-only";
  }

  function watchdogRoleSetting(root) {
    const value = String(projectSetting(root, "codexWatchdog.role", extensionSetting("role", defaultWatchdogRole)) || defaultWatchdogRole).toLowerCase();
    if (value === "runner" || value === "supervisor") {
      return value;
    }
    output.appendLine(`[warning] Ignoring invalid codexWatchdog.role=${JSON.stringify(value)}; using ${defaultWatchdogRole}.`);
    return defaultWatchdogRole;
  }

  function workspaceWritePolicyAllowed(root) {
    const policyPath = path.join(root, "agent", "workspace_write_policy.json");
    if (!fs.existsSync(policyPath)) {
      return false;
    }
    try {
      const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
      if (!policy || policy.enabled !== true) {
        return false;
      }
      if (!Array.isArray(policy.writable_paths) || policy.writable_paths.length === 0) {
        return false;
      }
      if (!Array.isArray(policy.allowed_commands) || policy.allowed_commands.length === 0) {
        return false;
      }
      for (const rel of policy.writable_paths) {
        if (typeof rel !== "string" || !rel.trim() || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..") || /[\x00-\x1F\x7F]/.test(rel)) {
          return false;
        }
      }
      for (const command of policy.allowed_commands) {
        if (typeof command !== "string" || !command.trim() || /[\x00-\x08\x0B-\x1F\x7F]/.test(command)) {
          return false;
        }
      }
      return true;
    } catch (error) {
      output.appendLine(`[warning] Could not read agent/workspace_write_policy.json: ${error.message || String(error)}`);
      return false;
    }
  }

  function codexHomeSetting(root) {
    return codexHomePlan(root).effectivePath;
  }

  function codexHomePlan(root) {
    const setting = projectSettingWithSource(root, "codexWatchdog.codexHome", extensionSettingWithSource("codexHome", "~/.codex-watcher"));
    const expanded = expandHome(String(setting.value || "~/.codex-watcher"));
    if (!path.isAbsolute(expanded)) {
      throw new Error(`codexWatchdog.codexHome must be an absolute path or ~/ path: ${setting.value}`);
    }
    if (/[\x00-\x1F\x7F%]/.test(expanded)) {
      throw new Error(`codexWatchdog.codexHome contains characters unsafe for generated systemd units: ${expanded}`);
    }
    const home = os.homedir();
    const normalized = path.normalize(expanded);
    const plan = {
      configuredPath: expanded,
      effectivePath: expanded,
      source: setting.source,
      migrationReason: "",
      requiresProjectSettingUpdate: false
    };
    const realHome = fs.realpathSync(home);
    const realTarget = realpathForPotentialPath(normalized);
    if (setting.source === "project" && realTarget === realHome) {
      throw new Error("Refusing project-local codexWatchdog.codexHome equal to the home directory.");
    }
    if (setting.source === "project" && !isPathInside(realTarget, realHome)) {
      const logicalRoot = path.resolve(root);
      const realRoot = realpathForPotentialPath(logicalRoot);
      const targetInsideSelectedProject = isPathInside(normalized, logicalRoot) || isPathInside(realTarget, realRoot);
      if (targetInsideSelectedProject) {
        plan.effectivePath = defaultProjectWatcherHome(root);
        plan.migrationReason = [
          "Project-local codexWatchdog.codexHome resolved outside the current user's home after realpath.",
          `Using ${plan.effectivePath} instead so bind-mounted server workspaces still get a safe watcher home.`
        ].join(" ");
        plan.requiresProjectSettingUpdate = plan.effectivePath !== plan.configuredPath;
      } else {
        throw new Error(`Refusing project-local codexWatchdog.codexHome outside the current user's home: ${expanded}`);
      }
    }
    const effectiveRealTarget = realpathForPotentialPath(path.normalize(plan.effectivePath));
    for (const blocked of [
      "/etc",
      "/root",
      "/bin",
      "/sbin",
      "/usr",
      "/lib",
      "/lib64",
      "/boot",
      "/dev",
      "/proc",
      "/sys",
      "/run",
      path.join(home, ".ssh"),
      path.join(home, ".config", "systemd"),
      path.join(home, ".vscode-server", "extensions"),
      path.join(home, ".vscode", "extensions")
    ]) {
      const realBlocked = fs.existsSync(blocked)
        ? fs.realpathSync(blocked)
        : realpathForPotentialPath(blocked);
      if (isPathInside(effectiveRealTarget, realBlocked)) {
        throw new Error(`Refusing project-local codexWatchdog.codexHome inside protected path: ${plan.effectivePath}`);
      }
    }
    return plan;
  }

  function defaultProjectWatcherHome(root) {
    return path.join(os.homedir(), ".codex-watchers", projectSlug(root));
  }

  function servicePrefixSetting(root) {
    const raw = String(projectSetting(root, "codexWatchdog.servicePrefix", extensionSetting("servicePrefix", defaultServicePrefix)) || defaultServicePrefix);
    if (!isSafeServicePrefix(raw)) {
      throw new Error(`Invalid codexWatchdog.servicePrefix: ${raw}. Use only A-Z, a-z, 0-9, _, ., @, and -, without "..".`);
    }
    return raw;
  }

  function validateUnitName(name, suffix) {
    if (path.basename(name) !== name || name.includes("/") || name.includes("\\") || name.includes("..") || !name.endsWith(suffix) || !/^[A-Za-z0-9_.@-]+$/.test(name)) {
      throw new Error(`Unsafe generated systemd unit name: ${name}`);
    }
  }

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

  function isSafeServicePrefix(value) {
    return /^[A-Za-z0-9_.@-]+$/.test(value) && !value.includes("..");
  }

  function isPathInside(child, parent) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function realpathForPotentialPath(target) {
    const resolved = path.resolve(target);
    let current = resolved;
    const missing = [];

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`No existing parent directory for path: ${target}`);
      }
      missing.unshift(path.basename(current));
      current = parent;
    }

    const realBase = fs.realpathSync(current);
    return missing.length ? path.join(realBase, ...missing) : realBase;
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

  function projectSlug(root) {
    return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  }

  return {
    positiveNumberSetting,
    booleanSetting,
    sandboxModeSetting,
    watchdogRoleSetting,
    codexHomeSetting,
    codexHomePlan,
    servicePrefixSetting,
    validateUnitName,
    parseTomlBasicString,
    hasTomlAssignment,
    watcherProfileModelDefaults,
    mergeWatcherConfigText
  };
}

module.exports = {
  createRuntimeConfigHelpers
};
