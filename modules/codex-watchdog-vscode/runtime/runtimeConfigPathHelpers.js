"use strict";

function isSafeServicePrefix(value) {
  return /^[A-Za-z0-9_.@-]+$/.test(value) && !value.includes("..");
}

function isPathInside(pathModule, child, parent) {
  const relative = pathModule.relative(pathModule.resolve(parent), pathModule.resolve(child));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !pathModule.isAbsolute(relative));
}

function projectSlug(pathModule, root) {
  return pathModule.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

function createRuntimeConfigPathHelpers({
  fs,
  path,
  os,
  output,
  defaultServicePrefix,
  extensionSetting,
  extensionSettingWithSource,
  projectSetting,
  projectSettingWithSource,
  expandHome
}) {
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

  function defaultProjectWatcherHome(root) {
    return path.join(os.homedir(), ".codex-watchers", projectSlug(path, root));
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
    if (setting.source === "project" && !isPathInside(path, realTarget, realHome)) {
      const logicalRoot = path.resolve(root);
      const realRoot = realpathForPotentialPath(logicalRoot);
      const targetInsideSelectedProject = isPathInside(path, normalized, logicalRoot) || isPathInside(path, realTarget, realRoot);
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
      if (isPathInside(path, effectiveRealTarget, realBlocked)) {
        throw new Error(`Refusing project-local codexWatchdog.codexHome inside protected path: ${plan.effectivePath}`);
      }
    }
    return plan;
  }

  function codexHomeSetting(root) {
    return codexHomePlan(root).effectivePath;
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

  return {
    workspaceWritePolicyAllowed,
    codexHomeSetting,
    codexHomePlan,
    servicePrefixSetting,
    validateUnitName
  };
}

module.exports = {
  createRuntimeConfigPathHelpers
};
