"use strict";

function createHostCodexResolver({
  fs,
  path,
  os,
  expandHome,
  projectSettingWithSource,
  extensionSettingWithSource,
  run
}) {
  async function resolveCodexBin(root) {
    const setting = projectSettingWithSource(root, "codexWatchdog.codexBin", extensionSettingWithSource("codexBin", "codex"));
    const configured = String(setting.value || "codex");
    if (configured && configured !== "codex") {
      const expanded = expandHome(configured);
      validateConfiguredCodexBin(expanded);
      return expanded;
    }
    try {
      const result = await run("bash", ["-lc", "command -v codex"], { cwd: os.homedir() });
      const found = result.stdout.trim();
      if (found) {
        return found;
      }
    } catch (_error) {
      // Fall through to the VSCode OpenAI extension binary search below.
    }
    return findOpenAICodexExtensionBinary() || "codex";
  }

  function findOpenAICodexExtensionBinary() {
    const home = os.homedir();
    const roots = [
      path.join(home, ".vscode-server", "extensions"),
      path.join(home, ".vscode", "extensions")
    ];
    const candidates = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      for (const extensionDir of fs.readdirSync(root)) {
        if (!/^openai\.chatgpt-/.test(extensionDir)) {
          continue;
        }
        const binRoot = path.join(root, extensionDir, "bin");
        if (!fs.existsSync(binRoot)) {
          continue;
        }
        for (const platformDir of fs.readdirSync(binRoot)) {
          if (!/^linux-/.test(platformDir)) {
            continue;
          }
          const candidate = path.join(binRoot, platformDir, "codex");
          if (!fs.existsSync(candidate)) {
            continue;
          }
          try {
            validateConfiguredCodexBin(candidate);
            candidates.push(candidate);
          } catch (_error) {
            // Ignore non-executable or non-allowlisted candidates.
          }
        }
      }
    }
    const sorted = candidates.sort();
    return sorted[sorted.length - 1] || "";
  }

  function validateConfiguredCodexBin(value) {
    if (!path.isAbsolute(value)) {
      throw new Error(`codexWatchdog.codexBin must be "codex" or an allowed absolute path: ${value}`);
    }
    if (path.basename(value) !== "codex") {
      throw new Error(`codexWatchdog.codexBin must point to an executable named codex: ${value}`);
    }

    const normalized = path.normalize(value);
    const home = os.homedir();
    const exactAllowed = [
      path.join(home, ".local", "bin", "codex"),
      "/usr/bin/codex",
      "/usr/local/bin/codex",
      "/bin/codex"
    ];
    if (
      exactAllowed.includes(normalized)
      || isOpenAICodexExtensionPath(normalized, path.join(home, ".vscode-server", "extensions"))
      || isOpenAICodexExtensionPath(normalized, path.join(home, ".vscode", "extensions"))
    ) {
      const stat = fs.statSync(normalized);
      if (!stat.isFile()) {
        throw new Error(`codexWatchdog.codexBin is not a file: ${value}`);
      }
      if ((stat.mode & 0o111) === 0) {
        throw new Error(`codexWatchdog.codexBin is not executable: ${value}`);
      }
      return;
    }

    throw new Error(`Refusing codexWatchdog.codexBin outside allowed locations: ${value}`);
  }

  function isOpenAICodexExtensionPath(value, extensionRoot) {
    const relative = path.relative(path.resolve(extensionRoot), path.resolve(value));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }
    const parts = relative.split(path.sep);
    return parts.length === 4
      && /^openai\.chatgpt-/.test(parts[0])
      && parts[1] === "bin"
      && /^linux-/.test(parts[2])
      && parts[3] === "codex";
  }

  return {
    resolveCodexBin
  };
}

module.exports = {
  createHostCodexResolver
};
