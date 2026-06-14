"use strict";

function createProjectBootstrapCommands({
  vscode,
  selectProjectRoot,
  rememberProjectRoot,
  getBootstrapScaffoldingHelpers
}) {
  async function showProjectRootSelected(root) {
    await getBootstrapScaffoldingHelpers().showProjectRootSelected(root);
  }

  async function offerProjectInitialization(root) {
    await getBootstrapScaffoldingHelpers().offerProjectInitialization(root);
  }

  async function selectProjectRootCommand() {
    const root = await selectProjectRoot("Enter the project folder Codex Watchdog should control");
    if (!root) {
      return;
    }
    await rememberProjectRoot(root);
    await showProjectRootSelected(root);
  }

  async function bootstrapProjectCommand() {
    const root = await selectProjectRoot("Enter the project folder for Codex Watchdog bootstrap");
    if (!root) {
      return;
    }
    await rememberProjectRoot(root);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Bootstrapping Codex Watchdog",
      cancellable: false
    }, async () => {
      const result = await getBootstrapScaffoldingHelpers().bootstrapProject(root);
      getBootstrapScaffoldingHelpers().showBootstrapResult(result);
    });
  }

  async function createDemoProjectTemplateCommand() {
    const root = await selectProjectRoot("Enter or create the folder that should receive the Codex Watchdog demo template");
    if (!root) {
      return;
    }
    await rememberProjectRoot(root);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Creating Codex Watchdog demo template",
      cancellable: false
    }, async () => {
      const result = await getBootstrapScaffoldingHelpers().createDemoProjectTemplate(root);
      getBootstrapScaffoldingHelpers().showBootstrapResult(result);
      vscode.window.showInformationMessage("Codex Watchdog demo template is ready and selected as the project root. You can now run Codex Watchdog: Run Once Now from any workspace.");
    });
  }

  return {
    selectProjectRootCommand,
    bootstrapProjectCommand,
    createDemoProjectTemplateCommand,
    showProjectRootSelected,
    offerProjectInitialization
  };
}

module.exports = {
  createProjectBootstrapCommands
};
