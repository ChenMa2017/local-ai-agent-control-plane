"use strict";

function createRuntimeWatcherHomeLoginHelpers({
  vscode,
  fs,
  path,
  output,
  loginReadyRe,
  resolveCodexBin,
  codexHomeSetting,
  run,
  getProjectRoot,
  shellQuote,
  ensureCodexHome,
  inspectWatcherHomeBootstrapState,
  seedWatcherHomeAuthFromMainProfile
}) {
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
    getCodexLoginStatus,
    confirmLoginIfNeeded,
    openLoginTerminal
  };
}

module.exports = {
  createRuntimeWatcherHomeLoginHelpers
};
