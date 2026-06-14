"use strict";

function createProjectFlowOperationRunner({
  vscode,
  setPanelOperationState,
  clearPanelOperationState
}) {
  async function runProgressOperation({
    notificationTitle,
    panelTitle,
    initialDetail,
    run
  }) {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: notificationTitle,
      cancellable: false
    }, async () => {
      const startedAt = new Date().toISOString();
      try {
        await setPanelOperationState({
          title: panelTitle,
          detail: initialDetail,
          startedAt
        });
        await run({
          startedAt,
          updateDetail: async (detail) => setPanelOperationState({
            title: panelTitle,
            detail,
            startedAt
          })
        });
      } finally {
        await clearPanelOperationState();
      }
    });
  }

  async function runPanelOperation({
    panelTitle,
    initialDetail,
    run
  }) {
    const startedAt = new Date().toISOString();
    try {
      await setPanelOperationState({
        title: panelTitle,
        detail: initialDetail,
        startedAt
      });
      await run({
        startedAt,
        updateDetail: async (detail) => setPanelOperationState({
          title: panelTitle,
          detail,
          startedAt
        })
      });
    } finally {
      await clearPanelOperationState();
    }
  }

  return {
    runProgressOperation,
    runPanelOperation
  };
}

module.exports = {
  createProjectFlowOperationRunner
};
