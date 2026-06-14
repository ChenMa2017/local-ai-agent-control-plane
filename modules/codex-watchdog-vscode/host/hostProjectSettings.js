"use strict";

function createHostProjectSettings({
  vscode,
  fs,
  fsp,
  path,
  getSafeOutput
}) {
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
    await fsp.mkdir(settingsDir, { recursive: true });
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

  return {
    extensionSetting,
    extensionSettingWithSource,
    projectSetting,
    projectSettingWithSource,
    readProjectSettings,
    updateProjectSetting
  };
}

module.exports = {
  createHostProjectSettings
};
