"use strict";

const { createHostCommandRunner } = require("./hostCommandRunner");
const { createHostCodexResolver } = require("./hostCodexResolver");

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

  const commandRunner = createHostCommandRunner({
    cp,
    os,
    getSafeOutput
  });
  const run = commandRunner.run;
  const runLogged = commandRunner.runLogged;
  const runLoggedWithInput = commandRunner.runLoggedWithInput;

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
  const codexResolver = createHostCodexResolver({
    fs,
    path,
    os,
    expandHome,
    projectSettingWithSource,
    extensionSettingWithSource,
    run
  });
  const resolveCodexBin = codexResolver.resolveCodexBin;

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
