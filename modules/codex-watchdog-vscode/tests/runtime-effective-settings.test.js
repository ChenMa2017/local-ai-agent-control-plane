"use strict";

const assert = require("assert");
const { createRuntimeEffectiveSettingsResolver } = require("../runtime/runtimeEffectiveSettings");

async function testEffectiveWatchdogSettings() {
  const calls = [];
  const resolver = createRuntimeEffectiveSettingsResolver({
    resolveCodexBin: async (root) => {
      calls.push(["resolveCodexBin", root]);
      return "/usr/bin/codex";
    },
    codexHomeSetting: (root) => {
      calls.push(["codexHomeSetting", root]);
      return "/tmp/watcher-home";
    },
    sandboxModeSetting: (root) => {
      calls.push(["sandboxModeSetting", root]);
      return "read-only";
    },
    positiveNumberSetting: (root, key, fallback, min, hardFallback) => {
      calls.push(["positiveNumberSetting", root, key, fallback, min, hardFallback]);
      return hardFallback + 1;
    },
    extensionSetting: (key, fallback) => {
      calls.push(["extensionSetting", key, fallback]);
      return fallback;
    },
    watchdogRoleSetting: (root) => {
      calls.push(["watchdogRoleSetting", root]);
      return "supervisor";
    },
    booleanSetting: (root, key, fallback, hardFallback) => {
      calls.push(["booleanSetting", root, key, fallback, hardFallback]);
      return !hardFallback;
    },
    servicePrefixSetting: (root) => {
      calls.push(["servicePrefixSetting", root]);
      return "codex-watchdog-test";
    },
    defaultTimeoutMinutes: 25,
    defaultIntervalMinutes: 30,
    defaultCompactEveryRuns: 6,
    defaultPhaseOffsetMinutes: 10,
    defaultSupervisorLightFollowup: true,
    defaultSupervisorAuditEveryRunnerRuns: 4
  });

  const settings = await resolver.effectiveWatchdogSettings("/tmp/project");

  assert.strictEqual(settings.codexBin, "/usr/bin/codex");
  assert.strictEqual(settings.codexHome, "/tmp/watcher-home");
  assert.strictEqual(settings.sandboxMode, "read-only");
  assert.strictEqual(settings.intervalMinutes, 31);
  assert.strictEqual(settings.timeoutMinutes, 26);
  assert.strictEqual(settings.compactEveryRuns, 7);
  assert.strictEqual(settings.role, "supervisor");
  assert.strictEqual(settings.phaseOffsetMinutes, 11);
  assert.strictEqual(settings.supervisorLightFollowup, false);
  assert.strictEqual(settings.supervisorAuditEveryRunnerRuns, 5);
  assert.strictEqual(settings.servicePrefix, "codex-watchdog-test");
  assert(calls.some((entry) => entry[0] === "resolveCodexBin"));
  assert(calls.some((entry) => entry[0] === "booleanSetting"));
}

async function main() {
  await testEffectiveWatchdogSettings();
  console.log("runtime-effective-settings test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
