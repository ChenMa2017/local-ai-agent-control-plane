"use strict";

function createControlPanelBootstrapActions({
  vscode,
  withProjectRoot,
  prepareProjectCommand,
  generateBootstrapConversationCommand,
  getBootstrapWorkflowHelpers,
  getProjectSetupHelpers,
  archiveAndResetBootstrapConversation
}) {
  return {
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
    }
  };
}

module.exports = {
  createControlPanelBootstrapActions
};
