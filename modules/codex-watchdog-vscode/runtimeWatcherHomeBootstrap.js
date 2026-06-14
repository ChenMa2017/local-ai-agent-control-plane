"use strict";

function createRuntimeWatcherHomeBootstrapHelpers({
  vscode,
  fs,
  fsp,
  path,
  os,
  output,
  codexHomeSetting,
  codexHomePlan,
  updateProjectSetting,
  watcherProfileModelDefaults,
  mergeWatcherConfigText,
  hasTomlAssignment,
  parseTomlBasicString,
  ensureDir
}) {
  function defaultMainCodexHome() {
    return path.join(os.homedir(), ".codex");
  }

  async function ensureCodexHome(root) {
    let plan = codexHomePlan(root);
    if (plan.requiresProjectSettingUpdate) {
      await updateProjectSetting(root, "codexWatchdog.codexHome", plan.effectivePath);
      output.appendLine(`[warning] ${plan.migrationReason}`);
      vscode.window.showInformationMessage(`Codex Watchdog moved this project's watcher home to ${plan.effectivePath}. Reinstall the timer after review so systemd uses the migrated CODEX_HOME.`);
      plan = codexHomePlan(root);
    }
    const codexHome = plan.effectivePath;
    await ensureDir(codexHome);
    const configPath = path.join(codexHome, "config.toml");
    const profileDefaults = watcherProfileModelDefaults();
    if (!fs.existsSync(configPath)) {
      const merged = mergeWatcherConfigText("", profileDefaults);
      await fsp.writeFile(configPath, merged.text);
      output.appendLine(`Wrote ${configPath}`);
      if (merged.inheritedModel) {
        output.appendLine("Seeded watcher model config from the main Codex profile.");
      }
    } else {
      const existing = await fsp.readFile(configPath, "utf8");
      const merged = mergeWatcherConfigText(existing, profileDefaults);
      if (merged.changed) {
        await fsp.writeFile(configPath, merged.text);
        output.appendLine(`Updated ${configPath}`);
        if (merged.inheritedModel && !hasTomlAssignment(existing, "model")) {
          output.appendLine("Seeded missing watcher model config from the main Codex profile.");
        }
      }
    }
  }

  function inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome = defaultMainCodexHome()) {
    const authPath = path.join(watcherHome, "auth.json");
    const configPath = path.join(watcherHome, "config.toml");
    const modelsCachePath = path.join(watcherHome, "models_cache.json");
    const mainAuthPath = path.join(mainCodexHome, "auth.json");
    const mainModelsCachePath = path.join(mainCodexHome, "models_cache.json");
    const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const model = parseTomlBasicString(configText, "model");
    const modelReasoningEffort = parseTomlBasicString(configText, "model_reasoning_effort");
    const authExists = fs.existsSync(authPath);
    const mainAuthExists = fs.existsSync(mainAuthPath);
    const modelsCacheExists = fs.existsSync(modelsCachePath);
    const mainModelsCacheExists = fs.existsSync(mainModelsCachePath);
    const signals = [];

    if (!authExists) {
      signals.push("This watcher home does not have auth.json yet.");
      if (mainAuthExists) {
        signals.push("Your main ~/.codex profile is already logged in, so you can seed this watcher home locally or open a dedicated login terminal.");
      } else {
        signals.push("Open Login Terminal to create login state inside this CODEX_HOME.");
      }
    }
    if (!model) {
      signals.push("This watcher home does not declare a model in config.toml yet.");
    }
    if (authExists && !modelsCacheExists && mainModelsCacheExists) {
      signals.push("models_cache.json is still missing here; a local seed from ~/.codex can warm it up.");
    }

    return {
      watcherHome,
      authPath,
      configPath,
      modelsCachePath,
      model,
      modelReasoningEffort,
      authExists,
      configExists: fs.existsSync(configPath),
      modelsCacheExists,
      mainCodexHome,
      mainAuthPath,
      mainModelsCachePath,
      mainAuthExists,
      mainModelsCacheExists,
      canSeedFromMainAuth: mainAuthExists && (!authExists || !modelsCacheExists),
      bootstrapText: signals.join("\n")
    };
  }

  function inspectWatcherHomeBootstrap(root) {
    return inspectWatcherHomeBootstrapState(codexHomeSetting(root));
  }

  async function seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome = defaultMainCodexHome()) {
    await ensureDir(watcherHome);
    const copied = [];
    for (const fileName of ["auth.json", "models_cache.json"]) {
      const source = path.join(mainCodexHome, fileName);
      if (!fs.existsSync(source)) {
        continue;
      }
      const target = path.join(watcherHome, fileName);
      await fsp.copyFile(source, target);
      copied.push(fileName);
    }
    return {
      watcherHome,
      mainCodexHome,
      copied,
      copiedAuth: copied.includes("auth.json"),
      copiedModelsCache: copied.includes("models_cache.json")
    };
  }

  async function seedWatcherHomeAuthFromMainProfile(root) {
    return seedWatcherHomeBootstrapFromProfilePaths(codexHomeSetting(root));
  }

  return {
    ensureCodexHome,
    inspectWatcherHomeBootstrapState,
    inspectWatcherHomeBootstrap,
    seedWatcherHomeBootstrapFromProfilePaths,
    seedWatcherHomeAuthFromMainProfile
  };
}

module.exports = {
  createRuntimeWatcherHomeBootstrapHelpers
};
