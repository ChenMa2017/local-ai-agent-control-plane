"use strict";

const {
  buildProjectSetupHelperArgs,
  buildBootstrapWorkflowHelperArgs,
  buildGeneratedFilesHelperArgs,
  buildBootstrapScaffoldingHelperArgs
} = require("./serviceProjectHelperArgBuilders");

function createServiceProjectHelperAccessors({
  createProjectSetupHelpers,
  createBootstrapWorkflowHelpers,
  createGeneratedFilesHelpers,
  createBootstrapScaffoldingHelpers,
  vscode,
  fs,
  fsp,
  path,
  crypto,
  packageVersion,
  templates,
  ensureDir,
  getOutput,
  openDocument,
  getRuntimeConfigHelpers,
  bridges,
  bootstrapConversationTurnSchemaPath,
  bootstrapResultSchemaPath,
  bootstrapLastResultPath,
  bootstrapConversationPromptText,
  bootstrapInstantiationPromptText,
  bootstrapConversationMarkdownPath,
  bootstrapChangePreviewPath,
  readBootstrapConversation,
  writeBootstrapConversation,
  clearBootstrapDraftArtifacts,
  runLoggedWithInput,
  createNonce,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  writeBootstrapRuntimeState,
  emptyBootstrapRuntimeState,
  isWatchdogInitialized,
  isEffectivelyEmptyDir,
  getProjectCommands
}) {
  let projectSetupHelpers;
  let bootstrapWorkflowHelpers;
  let generatedFilesHelpers;
  let bootstrapScaffoldingHelpers;

  function getProjectSetupHelpers() {
    if (!projectSetupHelpers) {
      projectSetupHelpers = createProjectSetupHelpers(buildProjectSetupHelperArgs({
        vscode,
        ensureDir,
        bridges,
        getGeneratedFilesHelpers,
        bootstrapResultSchemaPath,
        bootstrapConversationTurnSchemaPath,
        openDocument
      }));
    }
    return projectSetupHelpers;
  }

  function getBootstrapWorkflowHelpers() {
    if (!bootstrapWorkflowHelpers) {
      const runtimeConfig = getRuntimeConfigHelpers();
      bootstrapWorkflowHelpers = createBootstrapWorkflowHelpers(buildBootstrapWorkflowHelperArgs({
        vscode,
        getProjectSetupHelpers,
        bridges,
        runtimeConfig,
        readBootstrapConversation,
        writeBootstrapConversation,
        clearBootstrapDraftArtifacts,
        bootstrapLastResultPath,
        bootstrapConversationPromptText,
        bootstrapConversationTurnSchemaPath,
        runLoggedWithInput,
        getProjectCommands,
        createNonce,
        bootstrapInstantiationPromptText,
        bootstrapResultSchemaPath,
        stageBootstrapDraftFiles,
        applyBootstrapDraftFiles,
        openDocument,
        bootstrapConversationMarkdownPath,
        bootstrapChangePreviewPath,
        writeBootstrapRuntimeState,
        emptyBootstrapRuntimeState
      }));
    }
    return bootstrapWorkflowHelpers;
  }

  function getGeneratedFilesHelpers() {
    if (!generatedFilesHelpers) {
      generatedFilesHelpers = createGeneratedFilesHelpers(buildGeneratedFilesHelperArgs({
        fs,
        fsp,
        path,
        crypto,
        packageVersion,
        templates,
        ensureDir,
        getOutput,
        bridges
      }));
    }
    return generatedFilesHelpers;
  }

  function getBootstrapScaffoldingHelpers() {
    if (!bootstrapScaffoldingHelpers) {
      bootstrapScaffoldingHelpers = createBootstrapScaffoldingHelpers(buildBootstrapScaffoldingHelperArgs({
        fs,
        fsp,
        path,
        vscode,
        templates,
        getOutput,
        ensureDir,
        getGeneratedFilesHelpers,
        getProjectSetupHelpers,
        isWatchdogInitialized,
        isEffectivelyEmptyDir
      }));
    }
    return bootstrapScaffoldingHelpers;
  }

  return {
    getProjectSetupHelpers,
    getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers,
    getBootstrapScaffoldingHelpers
  };
}

module.exports = {
  createServiceProjectHelperAccessors
};
