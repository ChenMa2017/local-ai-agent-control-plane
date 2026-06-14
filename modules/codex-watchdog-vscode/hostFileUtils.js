"use strict";

function createHostFileUtils({
  vscode,
  fs,
  fsp,
  path
}) {
  async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  }

  async function openDocument(file, preview) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview });
  }

  function readFilePrefix(file, maxBytes) {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  function isWatchdogInitialized(root) {
    return fs.existsSync(path.join(root, "agent", "PLAN.md"))
      && fs.existsSync(path.join(root, "agent", "SAFETY.md"))
      && fs.existsSync(path.join(root, "agent", "bin", "run_watchdog.sh"));
  }

  async function isEffectivelyEmptyDir(root) {
    try {
      const entries = await fsp.readdir(root);
      return entries.filter((entry) => ![".git", ".DS_Store"].includes(entry)).length === 0;
    } catch (_error) {
      return false;
    }
  }

  return {
    ensureDir,
    openDocument,
    readFilePrefix,
    isWatchdogInitialized,
    isEffectivelyEmptyDir
  };
}

module.exports = {
  createHostFileUtils
};
