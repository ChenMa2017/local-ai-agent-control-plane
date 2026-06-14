"use strict";

function createProjectFlowCommands({
  getProjectRoot,
  projectCommandFlows
}) {
  async function withProjectRoot(run) {
    const root = await getProjectRoot();
    if (!root) {
      return;
    }
    await run(root);
  }

  async function prepareProjectCommand() {
    await withProjectRoot((root) => projectCommandFlows.prepareProject(root));
  }

  async function generateBootstrapConversationCommand(rawText) {
    await withProjectRoot((root) => projectCommandFlows.generateBootstrapConversation(root, rawText));
  }

  async function refreshGeneratedFilesCommand() {
    await withProjectRoot((root) => projectCommandFlows.refreshGeneratedFiles(root));
  }

  async function prepareEveningHandoffCommand() {
    await withProjectRoot((root) => projectCommandFlows.prepareEveningHandoff(root));
  }

  return {
    prepareProjectCommand,
    generateBootstrapConversationCommand,
    refreshGeneratedFilesCommand,
    prepareEveningHandoffCommand
  };
}

module.exports = {
  createProjectFlowCommands
};
