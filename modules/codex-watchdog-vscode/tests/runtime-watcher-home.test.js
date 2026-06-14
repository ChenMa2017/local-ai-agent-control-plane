"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRuntimeWatcherHomeHelpers } = require("../runtime/runtimeWatcherHome");

async function testEnsureCodexHomeMigration() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-runtime-home-"));
  const watcherHome = path.join(tempRoot, "watcher-home");
  const updates = [];
  const notices = [];
  const logs = [];

  const helpers = createRuntimeWatcherHomeHelpers({
    vscode: {
      window: {
        showInformationMessage(message) {
          notices.push(message);
        },
        showWarningMessage: async () => undefined,
        createTerminal() {
          return { show() {}, sendText() {} };
        }
      }
    },
    fs,
    fsp: fs.promises,
    path,
    os,
    output: { appendLine(line) { logs.push(line); } },
    loginReadyRe: /logged in/i,
    resolveCodexBin: async () => "/usr/bin/codex",
    codexHomeSetting: () => watcherHome,
    codexHomePlan: () => ({
      effectivePath: watcherHome,
      requiresProjectSettingUpdate: true,
      migrationReason: "migrated watcher home"
    }),
    updateProjectSetting: async (_root, key, value) => {
      updates.push([key, value]);
    },
    watcherProfileModelDefaults: () => ({ model: "gpt-5-codex", modelReasoningEffort: "high" }),
    mergeWatcherConfigText: () => ({ text: "model = \"gpt-5-codex\"\n", inheritedModel: true, changed: true }),
    hasTomlAssignment: () => false,
    parseTomlBasicString: () => "",
    run: async () => ({ stdout: "", stderr: "", error: null }),
    ensureDir: async (dir) => fs.promises.mkdir(dir, { recursive: true }),
    getProjectRoot: async () => tempRoot,
    shellQuote: (value) => `'${value}'`
  });

  await helpers.ensureCodexHome(tempRoot);

  assert.deepStrictEqual(updates, [["codexWatchdog.codexHome", watcherHome]]);
  assert(fs.existsSync(path.join(watcherHome, "config.toml")));
  assert(notices.some((message) => message.includes("moved this project's watcher home")));
  assert(logs.some((line) => line.includes("Seeded watcher model config")));
}

async function testBootstrapInspectionAndSeed() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-runtime-bootstrap-"));
  const watcherHome = path.join(tempRoot, "watcher");
  const mainHome = path.join(tempRoot, "main");
  fs.mkdirSync(watcherHome, { recursive: true });
  fs.mkdirSync(mainHome, { recursive: true });
  fs.writeFileSync(path.join(mainHome, "auth.json"), "{\"ok\":true}\n");
  fs.writeFileSync(path.join(mainHome, "models_cache.json"), "{\"models\":[]}\n");

  const helpers = createRuntimeWatcherHomeHelpers({
    vscode: { window: { showWarningMessage: async () => undefined, showInformationMessage() {}, createTerminal() { return { show() {}, sendText() {} }; } } },
    fs,
    fsp: fs.promises,
    path,
    os,
    output: { appendLine() {} },
    loginReadyRe: /logged in/i,
    resolveCodexBin: async () => "/usr/bin/codex",
    codexHomeSetting: () => watcherHome,
    codexHomePlan: () => ({ effectivePath: watcherHome, requiresProjectSettingUpdate: false, migrationReason: "" }),
    updateProjectSetting: async () => {},
    watcherProfileModelDefaults: () => ({}),
    mergeWatcherConfigText: (text) => ({ text, inheritedModel: false, changed: false }),
    hasTomlAssignment: () => false,
    parseTomlBasicString: () => "",
    run: async () => ({ stdout: "", stderr: "", error: null }),
    ensureDir: async (dir) => fs.promises.mkdir(dir, { recursive: true }),
    getProjectRoot: async () => tempRoot,
    shellQuote: (value) => `'${value}'`
  });

  const before = helpers.inspectWatcherHomeBootstrapState(watcherHome, mainHome);
  assert.strictEqual(before.authExists, false);
  assert.strictEqual(before.canSeedFromMainAuth, true);

  const seeded = await helpers.seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainHome);
  assert.strictEqual(seeded.copiedAuth, true);
  assert.strictEqual(seeded.copiedModelsCache, true);

  const after = helpers.inspectWatcherHomeBootstrapState(watcherHome, mainHome);
  assert.strictEqual(after.authExists, true);
  assert.strictEqual(after.modelsCacheExists, true);
}

async function testGetCodexLoginStatus() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-runtime-login-"));
  const watcherHome = path.join(tempRoot, "watcher");
  fs.mkdirSync(watcherHome, { recursive: true });
  fs.writeFileSync(path.join(watcherHome, "auth.json"), "{\"ok\":true}\n");
  fs.writeFileSync(path.join(watcherHome, "config.toml"), "model = \"gpt-5-codex\"\nmodel_reasoning_effort = \"high\"\n");

  const helpers = createRuntimeWatcherHomeHelpers({
    vscode: { window: { showWarningMessage: async () => undefined, showInformationMessage() {}, createTerminal() { return { show() {}, sendText() {} }; } } },
    fs,
    fsp: fs.promises,
    path,
    os,
    output: { appendLine() {} },
    loginReadyRe: /logged in/i,
    resolveCodexBin: async () => "/usr/bin/codex",
    codexHomeSetting: () => watcherHome,
    codexHomePlan: () => ({ effectivePath: watcherHome, requiresProjectSettingUpdate: false, migrationReason: "" }),
    updateProjectSetting: async () => {},
    watcherProfileModelDefaults: () => ({}),
    mergeWatcherConfigText: (text) => ({ text, inheritedModel: false, changed: false }),
    hasTomlAssignment: () => true,
    parseTomlBasicString: (text, key) => {
      const match = text.match(new RegExp(`${key} = \"([^\"]+)\"`));
      return match ? match[1] : "";
    },
    run: async () => ({ stdout: "logged in as demo", stderr: "", error: null }),
    ensureDir: async (dir) => fs.promises.mkdir(dir, { recursive: true }),
    getProjectRoot: async () => tempRoot,
    shellQuote: (value) => `'${value}'`
  });

  const status = await helpers.getCodexLoginStatus(tempRoot);
  assert.strictEqual(status.ok, true);
  assert.match(status.text, /logged in as demo/);
  assert.match(status.text, /Watcher model: gpt-5-codex/);
}

async function main() {
  await testEnsureCodexHomeMigration();
  await testBootstrapInspectionAndSeed();
  await testGetCodexLoginStatus();
  console.log("runtime-watcher-home test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
