"use strict";

const fs = require("fs");
const path = require("path");

function createProjectSetupHelpers({
  vscode,
  ensureDir,
  bootstrapProject,
  showBootstrapResult,
  refreshGeneratedWatcherFiles,
  bootstrapResultSchemaPath,
  bootstrapConversationTurnSchemaPath,
  openDocument
}) {
  async function prepareProjectForGuard(root) {
    await prepareProjectForInstantiation(root);
  }

  async function prepareProjectForInstantiation(root) {
    await ensureDir(root);
    const result = await bootstrapProject(root);
    if (result.created.length) {
      showBootstrapResult(result);
    }
    await refreshGeneratedWatcherFiles(root);
  }

  async function ensureBootstrapConversationReady(root) {
    await ensureDir(root);
    const result = await bootstrapProject(root);
    if (result.created.length) {
      showBootstrapResult(result);
    }
    if (!fs.existsSync(bootstrapResultSchemaPath(root)) || !fs.existsSync(bootstrapConversationTurnSchemaPath(root))) {
      await refreshGeneratedWatcherFiles(root);
    }
  }

  async function openInstantiationFiles(root) {
    for (const rel of [
      "agent/TASK_REQUEST.md",
      "agent/CODEX_TAKEOVER.md",
      "agent/PLAN.md",
      "agent/TODO.md",
      "agent/STATE.md",
      "agent/SAFETY.md",
      "agent/DAILY_HANDOFF.md"
    ]) {
      const file = path.join(root, rel);
      if (fs.existsSync(file)) {
        await openDocument(file, false);
      }
    }
  }

  async function confirmTaskInstantiatedIfNeeded(root) {
    if (taskLooksInstantiated(root)) {
      return true;
    }

    const answer = await vscode.window.showWarningMessage(
      [
        "This watchdog project still looks like a template.",
        "",
        "Before starting unattended guard mode, ask daily Codex to instantiate the task: fill PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF from your plain-language requirement.",
        "",
        "Start Guard should run after that task-instantiation step."
      ].join("\n"),
      { modal: true },
      "Open Instantiation Files"
    );

    if (answer === "Open Instantiation Files") {
      await openInstantiationFiles(root);
    }
    return false;
  }

  function taskLooksInstantiated(root) {
    const requiredFiles = {
      plan: path.join(root, "agent", "PLAN.md"),
      todo: path.join(root, "agent", "TODO.md"),
      state: path.join(root, "agent", "STATE.md"),
      safety: path.join(root, "agent", "SAFETY.md"),
      dailyHandoff: path.join(root, "agent", "DAILY_HANDOFF.md")
    };
    if (Object.values(requiredFiles).some((file) => !fs.existsSync(file))) {
      return false;
    }
    const contents = Object.fromEntries(
      Object.entries(requiredFiles).map(([key, file]) => [key, fs.readFileSync(file, "utf8")])
    );
    const containsTemplateMarker = Object.values(contents).some((text) => text.includes("CODEX_WATCHDOG_TEMPLATE_FILE"));
    if (containsTemplateMarker) {
      return false;
    }
    const exactTemplateChecks = [
      /Continue monitoring the current training\/evaluation pipeline/i.test(contents.plan),
      /Replace this line with the concrete objective/i.test(contents.dailyHandoff),
      /Replace this row with the first approved monitoring task/i.test(contents.todo)
    ];
    return !exactTemplateChecks.some(Boolean);
  }

  return {
    prepareProjectForGuard,
    prepareProjectForInstantiation,
    ensureBootstrapConversationReady,
    openInstantiationFiles,
    confirmTaskInstantiatedIfNeeded,
    taskLooksInstantiated
  };
}

module.exports = {
  createProjectSetupHelpers
};
