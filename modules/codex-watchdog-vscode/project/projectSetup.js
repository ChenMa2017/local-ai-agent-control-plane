"use strict";

const fs = require("fs");
const { createProjectInstantiationHelpers } = require("./projectInstantiation");

function createProjectSetupHelpers({
  vscode,
  ensureDir,
  bootstrapProject,
  showBootstrapResult,
  refreshGeneratedWatcherFiles,
  bootstrapResultSchemaPath,
  bootstrapConversationTurnSchemaPath,
  openDocument
}) {
  const projectInstantiationHelpers = createProjectInstantiationHelpers({
    vscode,
    fs,
    path: require("path"),
    openDocument
  });

  async function prepareProjectForGuard(root) {
    await prepareProjectForInstantiation(root);
  }

  async function prepareProjectForInstantiation(root) {
    await ensureDir(root);
    const result = await bootstrapProject(root);
    if (result.created.length) {
      showBootstrapResult(result);
    }
    await refreshGeneratedWatcherFiles(root);
  }

  async function ensureBootstrapConversationReady(root) {
    await ensureDir(root);
    const result = await bootstrapProject(root);
    if (result.created.length) {
      showBootstrapResult(result);
    }
    if (!fs.existsSync(bootstrapResultSchemaPath(root)) || !fs.existsSync(bootstrapConversationTurnSchemaPath(root))) {
      await refreshGeneratedWatcherFiles(root);
    }
  }

  async function openInstantiationFiles(root) {
    return projectInstantiationHelpers.openInstantiationFiles(root);
  }

  async function confirmTaskInstantiatedIfNeeded(root) {
    return projectInstantiationHelpers.confirmTaskInstantiatedIfNeeded(root);
  }

  function taskLooksInstantiated(root) {
    return projectInstantiationHelpers.taskLooksInstantiated(root);
  }

  return {
    prepareProjectForGuard,
    prepareProjectForInstantiation,
    ensureBootstrapConversationReady,
    openInstantiationFiles,
    confirmTaskInstantiatedIfNeeded,
    taskLooksInstantiated
  };
}

module.exports = {
  createProjectSetupHelpers
};
