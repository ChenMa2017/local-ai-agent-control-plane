"use strict";

function createControlPanelActionHandler({
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
  updateControlPanel,
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
  return async function handleControlPanelMessage(message) {
    const command = message && message.command;
    const bootstrapWorkflowHelpers = getBootstrapWorkflowHelpers();
    const projectSetupHelpers = getProjectSetupHelpers();
    const guardCommands = getGuardCommands();

    if (command === "chooseRoot") {
      const root = await selectProjectRoot("Enter the project folder Codex Watchdog should control");
      if (root) {
        await rememberProjectRoot(root);
        await showProjectRootSelected(root);
      }
      await updateControlPanel();
      return;
    }

    if (command === "browseRoot") {
      const root = await browseExistingProjectRoot("Browse for an existing project folder", message.root);
      if (root) {
        await rememberProjectRoot(root);
        await showProjectRootSelected(root);
      }
      await updateControlPanel();
      return;
    }

    if (command === "saveRoot") {
      const root = await normalizeProjectRootInput(message.root, "Project root", { offerCreate: true, confirmCreate: false });
      if (!root) {
        await updateControlPanel();
        return;
      }
      await rememberProjectRoot(root);
      await showProjectRootSelected(root);
      await updateControlPanel();
      return;
    }

    if (command === "clearRoot") {
      await clearRememberedProjectRoot();
      await updateControlPanel();
      return;
    }

    if (command === "saveInterval") {
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
      await updateControlPanel();
      return;
    }

    if (command === "refresh") {
      await updateControlPanel();
      return;
    }

    if (command === "login") {
      await openLoginTerminal();
      await updateControlPanel();
      return;
    }

    if (command === "prepareProject") {
      await prepareProjectCommand();
      await updateControlPanel();
      return;
    }

    if (command === "generateBootstrap") {
      await generateBootstrapConversationCommand(message.text);
      await updateControlPanel();
      return;
    }

    if (command === "instantiateBootstrapProject") {
      const root = await getProjectRoot();
      if (root) {
        await bootstrapWorkflowHelpers.instantiateBootstrapProjectCommand(root);
      }
      await updateControlPanel();
      return;
    }

    if (command === "openSetupFiles") {
      const root = await getProjectRoot();
      if (root) {
        await projectSetupHelpers.openInstantiationFiles(root);
      }
      await updateControlPanel();
      return;
    }

    if (command === "openBootstrapTranscript") {
      const root = await getProjectRoot();
      if (root) {
        await bootstrapWorkflowHelpers.openBootstrapTranscriptCommand(root);
      }
      await updateControlPanel();
      return;
    }

    if (command === "openBootstrapPreview") {
      const root = await getProjectRoot();
      if (root) {
        await bootstrapWorkflowHelpers.openBootstrapChangePreviewCommand(root);
      }
      await updateControlPanel();
      return;
    }

    if (command === "resetBootstrapConversation") {
      const root = await getProjectRoot();
      if (root) {
        const answer = await vscode.window.showWarningMessage(
          "Reset the bootstrap conversation? Current transcript and last draft artifacts will be archived under agent/status/bootstrap_archive/ before the panel is cleared.",
          { modal: true },
          "Reset Conversation"
        );
        if (answer === "Reset Conversation") {
          await archiveAndResetBootstrapConversation(root);
          vscode.window.showInformationMessage("Bootstrap conversation reset. Previous transcript and draft artifacts were archived under agent/status/bootstrap_archive/.");
        }
      }
      await updateControlPanel();
      return;
    }

    if (command === "runOnce") {
      await guardCommands.runOnceCommand();
      await updateControlPanel();
      return;
    }

    if (command === "startGuard") {
      await guardCommands.startGuardCommand();
      await updateControlPanel();
      return;
    }

    if (command === "pauseGuard") {
      await guardCommands.pauseGuardCommand();
      await updateControlPanel();
      return;
    }

    if (command === "resumeGuard") {
      await guardCommands.resumeGuardCommand();
      await updateControlPanel();
      return;
    }

    if (command === "stopGuard") {
      await guardCommands.stopGuardCommand();
      await updateControlPanel();
      return;
    }

    if (command === "startTimer") {
      await guardCommands.startTimerCommand();
      await updateControlPanel();
      return;
    }

    if (command === "stopTimer") {
      await guardCommands.stopTimerCommand();
      await updateControlPanel();
      return;
    }

    if (command === "openLatest") {
      await guardCommands.openLatestReportCommand();
      await updateControlPanel();
      return;
    }

    if (command === "openMorning") {
      await openMorningBriefCommand();
      await updateControlPanel();
      return;
    }

    if (command === "refreshGenerated") {
      await refreshGeneratedFilesCommand();
      await updateControlPanel();
    }
  };
}

module.exports = {
  createControlPanelActionHandler
};
