"use strict";

function registerWatchdogCommand({ context, vscode, output, updateStatusBar }, command, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    try {
      await handler();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      output.appendLine(`[error] ${message}`);
      vscode.window.showErrorMessage(`Codex Watchdog: ${message}`);
    } finally {
      await updateStatusBar();
    }
  }));
}

function activateWatchdogServices({
  registerCommand,
  initializeStatusBar,
  openControlPanelCommand,
  projectCommands,
  guardCommands
}) {
  registerCommand("codexWatchdog.openControlPanel", openControlPanelCommand);
  registerCommand("codexWatchdog.selectProjectRoot", projectCommands.selectProjectRootCommand);
  registerCommand("codexWatchdog.bootstrapProject", projectCommands.bootstrapProjectCommand);
  registerCommand("codexWatchdog.createDemoProjectTemplate", projectCommands.createDemoProjectTemplateCommand);
  registerCommand("codexWatchdog.prepareProject", projectCommands.prepareProjectCommand);
  registerCommand("codexWatchdog.refreshGeneratedFiles", projectCommands.refreshGeneratedFilesCommand);
  registerCommand("codexWatchdog.prepareEveningHandoff", projectCommands.prepareEveningHandoffCommand);
  registerCommand("codexWatchdog.openMorningBrief", projectCommands.openMorningBriefCommand);
  registerCommand("codexWatchdog.startGuard", guardCommands.startGuardCommand);
  registerCommand("codexWatchdog.pauseGuard", guardCommands.pauseGuardCommand);
  registerCommand("codexWatchdog.resumeGuard", guardCommands.resumeGuardCommand);
  registerCommand("codexWatchdog.stopGuard", guardCommands.stopGuardCommand);
  registerCommand("codexWatchdog.runOnce", guardCommands.runOnceCommand);
  registerCommand("codexWatchdog.startTimer", guardCommands.startTimerCommand);
  registerCommand("codexWatchdog.stopTimer", guardCommands.stopTimerCommand);
  registerCommand("codexWatchdog.showTimerStatus", guardCommands.showTimerStatusCommand);
  registerCommand("codexWatchdog.openLatestReport", guardCommands.openLatestReportCommand);
  registerCommand("codexWatchdog.acceptStateUpdate", projectCommands.acceptStateUpdateCommand);

  initializeStatusBar();
}

module.exports = {
  activateWatchdogServices,
  registerWatchdogCommand
};
