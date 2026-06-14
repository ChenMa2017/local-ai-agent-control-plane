"use strict";

const fs = require("fs");

function createBootstrapTranscriptCommands({
  vscode,
  openDocument,
  bootstrapConversationMarkdownPath
}) {
  async function openBootstrapTranscriptCommand(root) {
    const file = bootstrapConversationMarkdownPath(root);
    if (!fs.existsSync(file)) {
      vscode.window.showWarningMessage("No bootstrap conversation transcript exists yet. Generate drafts first.");
      return;
    }
    await openDocument(file, false);
  }

  return {
    openBootstrapTranscriptCommand
  };
}

module.exports = {
  createBootstrapTranscriptCommands
};
