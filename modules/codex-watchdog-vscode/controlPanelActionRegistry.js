"use strict";

function createControlPanelActionRegistry({
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
  openLoginTerminal,
  prepareProjectCommand,
  generateBootstrapConversationCommand,
  getBootstrapWorkflowHelpers,
  getProjectSetupHelpers,
  archiveAndResetBootstrapConversation,
  getGuardCommands,
  openMorningBriefCommand,
  refreshGeneratedFilesCommand
}) {
  async function withProjectRoot(run) {
    const root = await getProjectRoot();
    if (root) {
      await run(root);
    }
  }

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
    },

    prepareProject: async () => {
      await prepareProjectCommand();
    },

    generateBootstrap: async (message) => {
      await generateBootstrapConversationCommand(message.text);
    },

    instantiateBootstrapProject: async () => {
      await withProjectRoot(async (root) => {
        await getBootstrapWorkflowHelpers().instantiateBootstrapProjectCommand(root);
      });
    },

    openSetupFiles: async () => {
      await withProjectRoot(async (root) => {
        await getProjectSetupHelpers().openInstantiationFiles(root);
      });
    },

    openBootstrapTranscript: async () => {
      await withProjectRoot(async (root) => {
        await getBootstrapWorkflowHelpers().openBootstrapTranscriptCommand(root);
      });
    },

    openBootstrapPreview: async () => {
      await withProjectRoot(async (root) => {
        await getBootstrapWorkflowHelpers().openBootstrapChangePreviewCommand(root);
      });
    },

    resetBootstrapConversation: async () => {
      await withProjectRoot(async (root) => {
        const answer = await vscode.window.showWarningMessage(
          "Reset the bootstrap conversation? Current transcript and last draft artifacts will be archived under agent/status/bootstrap_archive/ before the panel is cleared.",
          { modal: true },
          "Reset Conversation"
        );
        if (answer !== "Reset Conversation") {
          return;
        }
        await archiveAndResetBootstrapConversation(root);
        vscode.window.showInformationMessage("Bootstrap conversation reset. Previous transcript and draft artifacts were archived under agent/status/bootstrap_archive/.");
      });
    },

    runOnce: async () => {
      await getGuardCommands().runOnceCommand();
    },

    startGuard: async () => {
      await getGuardCommands().startGuardCommand();
    },

    pauseGuard: async () => {
      await getGuardCommands().pauseGuardCommand();
    },

    resumeGuard: async () => {
      await getGuardCommands().resumeGuardCommand();
    },

    stopGuard: async () => {
      await getGuardCommands().stopGuardCommand();
    },

    startTimer: async () => {
      await getGuardCommands().startTimerCommand();
    },

    stopTimer: async () => {
      await getGuardCommands().stopTimerCommand();
    },

    openLatest: async () => {
      await getGuardCommands().openLatestReportCommand();
    },

    openMorning: async () => {
      await openMorningBriefCommand();
    },

    refreshGenerated: async () => {
      await refreshGeneratedFilesCommand();
    }
  };
}

module.exports = {
  createControlPanelActionRegistry
};
