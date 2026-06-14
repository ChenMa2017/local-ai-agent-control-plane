"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const { createExtensionHostUtils } = require("../extensionSupport/extensionHostUtils");

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-host-utils-"));
  fs.mkdirSync(path.join(projectRoot, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".vscode", "settings.json"), `{
  // comment
  "codexWatchdog.codexBin": "codex",
  "codexWatchdog.timeoutMinutes": 42,
}
`);

  const logs = [];
  const utils = createExtensionHostUtils({
    vscode: {
      workspace: {
        getConfiguration: () => ({
          inspect: (key) => {
            if (key === "codexHome") {
              return { globalValue: "~/.codex-watcher", defaultValue: "~/.codex-watcher" };
            }
            return { defaultValue: undefined };
          }
        }),
        openTextDocument: async (uri) => ({ uri })
      },
      window: {
        showTextDocument: async () => {}
      },
      Uri: {
        file: (fsPath) => ({ fsPath })
      }
    },
    fs,
    fsp: fs.promises,
    path,
    os,
    crypto,
    cp,
    getOutput: () => ({
      appendLine(line) {
        logs.push(line);
      },
      show() {}
    }),
    getRuntimeConfigHelpers: () => ({
      servicePrefixSetting: () => "codex-watchdog",
      validateUnitName(name, suffix) {
        assert(name.endsWith(suffix));
      }
    })
  });

  assert.strictEqual(utils.projectSetting(projectRoot, "codexWatchdog.timeoutMinutes", 25), 42);
  assert.strictEqual(utils.projectSettingWithSource(projectRoot, "codexWatchdog.timeoutMinutes", 25).source, "project");
  assert.strictEqual(utils.extensionSettingWithSource("codexHome", "~/.fallback").source, "global");
  assert.strictEqual(utils.expandHome("~/test"), path.join(os.homedir(), "test"));
  assert.strictEqual(utils.isSafeProjectRootPath(projectRoot), true);

  await utils.updateProjectSetting(projectRoot, "codexWatchdog.intervalMinutes", 30);
  const updated = JSON.parse(fs.readFileSync(path.join(projectRoot, ".vscode", "settings.json"), "utf8"));
  assert.strictEqual(updated["codexWatchdog.intervalMinutes"], 30);
  assert(logs.some((line) => line.includes("Updated .vscode/settings.json")));

  const units = utils.unitNames(projectRoot);
  assert.match(units.service, /^codex-watchdog-.*\.service$/);
  assert.match(units.timer, /^codex-watchdog-.*\.timer$/);
  assert.strictEqual(utils.systemdEnvValue("a b%c"), "a\\x20b%%c");

  console.log("extension-host-utils test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
