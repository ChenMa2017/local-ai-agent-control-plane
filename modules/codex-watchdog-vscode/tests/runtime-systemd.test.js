"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRuntimeSystemdHelpers } = require("../runtime/runtimeSystemd");

async function testRenderAndWriteSystemdUnits() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-runtime-systemd-"));
  const fakeHome = path.join(tempRoot, "home");
  const projectRoot = path.join(tempRoot, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const logs = [];

  const helpers = createRuntimeSystemdHelpers({
    fs,
    fsp: fs.promises,
    path,
    os: { homedir: () => fakeHome },
    output: { appendLine(line) { logs.push(line); } },
    effectiveWatchdogSettings: async () => ({
      codexBin: "/usr/bin/codex",
      codexHome: "/tmp/watcher-home",
      sandboxMode: "read-only",
      intervalMinutes: 30,
      timeoutMinutes: 25,
      compactEveryRuns: 6,
      role: "runner",
      phaseOffsetMinutes: 10,
      supervisorLightFollowup: true,
      supervisorAuditEveryRunnerRuns: 4,
      servicePrefix: "codex-watchdog"
    }),
    run: async () => ({ stdout: "", stderr: "", error: null }),
    ensureDir: async (dir) => fs.promises.mkdir(dir, { recursive: true }),
    unitNames: () => ({
      service: "codex-watchdog-test.service",
      timer: "codex-watchdog-test.timer"
    }),
    systemdQuote: (value) => `"${value}"`,
    systemdPathValue: (value) => value.replace(/ /g, "\\x20"),
    systemdEnvValue: (value) => String(value).replace(/%/g, "%%").replace(/\s/g, "\\x20"),
    shellQuote: (value) => `'${value}'`
  });

  const envText = await helpers.renderWatchdogEnv(projectRoot);
  assert.match(envText, /CODEX_BIN='\/usr\/bin\/codex'/);
  assert.match(envText, /WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP='1'/);

  await helpers.writeSystemdUnits(projectRoot, {
    service: "codex-watchdog-test.service",
    timer: "codex-watchdog-test.timer"
  });

  const servicePath = path.join(fakeHome, ".config", "systemd", "user", "codex-watchdog-test.service");
  const timerPath = path.join(fakeHome, ".config", "systemd", "user", "codex-watchdog-test.timer");
  assert(fs.existsSync(servicePath));
  assert(fs.existsSync(timerPath));
  assert(logs.some((line) => line.includes("codex-watchdog-test.service")));
}

async function testTimerStatusAndDrift() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-runtime-status-"));
  const projectRoot = path.join(tempRoot, "project");
  const unitDir = path.join(tempRoot, "units");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });
  const calls = [];

  const helpers = createRuntimeSystemdHelpers({
    fs,
    fsp: fs.promises,
    path,
    os,
    output: { appendLine() {} },
    effectiveWatchdogSettings: async () => ({}),
    run: async (_command, args) => {
      calls.push(args.join(" "));
      if (args[1] === "is-active") {
        return { stdout: "active\n", stderr: "", error: null };
      }
      if (args[1] === "is-enabled") {
        return { stdout: "enabled\n", stderr: "", error: null };
      }
      return { stdout: "Fri 2026-06-13 10:00:00 UTC 28min left\n", stderr: "", error: null };
    },
    ensureDir: async () => {},
    unitNames: () => ({
      service: "codex-watchdog-test.service",
      timer: "codex-watchdog-test.timer"
    }),
    systemdQuote: (value) => `"${value}"`,
    systemdPathValue: (value) => value,
    systemdEnvValue: (value) => String(value),
    shellQuote: (value) => `'${value}'`
  });

  const status = await helpers.getTimerStatus(projectRoot);
  assert.strictEqual(status.isActive, true);
  assert.strictEqual(status.isEnabled, true);
  assert.match(status.text, /active: active/);
  assert.strictEqual(calls.length, 3);

  fs.writeFileSync(path.join(unitDir, "codex-watchdog-test.service"), [
    "Environment=CODEX_BIN=/usr/bin/codex",
    "Environment=CODEX_HOME=/tmp/home",
    "Environment=CODEX_SANDBOX_MODE=read-only",
    "Environment=WATCHDOG_TIMEOUT_MINUTES=25",
    "Environment=WATCHDOG_COMPACT_EVERY_RUNS=6",
    "Environment=WATCHDOG_ROLE=runner",
    "Environment=WATCHDOG_PHASE_OFFSET_MINUTES=10",
    "Environment=WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=1",
    "Environment=WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=4"
  ].join("\n"));
  fs.writeFileSync(path.join(unitDir, "codex-watchdog-test.timer"), [
    "OnActiveSec=10min",
    "OnUnitActiveSec=30min"
  ].join("\n"));

  const aligned = helpers.readWatcherUnitDrift(projectRoot, {
    codexBin: "/usr/bin/codex",
    codexHome: "/tmp/home",
    sandboxMode: "read-only",
    timeoutMinutes: 25,
    compactEveryRuns: 6,
    role: "runner",
    phaseOffsetMinutes: 10,
    supervisorLightFollowup: true,
    supervisorAuditEveryRunnerRuns: 4,
    intervalMinutes: 30
  }, unitDir);
  assert.strictEqual(aligned.needsReinstall, false);

  const drifted = helpers.readWatcherUnitDrift(projectRoot, {
    codexBin: "/usr/bin/codex",
    codexHome: "/tmp/other-home",
    sandboxMode: "read-only",
    timeoutMinutes: 25,
    compactEveryRuns: 6,
    role: "runner",
    phaseOffsetMinutes: 10,
    supervisorLightFollowup: true,
    supervisorAuditEveryRunnerRuns: 4,
    intervalMinutes: 45
  }, unitDir);
  assert.strictEqual(drifted.needsReinstall, true);
  assert(drifted.reasons.length >= 1);
}

async function main() {
  await testRenderAndWriteSystemdUnits();
  await testTimerStatusAndDrift();
  console.log("runtime-systemd test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
