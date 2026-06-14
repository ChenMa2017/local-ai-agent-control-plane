"use strict";

const { createServiceProjectHelperAccessors } = require("./serviceProjectHelperAccessors");
const { createServiceProjectCommandAccessors } = require("./serviceProjectCommandAccessors");
const {
  buildHelperAccessorsArgs,
  buildCommandAccessorsArgs
} = require("./serviceProjectFactoryArgBuilders");

function createServiceProjectFactory({
  createProjectSetupHelpers,
  createBootstrapWorkflowHelpers,
  createGeneratedFilesHelpers,
  createBootstrapScaffoldingHelpers,
  createProjectCommands,
  createGuardLifecycle,
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
  extensionSetting,
  defaultTimeoutMinutes,
  isWatchdogInitialized,
  isEffectivelyEmptyDir,
  runLogged,
  unitNames,
  getControlPanelController
}) {
  let commandAccessors;
  const helperAccessors = createServiceProjectHelperAccessors(buildHelperAccessorsArgs({
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
    getProjectCommands: () => commandAccessors.getProjectCommands()
  }));
  commandAccessors = createServiceProjectCommandAccessors(buildCommandAccessorsArgs({
    createProjectCommands,
    createGuardLifecycle,
    vscode,
    fs,
    fsp,
    path,
    ensureDir,
    getOutput,
    openDocument,
    getRuntimeConfigHelpers,
    bridges,
    writeBootstrapRuntimeState,
    emptyBootstrapRuntimeState,
    extensionSetting,
    defaultTimeoutMinutes,
    runLogged,
    unitNames,
    getControlPanelController,
    getProjectSetupHelpers: helperAccessors.getProjectSetupHelpers,
    getBootstrapWorkflowHelpers: helperAccessors.getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers: helperAccessors.getGeneratedFilesHelpers,
    getBootstrapScaffoldingHelpers: helperAccessors.getBootstrapScaffoldingHelpers
  }));

  return {
    getProjectSetupHelpers: helperAccessors.getProjectSetupHelpers,
    getBootstrapWorkflowHelpers: helperAccessors.getBootstrapWorkflowHelpers,
    getGeneratedFilesHelpers: helperAccessors.getGeneratedFilesHelpers,
    getBootstrapScaffoldingHelpers: helperAccessors.getBootstrapScaffoldingHelpers,
    getProjectCommands: commandAccessors.getProjectCommands,
    getGuardCommands: commandAccessors.getGuardCommands
  };
}

module.exports = {
  createServiceProjectFactory
};
