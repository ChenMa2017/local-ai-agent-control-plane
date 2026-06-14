"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { createGuardControlFlow } = require("../guard/guardControlFlow");

async function withTempDir(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-watchdog-guard-control-"));
  try {
    await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function testPauseAndResumeGuard() {
  await withTempDir(async (root) => {
    const infoMessages = [];
    const controlFlow = createGuardControlFlow({
      fs,
      fsp,
      path,
      vscode: {
        window: {
          showInformationMessage(message) { infoMessages.push(message); },
          showWarningMessage() {}
        }
      },
      output: { show() {}, appendLine() {} },
      ensureDir: async (dir) => fsp.mkdir(dir, { recursive: true }),
      runLogged: async () => ({}),
      watchdogCommandEnv: async () => ({}),
      updateStatusBar: async () => {},
      unitNames: () => ({ timer: "codex-watchdog.timer" }),
      getTimerStatus: async () => ({ isActive: false, isEnabled: false, text: "ok" }),
      openDocument: async () => {}
    });

    const pauseFile = path.join(root, "agent", "control", "PAUSE");
    await controlFlow.pauseGuard(root);
    assert(fs.existsSync(pauseFile));
    await controlFlow.resumeGuard(root);
    assert(!fs.existsSync(pauseFile));
    assert(infoMessages.some((m) => m.includes("paused")));
    assert(infoMessages.some((m) => m.includes("resumed")));
  });
}

async function testOpenLatestReportWarnsWhenMissing() {
  const warnings = [];
  const opened = [];
  await withTempDir(async (root) => {
    const controlFlow = createGuardControlFlow({
      fs,
      fsp,
      path,
      vscode: {
        window: {
          showInformationMessage() {},
          showWarningMessage(message) { warnings.push(message); }
        }
      },
      output: { show() {}, appendLine() {} },
      ensureDir: async () => {},
      runLogged: async () => ({}),
      watchdogCommandEnv: async () => ({}),
      updateStatusBar: async () => {},
      unitNames: () => ({ timer: "codex-watchdog.timer" }),
      getTimerStatus: async () => ({ isActive: false, isEnabled: false, text: "ok" }),
      openDocument: async (file) => { opened.push(file); }
    });

    await controlFlow.openLatestReport(root);
    assert.strictEqual(opened.length, 0);
    assert.strictEqual(warnings.length, 1);
  });
}

async function main() {
  await testPauseAndResumeGuard();
  await testOpenLatestReportWarnsWhenMissing();
  console.log("guard-control-flow test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
