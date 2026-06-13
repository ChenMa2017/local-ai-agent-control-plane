"use strict";

function createProjectRootManager({
  vscode,
  fs,
  path,
  os,
  projectRootKey,
  getExtensionContext,
  output,
  updateStatusBar,
  extensionSetting,
  expandHome,
  isExistingDirectory,
  isSafeProjectRootPath,
  validateProjectRootPath,
  ensureDir,
  requireExistingDirectory
}) {
  function getKnownProjectRoot() {
    const configured = expandHome(extensionSetting("projectRoot", ""));
    if (configured && isExistingDirectory(configured) && isSafeProjectRootPath(configured)) {
      return configured;
    }
    const extensionContext = getExtensionContext();
    const remembered = extensionContext && extensionContext.globalState.get(projectRootKey);
    if (remembered && isExistingDirectory(remembered) && isSafeProjectRootPath(remembered)) {
      return remembered;
    }
    return "";
  }

  function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error("Open a project folder first.");
    }
    return folders[0].uri.fsPath;
  }

  function getDefaultRootUri() {
    const configured = expandHome(extensionSetting("projectRoot", ""));
    if (configured && isExistingDirectory(configured) && isSafeProjectRootPath(configured)) {
      return vscode.Uri.file(configured);
    }
    const extensionContext = getExtensionContext();
    const remembered = extensionContext && extensionContext.globalState.get(projectRootKey);
    if (remembered && isExistingDirectory(remembered) && isSafeProjectRootPath(remembered)) {
      return vscode.Uri.file(remembered);
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri;
    }
    return vscode.Uri.file(os.homedir());
  }

  function getDefaultRootInputValue() {
    const configured = expandHome(extensionSetting("projectRoot", ""));
    if (configured && isSafeProjectRootPath(configured)) {
      return configured;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0 && isSafeProjectRootPath(folders[0].uri.fsPath)) {
      return folders[0].uri.fsPath;
    }
    return path.join(os.homedir(), "codex-watchdog-project");
  }

  async function selectProjectRoot(title) {
    const defaultRoot = getDefaultRootInputValue();
    const value = await vscode.window.showInputBox({
      title,
      prompt: "Enter an absolute Linux folder path. If it does not exist, Codex Watchdog can create it.",
      placeHolder: "/home/you/project",
      value: defaultRoot,
      ignoreFocusOut: true,
      validateInput: (raw) => {
        const expanded = expandHome(String(raw || "").trim());
        if (!expanded) {
          return "Enter a project folder path.";
        }
        if (!path.isAbsolute(expanded)) {
          return "Use an absolute Linux path, or ~/...";
        }
        try {
          validateProjectRootPath(expanded);
        } catch (error) {
          return error.message || String(error);
        }
        return undefined;
      }
    });
    return normalizeProjectRootInput(value, "Selected project root", { offerCreate: true });
  }

  async function browseExistingProjectRoot(title, raw) {
    const selected = await vscode.window.showOpenDialog({
      title,
      openLabel: "Select Folder",
      defaultUri: getBrowseDefaultUri(raw),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false
    });
    if (!selected || selected.length === 0) {
      return undefined;
    }
    return requireExistingDirectory(selected[0].fsPath, "Selected project root");
  }

  function getBrowseDefaultUri(raw) {
    const expanded = expandHome(String(raw || "").trim());
    if (expanded && isExistingDirectory(expanded) && isSafeProjectRootPath(expanded)) {
      return vscode.Uri.file(expanded);
    }
    if (expanded && path.isAbsolute(expanded)) {
      let parent = path.dirname(expanded);
      while (parent && parent !== path.dirname(parent)) {
        if (isExistingDirectory(parent) && isSafeProjectRootPath(parent)) {
          return vscode.Uri.file(parent);
        }
        parent = path.dirname(parent);
      }
    }
    return getDefaultRootUri();
  }

  async function normalizeProjectRootInput(raw, label, options = {}) {
    const root = expandHome(String(raw || "").trim());
    if (!root) {
      return undefined;
    }
    validateProjectRootPath(root);
    if (!path.isAbsolute(root)) {
      throw new Error(`${label} must be an absolute Linux path: ${root}`);
    }
    if (!fs.existsSync(root)) {
      if (!options.offerCreate) {
        throw new Error(`${label} does not exist: ${root}`);
      }
      if (options.confirmCreate !== false) {
        const answer = await vscode.window.showWarningMessage(
          `${label} does not exist. Create it?\n${root}`,
          "Create Folder",
          "Cancel"
        );
        if (answer !== "Create Folder") {
          return undefined;
        }
      }
      await ensureDir(root);
    }
    return requireExistingDirectory(root, label);
  }

  async function getProjectRoot() {
    const configured = expandHome(extensionSetting("projectRoot", ""));
    if (configured) {
      return normalizeProjectRootInput(configured, "Configured codexWatchdog.projectRoot", { offerCreate: true });
    }

    const extensionContext = getExtensionContext();
    const remembered = extensionContext && extensionContext.globalState.get(projectRootKey);
    if (remembered && fs.existsSync(remembered)) {
      return requireExistingDirectory(remembered, "Remembered Codex Watchdog project root");
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const root = folders[0].uri.fsPath;
      const answer = await vscode.window.showInformationMessage(
        `No Codex Watchdog project root is selected. Use current workspace folder?\n${root}`,
        "Use Workspace",
        "Choose Folder"
      );
      if (answer === "Use Workspace") {
        const safeRoot = requireExistingDirectory(root, "Workspace folder");
        await rememberProjectRoot(safeRoot);
        return safeRoot;
      }
    }

    const selected = await selectProjectRoot("Enter the project folder Codex Watchdog should control");
    if (!selected) {
      return undefined;
    }
    await rememberProjectRoot(selected);
    return selected;
  }

  async function rememberProjectRoot(root) {
    const extensionContext = getExtensionContext();
    if (!extensionContext) {
      return;
    }
    await extensionContext.globalState.update(projectRootKey, root);
    output.appendLine(`Selected project root: ${root}`);
    await updateStatusBar();
  }

  async function clearRememberedProjectRoot() {
    const extensionContext = getExtensionContext();
    if (!extensionContext) {
      return;
    }
    await extensionContext.globalState.update(projectRootKey, undefined);
    output.appendLine("Cleared remembered Codex Watchdog project root.");
    await updateStatusBar();
  }

  return {
    getKnownProjectRoot,
    getWorkspaceRoot,
    selectProjectRoot,
    browseExistingProjectRoot,
    normalizeProjectRootInput,
    getProjectRoot,
    rememberProjectRoot,
    clearRememberedProjectRoot
  };
}

module.exports = {
  createProjectRootManager
};
