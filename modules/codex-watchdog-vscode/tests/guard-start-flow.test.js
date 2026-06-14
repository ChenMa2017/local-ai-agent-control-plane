"use strict";

const assert = require("assert");
const path = require("path");
const { createGuardStartFlow } = require("../guard/guardStartFlow");

async function testGuardStartFlowSuccess() {
  const calls = [];
  const progressMessages = [];
  const infoMessages = [];
  const outputLines = [];

  const vscode = {
    ProgressLocation: { Notification: 1 },
    window: {
      async withProgress(options, callback) {
        calls.push(["withProgress", options.title]);
        return callback({
          report(update) {
            progressMessages.push(update.message);
          }
        });
      },
      showInformationMessage(message) {
        infoMessages.push(message);
      }
    }
  };

  const flow = createGuardStartFlow({
    vscode,
    output: {
      show() {
        calls.push(["output.show"]);
      },
      appendLine(line) {
        outputLines.push(line);
      }
    },
    prepareProjectForGuard: async (root) => calls.push(["prepareProjectForGuard", root]),
    confirmTaskInstantiatedIfNeeded: async (root) => {
      calls.push(["confirmTaskInstantiatedIfNeeded", root]);
      return true;
    },
    ensureCodexHome: async (root) => calls.push(["ensureCodexHome", root]),
    confirmLoginIfNeeded: async (root) => {
      calls.push(["confirmLoginIfNeeded", root]);
      return true;
    },
    runLogged: async (cmd, args, options) => {
      calls.push(["runLogged", cmd, args, options.cwd]);
    },
    watchdogCommandEnv: async () => ({ TEST_ENV: "1" }),
    watchdogCommandTimeoutMs: () => 12345,
    setPanelOperationState: async (data) => calls.push(["setPanelOperationState", data.title, data.detail]),
    clearPanelOperationState: async () => calls.push(["clearPanelOperationState"]),
    updateStatusBar: async () => calls.push(["updateStatusBar"]),
    path
  });

  await flow.runGuardStartFlow({
    root: "/tmp/watchdog-project",
    progressTitle: "Starting Codex Watchdog guard",
    prepareMessage: "Preparing generated files",
    prepareDetail: "detail-prepare",
    codexHomeMessage: "Preparing Codex home",
    codexHomeDetail: "detail-home",
    startMessage: "Running one wakeup, then starting timer",
    startDetail: "detail-start",
    logHeading: "Start Guard",
    successMessage: "started ok"
  });

  assert.deepStrictEqual(progressMessages, [
    "Preparing generated files",
    "Preparing Codex home",
    "Running one wakeup, then starting timer"
  ]);
  assert(calls.some((entry) => entry[0] === "prepareProjectForGuard"));
  assert(calls.some((entry) => entry[0] === "ensureCodexHome"));
  assert(calls.some((entry) => entry[0] === "runLogged" && entry[1] === path.join("/tmp/watchdog-project", "agent", "bin", "watchdog")));
  assert(calls.some((entry) => entry[0] === "updateStatusBar"));
  assert(calls.some((entry) => entry[0] === "clearPanelOperationState"));
  assert.deepStrictEqual(infoMessages, ["started ok"]);
  assert(outputLines.some((line) => line.includes("Start Guard")));
}

async function testGuardStartFlowStopsWhenTaskNotReady() {
  const calls = [];

  const vscode = {
    ProgressLocation: { Notification: 1 },
    window: {
      async withProgress(_options, callback) {
        return callback({ report() {} });
      },
      showInformationMessage() {}
    }
  };

  const flow = createGuardStartFlow({
    vscode,
    output: { show() {}, appendLine() {} },
    prepareProjectForGuard: async () => calls.push("prepareProjectForGuard"),
    confirmTaskInstantiatedIfNeeded: async () => false,
    ensureCodexHome: async () => calls.push("ensureCodexHome"),
    confirmLoginIfNeeded: async () => true,
    runLogged: async () => calls.push("runLogged"),
    watchdogCommandEnv: async () => ({}),
    watchdogCommandTimeoutMs: () => 1,
    setPanelOperationState: async () => calls.push("setPanelOperationState"),
    clearPanelOperationState: async () => calls.push("clearPanelOperationState"),
    updateStatusBar: async () => calls.push("updateStatusBar"),
    path
  });

  await flow.runGuardStartFlow({
    root: "/tmp/watchdog-project",
    progressTitle: "Starting Codex Watchdog guard",
    prepareMessage: "Preparing generated files",
    prepareDetail: "detail-prepare",
    codexHomeMessage: "Preparing Codex home",
    codexHomeDetail: "detail-home",
    startMessage: "Running one wakeup, then starting timer",
    startDetail: "detail-start",
    logHeading: "Start Guard",
    successMessage: "started ok"
  });

  assert(calls.includes("prepareProjectForGuard"));
  assert(!calls.includes("ensureCodexHome"));
  assert(!calls.includes("runLogged"));
  assert(calls.includes("clearPanelOperationState"));
}

async function main() {
  await testGuardStartFlowSuccess();
  await testGuardStartFlowStopsWhenTaskNotReady();
  console.log("guard-start-flow test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
