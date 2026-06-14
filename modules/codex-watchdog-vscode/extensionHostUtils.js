"use strict";

function createExtensionHostUtils({
  vscode,
  fs,
  fsp,
  path,
  os,
  crypto,
  cp,
  getOutput,
  getRuntimeConfigHelpers
}) {
  function getSafeOutput() {
    const value = typeof getOutput === "function" ? getOutput() : undefined;
    return value && typeof value.appendLine === "function" ? value : undefined;
  }

  function config() {
    return vscode.workspace.getConfiguration("codexWatchdog");
  }

  function extensionSetting(key, fallback) {
    return extensionSettingWithSource(key, fallback).value;
  }

  function extensionSettingWithSource(key, fallback) {
    const inspected = config().inspect(key);
    if (!inspected) {
      return { value: fallback, source: "fallback" };
    }
    if (inspected.globalValue !== undefined) {
      return { value: inspected.globalValue, source: "global" };
    }
    if (inspected.defaultValue !== undefined) {
      return { value: inspected.defaultValue, source: "default" };
    }
    return { value: fallback, source: "fallback" };
  }

  function expandHome(value) {
    if (!value) {
      return value;
    }
    if (value === "~") {
      return os.homedir();
    }
    if (value.startsWith("~/")) {
      return path.join(os.homedir(), value.slice(2));
    }
    return value;
  }

  function isExistingDirectory(value) {
    try {
      return fs.existsSync(value) && fs.statSync(value).isDirectory();
    } catch (_error) {
      return false;
    }
  }

  function validateProjectRootPath(value) {
    if (!path.isAbsolute(value)) {
      throw new Error(`Project root must be an absolute Linux path: ${value}`);
    }
    if (/[\x00-\x1F\x7F%]/.test(value)) {
      throw new Error(`Project root contains characters unsafe for generated systemd units: ${value}`);
    }
  }

  function isSafeProjectRootPath(value) {
    try {
      validateProjectRootPath(value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function requireExistingDirectory(value, label) {
    const expanded = expandHome(String(value || ""));
    validateProjectRootPath(expanded);
    if (!fs.existsSync(expanded)) {
      throw new Error(`${label} does not exist: ${expanded}`);
    }
    if (!fs.statSync(expanded).isDirectory()) {
      throw new Error(`${label} is not a directory: ${expanded}`);
    }
    return expanded;
  }

  function projectSetting(root, key, fallback) {
    return projectSettingWithSource(root, key, fallback).value;
  }

  function projectSettingWithSource(root, key, fallback) {
    const projectSettings = readProjectSettings(root);
    if (Object.prototype.hasOwnProperty.call(projectSettings, key)) {
      return { value: projectSettings[key], source: "project" };
    }
    if (fallback && typeof fallback === "object" && Object.prototype.hasOwnProperty.call(fallback, "value")) {
      return fallback;
    }
    return { value: fallback, source: "extension" };
  }

  function readProjectSettings(root) {
    const settingsPath = path.join(root, ".vscode", "settings.json");
    if (!fs.existsSync(settingsPath)) {
      return {};
    }
    try {
      return JSON.parse(stripJsonCommentsAndTrailingCommas(fs.readFileSync(settingsPath, "utf8")));
    } catch (error) {
      const output = getSafeOutput();
      if (output) {
        output.appendLine(`[warning] Could not parse ${settingsPath} as JSON/JSONC: ${error.message}`);
      }
      return {};
    }
  }

  async function updateProjectSetting(root, key, value) {
    const settingsDir = path.join(root, ".vscode");
    const settingsPath = path.join(settingsDir, "settings.json");
    await ensureDir(settingsDir);
    const settings = readProjectSettings(root);
    settings[key] = value;
    await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const output = getSafeOutput();
    if (output) {
      output.appendLine(`Updated ${path.relative(root, settingsPath)}: ${key}=${JSON.stringify(value)}`);
    }
  }

  function stripJsonCommentsAndTrailingCommas(text) {
    let outputText = "";
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (inLineComment) {
        if (char === "\n" || char === "\r") {
          inLineComment = false;
          outputText += char;
        }
        continue;
      }

      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          index += 1;
        } else if (char === "\n" || char === "\r") {
          outputText += char;
        }
        continue;
      }

      if (inString) {
        outputText += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        outputText += char;
        continue;
      }

      if (char === "/" && next === "/") {
        inLineComment = true;
        index += 1;
        continue;
      }

      if (char === "/" && next === "*") {
        inBlockComment = true;
        index += 1;
        continue;
      }

      outputText += char;
    }

    return removeTrailingCommas(outputText);
  }

  function removeTrailingCommas(text) {
    let outputText = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        outputText += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        outputText += char;
        continue;
      }

      if (char === ",") {
        let lookahead = index + 1;
        while (lookahead < text.length && /\s/.test(text[lookahead])) {
          lookahead += 1;
        }
        if (text[lookahead] === "}" || text[lookahead] === "]") {
          continue;
        }
      }

      outputText += char;
    }

    return outputText;
  }

  function projectSlug(root) {
    return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  }

  function unitNames(root) {
    const runtimeConfig = getRuntimeConfigHelpers();
    const prefix = runtimeConfig.servicePrefixSetting(root);
    const slug = projectSlug(root);
    const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
    const units = {
      service: `${prefix}-${slug}-${hash}.service`,
      timer: `${prefix}-${slug}-${hash}.timer`
    };
    runtimeConfig.validateUnitName(units.service, ".service");
    runtimeConfig.validateUnitName(units.timer, ".timer");
    return units;
  }

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
    return candidates.sort().at(-1) || "";
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

  async function runLogged(command, args, options = {}) {
    const output = getSafeOutput();
    if (output && typeof output.show === "function") {
      output.show(true);
    }
    if (output) {
      output.appendLine(`$ ${[command, ...args].join(" ")}`);
    }
    const result = await run(command, args, options);
    if (output && result.stdout.trim()) {
      output.appendLine(result.stdout.trimEnd());
    }
    if (output && result.stderr.trim()) {
      output.appendLine(result.stderr.trimEnd());
    }
    return result;
  }

  async function runLoggedWithInput(command, args, input, options = {}) {
    const output = getSafeOutput();
    if (output && typeof output.show === "function") {
      output.show(true);
    }
    if (output) {
      output.appendLine(`$ ${[command, ...args].join(" ")} <stdin>`);
    }
    const result = await runWithInput(command, args, input, options);
    if (output && result.stdout.trim()) {
      output.appendLine(result.stdout.trimEnd());
    }
    if (output && result.stderr.trim()) {
      output.appendLine(result.stderr.trimEnd());
    }
    return result;
  }

  function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      cp.execFile(command, args, {
        cwd: options.cwd || os.homedir(),
        env: { ...process.env, ...(options.env || {}) },
        timeout: options.timeout,
        maxBuffer: options.maxBuffer || 16 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error && !options.allowFailure) {
          error.message = `${error.message}\n${stderr || ""}`.trim();
          reject(error);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "", error });
      });
    });
  }

  function runWithInput(command, args, input, options = {}) {
    return new Promise((resolve, reject) => {
      const child = cp.spawn(command, args, {
        cwd: options.cwd || os.homedir(),
        env: { ...process.env, ...(options.env || {}) },
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutId;

      const finish = (error, result) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (error && !options.allowFailure) {
          error.message = `${error.message}\n${stderr || ""}`.trim();
          reject(error);
          return;
        }
        resolve(result);
      };

      if (options.timeout) {
        timeoutId = setTimeout(() => {
          child.kill("SIGTERM");
          const error = new Error(`Command timed out after ${options.timeout} ms`);
          error.code = "ETIMEDOUT";
          finish(error, { stdout, stderr, error });
        }, options.timeout);
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
          child.kill("SIGTERM");
          const error = new Error("stdout/stderr maxBuffer exceeded");
          finish(error, { stdout, stderr, error });
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
          child.kill("SIGTERM");
          const error = new Error("stdout/stderr maxBuffer exceeded");
          finish(error, { stdout, stderr, error });
        }
      });
      child.on("error", (error) => {
        finish(error, { stdout, stderr, error });
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        if ((code && code !== 0) || signal) {
          const error = new Error(signal ? `Command terminated by ${signal}` : `Command exited with status ${code}`);
          error.code = code;
          finish(error, { stdout, stderr, error });
          return;
        }
        finish(null, { stdout, stderr, error: null });
      });

      child.stdin.end(String(input || ""));
    });
  }

  async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  }

  async function openDocument(file, preview) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview });
  }

  function readFilePrefix(file, maxBytes) {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function systemdQuote(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  }

  function systemdPathValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\s/g, "\\x20");
  }

  function systemdEnvValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\s/g, "\\x20");
  }

  function isWatchdogInitialized(root) {
    return fs.existsSync(path.join(root, "agent", "PLAN.md"))
      && fs.existsSync(path.join(root, "agent", "SAFETY.md"))
      && fs.existsSync(path.join(root, "agent", "bin", "run_watchdog.sh"));
  }

  async function isEffectivelyEmptyDir(root) {
    try {
      const entries = await fsp.readdir(root);
      return entries.filter((entry) => ![".git", ".DS_Store"].includes(entry)).length === 0;
    } catch (_error) {
      return false;
    }
  }

  return {
    extensionSetting,
    extensionSettingWithSource,
    expandHome,
    isExistingDirectory,
    isSafeProjectRootPath,
    validateProjectRootPath,
    requireExistingDirectory,
    resolveCodexBin,
    projectSetting,
    projectSettingWithSource,
    unitNames,
    readProjectSettings,
    updateProjectSetting,
    runLogged,
    runLoggedWithInput,
    run,
    ensureDir,
    openDocument,
    readFilePrefix,
    shellQuote,
    systemdQuote,
    systemdPathValue,
    systemdEnvValue,
    isWatchdogInitialized,
    isEffectivelyEmptyDir
  };
}

module.exports = {
  createExtensionHostUtils
};
