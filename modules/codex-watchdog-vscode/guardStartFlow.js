"use strict";

function createGuardStartFlow({
  vscode,
  output,
  prepareProjectForGuard,
  confirmTaskInstantiatedIfNeeded,
  ensureCodexHome,
  confirmLoginIfNeeded,
  runLogged,
  watchdogCommandEnv,
  watchdogCommandTimeoutMs,
  setPanelOperationState,
  clearPanelOperationState,
  updateStatusBar,
  path
}) {
  async function runGuardStartFlow({
    root,
    progressTitle,
    prepareMessage,
    prepareDetail,
    codexHomeMessage,
    codexHomeDetail,
    startMessage,
    startDetail,
    logHeading,
    successMessage
  }) {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: false
    }, async (progress) => {
      const startedAt = new Date().toISOString();
      try {
        progress.report({ message: prepareMessage });
        await setPanelOperationState({
          title: progressTitle,
          detail: prepareDetail,
          startedAt
        });
        await prepareProjectForGuard(root);
        const taskReady = await confirmTaskInstantiatedIfNeeded(root);
        if (!taskReady) {
          return;
        }

        progress.report({ message: codexHomeMessage });
        await setPanelOperationState({
          title: progressTitle,
          detail: codexHomeDetail,
          startedAt
        });
        await ensureCodexHome(root);
        const canContinue = await confirmLoginIfNeeded(root);
        if (!canContinue) {
          return;
        }

        progress.report({ message: startMessage });
        await setPanelOperationState({
          title: progressTitle,
          detail: startDetail,
          startedAt
        });
        output.show(true);
        output.appendLine(`\n# ${new Date().toISOString()} ${logHeading}`);
        output.appendLine(`Project root: ${root}`);
        await runLogged(path.join(root, "agent", "bin", "watchdog"), ["start"], {
          cwd: root,
          env: await watchdogCommandEnv(root),
          timeout: watchdogCommandTimeoutMs(root)
        });

        vscode.window.showInformationMessage(successMessage);
        await updateStatusBar();
      } finally {
        await clearPanelOperationState();
      }
    });
  }

  return {
    runGuardStartFlow
  };
}

module.exports = {
  createGuardStartFlow
};
