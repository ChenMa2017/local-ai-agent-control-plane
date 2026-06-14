"use strict";

function createRuntimeWatcherHomeHelpers({
  vscode,
  fs,
  fsp,
  path,
  os,
  output,
  loginReadyRe,
  resolveCodexBin,
  codexHomeSetting,
  codexHomePlan,
  updateProjectSetting,
  watcherProfileModelDefaults,
  mergeWatcherConfigText,
  hasTomlAssignment,
  parseTomlBasicString,
  run,
  ensureDir,
  getProjectRoot,
  shellQuote
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

  async function getCodexLoginStatus(root) {
    try {
      const codexBin = await resolveCodexBin(root);
      const codexHome = codexHomeSetting(root);
      const bootstrap = inspectWatcherHomeBootstrapState(codexHome);
      const result = await run(codexBin, ["login", "status"], {
        cwd: root,
        env: { CODEX_HOME: codexHome },
        allowFailure: true,
        timeout: 10000
      });
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const statusText = combined || (result.error ? result.error.message : "");
      const spawnMissing = result.error && (result.error.code === "ENOENT" || /ENOENT/.test(statusText));
      const ok = !result.error && loginReadyRe.test(statusText);

      if (ok) {
        return {
          ok: true,
          bootstrapText: bootstrap.bootstrapText,
          canSeedFromMainAuth: bootstrap.canSeedFromMainAuth,
          text: [
            statusText,
            "",
            `Watcher auth: ${bootstrap.authExists ? "present" : "missing"}`,
            `Watcher model: ${bootstrap.model || "not set"}`,
            bootstrap.modelReasoningEffort ? `Reasoning effort: ${bootstrap.modelReasoningEffort}` : "",
            `CODEX_HOME=${codexHome}`,
            `CODEX_BIN=${codexBin}`
          ].filter(Boolean).join("\n")
        };
      }

      return {
        ok: false,
        bootstrapText: bootstrap.bootstrapText,
        canSeedFromMainAuth: bootstrap.canSeedFromMainAuth,
        text: [
          spawnMissing
            ? "Codex CLI executable was not found for watchdog mode."
            : "Codex login is not ready for watchdog mode.",
          statusText || "No login status output was returned.",
          "",
          `Watcher auth: ${bootstrap.authExists ? "present" : "missing"}`,
          `Watcher model: ${bootstrap.model || "not set"}`,
          bootstrap.modelReasoningEffort ? `Reasoning effort: ${bootstrap.modelReasoningEffort}` : "",
          `CODEX_HOME=${codexHome}`,
          `CODEX_BIN=${codexBin}`
        ].filter(Boolean).join("\n")
      };
    } catch (error) {
      return {
        ok: false,
        text: `Could not check Codex login status: ${error.message || String(error)}`,
        bootstrapText: "",
        canSeedFromMainAuth: false
      };
    }
  }

  async function confirmLoginIfNeeded(root) {
    const login = await getCodexLoginStatus(root);
    if (login.ok) {
      return true;
    }

    const answer = await vscode.window.showWarningMessage(
      [
        login.text.includes("executable was not found")
          ? "Codex Watchdog could not find a Codex CLI executable."
          : "Codex Watchdog needs an OpenAI login before it can start unattended work.",
        "",
        ...(login.bootstrapText ? [login.bootstrapText, ""] : []),
        login.text,
        "",
        login.text.includes("executable was not found")
          ? "The project files and watchdog scripts are ready. Fix codexWatchdog.codexBin or install/enable the OpenAI Codex CLI, then run Start Guard again."
          : "The project files and watchdog scripts are ready. Complete login in the terminal, then run Start Guard again."
      ].join("\n"),
      { modal: true },
      ...(login.canSeedFromMainAuth ? ["Seed from Main Profile"] : []),
      "Open Login Terminal"
    );

    if (answer === "Seed from Main Profile") {
      const seeded = await seedWatcherHomeAuthFromMainProfile(root);
      if (!seeded.copiedAuth) {
        vscode.window.showWarningMessage("No ~/.codex/auth.json was found to seed this watcher home. Open Login Terminal instead.");
      } else {
        output.appendLine(`Seeded watcher auth bootstrap from ${seeded.mainCodexHome} into ${seeded.watcherHome}`);
        const recheck = await getCodexLoginStatus(root);
        if (recheck.ok) {
          vscode.window.showInformationMessage("Seeded watcher auth from the main Codex profile. Start Guard can continue now.");
          return true;
        }
        vscode.window.showWarningMessage("Seeded local watcher files, but this watcher home still needs a fresh login.");
      }
    }

    if (answer === "Open Login Terminal") {
      await openLoginTerminal(root);
      vscode.window.showInformationMessage("After OpenAI login finishes, click Codex Watchdog: Start Guard again.");
    }

    return false;
  }

  async function openLoginTerminal(rootArg) {
    const root = rootArg || await getProjectRoot();
    if (!root) {
      return;
    }
    await ensureCodexHome(root);
    const codexBin = await resolveCodexBin(root);
    const codexHome = codexHomeSetting(root);
    const terminal = vscode.window.createTerminal({
      name: "Codex Watchdog Login",
      cwd: root,
      env: {
        CODEX_BIN: codexBin,
        CODEX_HOME: codexHome,
        CUDA_VISIBLE_DEVICES: ""
      }
    });
    terminal.show();
    const projectCli = path.join(root, "agent", "bin", "watchdog");
    if (fs.existsSync(projectCli)) {
      terminal.sendText("./agent/bin/watchdog login; echo; ./agent/bin/watchdog status");
    } else {
      terminal.sendText(`CODEX_HOME=${shellQuote(codexHome)} ${shellQuote(codexBin)} login; echo; CODEX_HOME=${shellQuote(codexHome)} ${shellQuote(codexBin)} login status`);
    }
  }

  return {
    ensureCodexHome,
    inspectWatcherHomeBootstrapState,
    inspectWatcherHomeBootstrap,
    seedWatcherHomeBootstrapFromProfilePaths,
    seedWatcherHomeAuthFromMainProfile,
    getCodexLoginStatus,
    confirmLoginIfNeeded,
    openLoginTerminal
  };
}

module.exports = {
  createRuntimeWatcherHomeHelpers
};
