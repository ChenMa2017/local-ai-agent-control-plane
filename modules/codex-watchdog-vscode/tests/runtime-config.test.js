"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { createRuntimeConfigHelpers } = require("../runtime/runtimeConfig");

async function rmCompat(target, options = {}) {
  if (typeof fsp.rm === "function") {
    await fsp.rm(target, options);
    return;
  }
  const recursive = Boolean(options.recursive);
  const force = Boolean(options.force);
  try {
    if (recursive) {
      await fsp.rmdir(target, { recursive: true });
    } else {
      await fsp.unlink(target);
    }
  } catch (error) {
    if (force && error && error.code === "ENOENT") {
      return;
    }
    if (force && !recursive && error && error.code === "EISDIR") {
      await fsp.rmdir(target, { recursive: true });
      return;
    }
    throw error;
  }
}

async function withTempDir(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-watchdog-runtime-config-"));
  try {
    await run(root);
  } finally {
    await rmCompat(root, { recursive: true, force: true });
  }
}

async function testSandboxModeFallsBackWithoutPolicy() {
  await withTempDir(async (root) => {
    const logs = [];
    const helpers = createRuntimeConfigHelpers({
      fs,
      path,
      os,
      output: { appendLine(line) { logs.push(line); } },
      defaultWatchdogRole: "runner",
      defaultServicePrefix: "codex-watchdog",
      extensionSetting: (_key, fallback) => fallback,
      extensionSettingWithSource: (_key, fallback) => ({ value: fallback, source: "extension" }),
      projectSetting: (_root, key, fallback) => key === "codexWatchdog.sandboxMode" ? "workspace-write" : fallback,
      projectSettingWithSource: (_root, _key, fallback) => ({ value: fallback, source: "project" }),
      expandHome: (value) => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
    });

    assert.strictEqual(helpers.sandboxModeSetting(root), "read-only");
    assert(logs.some((line) => line.includes("workspace-write requested")));
  });
}

async function testCodexHomePlanFallsBackToSafeWatcherHome() {
  await withTempDir(async (root) => {
    const configuredWatcherHome = path.join(root, "watcher-home");
    const helpers = createRuntimeConfigHelpers({
      fs,
      path,
      os,
      output: { appendLine() {} },
      defaultWatchdogRole: "runner",
      defaultServicePrefix: "codex-watchdog",
      extensionSetting: (_key, fallback) => fallback,
      extensionSettingWithSource: (_key, fallback) => ({ value: fallback, source: "extension" }),
      projectSetting: (_root, _key, fallback) => fallback,
      projectSettingWithSource: (_root, _key, _fallback) => ({ value: configuredWatcherHome, source: "project" }),
      expandHome: (value) => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
    });

    const plan = helpers.codexHomePlan(root);
    assert.strictEqual(plan.configuredPath, configuredWatcherHome);
    assert.notStrictEqual(plan.effectivePath, configuredWatcherHome);
    assert(plan.effectivePath.includes(path.join(".codex-watchers", path.basename(root).toLowerCase())));
    assert.strictEqual(plan.requiresProjectSettingUpdate, true);
    assert.match(plan.migrationReason, /safe watcher home/i);
  });
}

async function testMergeWatcherConfigTextInheritsModelAndHooks() {
  await withTempDir(async (_root) => {
    const helpers = createRuntimeConfigHelpers({
      fs,
      path,
      os,
      output: { appendLine() {} },
      defaultWatchdogRole: "runner",
      defaultServicePrefix: "codex-watchdog",
      extensionSetting: (_key, fallback) => fallback,
      extensionSettingWithSource: (_key, fallback) => ({ value: fallback, source: "extension" }),
      projectSetting: (_root2, _key, fallback) => fallback,
      projectSettingWithSource: (_root2, _key, fallback) => ({ value: fallback, source: "extension" }),
      expandHome: (value) => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
    });

    const result = helpers.mergeWatcherConfigText("", {
      model: "gpt-5-codex",
      modelReasoningEffort: "high"
    });

    assert.match(result.text, /approval_policy = "never"/);
    assert.match(result.text, /sandbox_mode = "read-only"/);
    assert.match(result.text, /model = "gpt-5-codex"/);
    assert.match(result.text, /model_reasoning_effort = "high"/);
    assert.match(result.text, /\[features\]\nhooks = true/);
    assert.strictEqual(result.inheritedModel, true);
    assert.strictEqual(result.inheritedReasoning, true);
  });
}

async function main() {
  await testSandboxModeFallsBackWithoutPolicy();
  await testCodexHomePlanFallsBackToSafeWatcherHome();
  await testMergeWatcherConfigTextInheritsModelAndHooks();
  console.log("runtime-config test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
