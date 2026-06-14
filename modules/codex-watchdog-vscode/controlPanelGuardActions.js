"use strict";

function createControlPanelGuardActions({
  getGuardCommands,
  openMorningBriefCommand,
  refreshGeneratedFilesCommand
}) {
  return {
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
  createControlPanelGuardActions
};
