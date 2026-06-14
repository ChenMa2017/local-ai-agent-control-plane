"use strict";

function createRuntimeConfigValueParsers({
  output,
  defaultWatchdogRole,
  extensionSetting,
  projectSetting,
  workspaceWritePolicyAllowed
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

  return {
    positiveNumberSetting,
    booleanSetting,
    sandboxModeSetting,
    watchdogRoleSetting
  };
}

module.exports = {
  createRuntimeConfigValueParsers
};
