"use strict";

function createGuardControlFlow({
  fs,
  fsp,
  path,
  vscode,
  output,
  ensureDir,
  runLogged,
  watchdogCommandEnv,
  updateStatusBar,
  unitNames,
  getTimerStatus,
  openDocument
}) {
  async function pauseGuard(root) {
    await ensureDir(path.join(root, "agent", "control"));
    const pauseFile = path.join(root, "agent", "control", "PAUSE");
    await fsp.writeFile(pauseFile, [
      `Paused at: ${new Date().toISOString()}`,
      "Reason: paused from VSCode control panel",
      ""
    ].join("\n"));
    vscode.window.showInformationMessage("Codex Watchdog guard paused. Timer may still fire, but run_watchdog.sh will not call Codex while PAUSE exists.");
    await updateStatusBar();
  }

  async function resumeGuard(root) {
    const pauseFile = path.join(root, "agent", "control", "PAUSE");
    if (fs.existsSync(pauseFile)) {
      await fsp.unlink(pauseFile);
    }
    vscode.window.showInformationMessage("Codex Watchdog guard resumed.");
    await updateStatusBar();
  }

  async function stopGuard(root) {
    const cli = path.join(root, "agent", "bin", "watchdog");
    if (fs.existsSync(cli)) {
      output.show(true);
      output.appendLine(`\n# ${new Date().toISOString()} Stop Guard`);
      output.appendLine(`Project root: ${root}`);
      const result = await runLogged(cli, ["stop"], {
        cwd: root,
        env: await watchdogCommandEnv(root),
        allowFailure: true,
        timeout: 60000
      });
      await showStopOutcome(root, result, "guard");
      await updateStatusBar();
      return;
    }

    await stopTimer(root);
  }

  async function stopTimer(root) {
    const units = unitNames(root);
    const result = await runLogged("systemctl", ["--user", "disable", "--now", units.timer], { allowFailure: true });
    await showStopOutcome(root, result, "timer");
    await updateStatusBar();
  }

  async function showStopOutcome(root, result, label) {
    const timer = await getTimerStatus(root);
    if (result && result.error) {
      vscode.window.showWarningMessage(`Codex Watchdog ${label} stop command reported an error. Check the Codex Watchdog output channel.`);
      return;
    }
    if (timer.isActive || timer.isEnabled) {
      vscode.window.showWarningMessage(`Codex Watchdog ${label} may still be active or enabled. Check timer status in the output channel.`);
      output.show(true);
      output.appendLine(timer.text);
      return;
    }
    vscode.window.showInformationMessage(`Codex Watchdog ${label} stopped.`);
  }

  async function showTimerStatus(root) {
    const units = unitNames(root);
    output.show(true);
    output.appendLine(`\n# ${new Date().toISOString()} ${units.timer}`);
    await runLogged("systemctl", ["--user", "status", units.timer, "--no-pager"], { allowFailure: true });
    await runLogged("systemctl", ["--user", "list-timers", units.timer, "--no-pager"], { allowFailure: true });
  }

  async function openLatestReport(root) {
    const latest = path.join(root, "agent", "reports", "latest.md");
    if (!fs.existsSync(latest)) {
      vscode.window.showWarningMessage("No latest report exists yet. Run Codex Watchdog once first.");
      return;
    }
    await openDocument(latest, false);
  }

  return {
    pauseGuard,
    resumeGuard,
    stopGuard,
    stopTimer,
    showTimerStatus,
    openLatestReport
  };
}

module.exports = {
  createGuardControlFlow
};
