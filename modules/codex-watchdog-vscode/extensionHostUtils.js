"use strict";

const { createHostCommandRunner } = require("./hostCommandRunner");
const { createHostCodexResolver } = require("./hostCodexResolver");
const { createHostPathUtils } = require("./hostPathUtils");
const { createHostProjectSettings } = require("./hostProjectSettings");

function createExtensionHostUtils({
  vscode,
  fs,
  fsp,
  path,
  os,
  crypto,
  cp,
  getOutput,
  getRuntimeConfigHelpers
}) {
  function getSafeOutput() {
    const value = typeof getOutput === "function" ? getOutput() : undefined;
    return value && typeof value.appendLine === "function" ? value : undefined;
  }

  const pathUtils = createHostPathUtils({
    fs,
    path,
    os
  });
  const expandHome = pathUtils.expandHome;
  const isExistingDirectory = pathUtils.isExistingDirectory;
  const validateProjectRootPath = pathUtils.validateProjectRootPath;
  const isSafeProjectRootPath = pathUtils.isSafeProjectRootPath;
  const requireExistingDirectory = pathUtils.requireExistingDirectory;

  const projectSettings = createHostProjectSettings({
    vscode,
    fs,
    fsp,
    path,
    getSafeOutput
  });
  const extensionSetting = projectSettings.extensionSetting;
  const extensionSettingWithSource = projectSettings.extensionSettingWithSource;
  const projectSetting = projectSettings.projectSetting;
  const projectSettingWithSource = projectSettings.projectSettingWithSource;
  const readProjectSettings = projectSettings.readProjectSettings;
  const updateProjectSetting = projectSettings.updateProjectSetting;

  const commandRunner = createHostCommandRunner({
    cp,
    os,
    getSafeOutput
  });
  const run = commandRunner.run;
  const runLogged = commandRunner.runLogged;
  const runLoggedWithInput = commandRunner.runLoggedWithInput;

  function projectSlug(root) {
    return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  }

  function unitNames(root) {
    const runtimeConfig = getRuntimeConfigHelpers();
    const prefix = runtimeConfig.servicePrefixSetting(root);
    const slug = projectSlug(root);
    const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
    const units = {
      service: `${prefix}-${slug}-${hash}.service`,
      timer: `${prefix}-${slug}-${hash}.timer`
    };
    runtimeConfig.validateUnitName(units.service, ".service");
    runtimeConfig.validateUnitName(units.timer, ".timer");
    return units;
  }
  const codexResolver = createHostCodexResolver({
    fs,
    path,
    os,
    expandHome,
    projectSettingWithSource,
    extensionSettingWithSource,
    run
  });
  const resolveCodexBin = codexResolver.resolveCodexBin;

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

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function systemdQuote(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  }

  function systemdPathValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\s/g, "\\x20");
  }

  function systemdEnvValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\s/g, "\\x20");
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
    extensionSetting,
    extensionSettingWithSource,
    expandHome,
    isExistingDirectory,
    isSafeProjectRootPath,
    validateProjectRootPath,
    requireExistingDirectory,
    resolveCodexBin,
    projectSetting,
    projectSettingWithSource,
    unitNames,
    readProjectSettings,
    updateProjectSetting,
    runLogged,
    runLoggedWithInput,
    run,
    ensureDir,
    openDocument,
    readFilePrefix,
    shellQuote,
    systemdQuote,
    systemdPathValue,
    systemdEnvValue,
    isWatchdogInitialized,
    isEffectivelyEmptyDir
  };
}

module.exports = {
  createExtensionHostUtils
};
