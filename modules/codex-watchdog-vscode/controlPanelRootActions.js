"use strict";

function createControlPanelRootActions({
  vscode,
  getProjectRoot,
  selectProjectRoot,
  rememberProjectRoot,
  showProjectRootSelected,
  browseExistingProjectRoot,
  normalizeProjectRootInput,
  clearRememberedProjectRoot,
  updateProjectSetting,
  readWatcherUnitDrift,
  effectiveWatchdogSettings,
  openLoginTerminal
}) {
  return {
    chooseRoot: async () => {
      const root = await selectProjectRoot("Enter the project folder Codex Watchdog should control");
      if (!root) {
        return;
      }
      await rememberProjectRoot(root);
      await showProjectRootSelected(root);
    },

    browseRoot: async (message) => {
      const root = await browseExistingProjectRoot("Browse for an existing project folder", message.root);
      if (!root) {
        return;
      }
      await rememberProjectRoot(root);
      await showProjectRootSelected(root);
    },

    saveRoot: async (message) => {
      const root = await normalizeProjectRootInput(message.root, "Project root", { offerCreate: true, confirmCreate: false });
      if (!root) {
        return;
      }
      await rememberProjectRoot(root);
      await showProjectRootSelected(root);
    },

    clearRoot: async () => {
      await clearRememberedProjectRoot();
    },

    saveInterval: async (message) => {
      const root = await getProjectRoot();
      if (!root) {
        return;
      }
      const interval = Number(message.intervalMinutes);
      if (!Number.isInteger(interval) || interval < 5) {
        throw new Error("Interval must be a whole number >= 5 minutes.");
      }
      const compactEveryRuns = Number(message.compactEveryRuns);
      if (!Number.isInteger(compactEveryRuns) || compactEveryRuns < 0) {
        throw new Error("Compaction cadence must be a whole number >= 0 runs.");
      }

      await updateProjectSetting(root, "codexWatchdog.intervalMinutes", interval);
      await updateProjectSetting(root, "codexWatchdog.compactEveryRuns", compactEveryRuns);

      const drift = readWatcherUnitDrift(root, await effectiveWatchdogSettings(root));
      vscode.window.showInformationMessage(
        drift.needsReinstall
          ? `Codex Watchdog schedule saved: ${interval} minutes; compact every ${compactEveryRuns} runs. Reinstall the timer so systemd uses the new schedule.`
          : `Codex Watchdog schedule saved: ${interval} minutes; compact every ${compactEveryRuns} runs`
      );
    },

    refresh: async () => {},

    login: async () => {
      await openLoginTerminal();
    }
  };
}

module.exports = {
  createControlPanelRootActions
};
