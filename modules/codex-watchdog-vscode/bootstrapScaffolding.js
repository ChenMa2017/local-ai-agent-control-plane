"use strict";

function createBootstrapScaffoldingHelpers({
  fs,
  fsp,
  path,
  vscode,
  templates,
  output,
  ensureDir,
  generatedFilesHelpers,
  getProjectSetupHelpers,
  isWatchdogInitialized,
  isEffectivelyEmptyDir
}) {
  async function bootstrapProject(root) {
    const created = [];
    const skipped = [];

    await generatedFilesHelpers.ensureGeneratedDirs(root);

    await writeIfAbsent(root, path.join(root, "README.codex-watchdog.md"), templates.watchdogReadme(), created, skipped);
    await writeIfAbsent(root, path.join(root, "AGENTS.md"), templates.agents(), created, skipped);
    if (skipped.includes("AGENTS.md")) {
      await writeIfAbsent(root, path.join(root, "agent", "AGENTS.watchdog.example.md"), templates.agents(), created, skipped);
    }
    await writeIfAbsent(root, path.join(root, "agent", "CODEX_TAKEOVER.md"), templates.codexTakeover(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "WATCHDOG_PROTOCOL.md"), templates.watchdogProtocol(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "TASK_REQUEST.md"), templates.taskRequest(), created, skipped);

    await writeIfAbsent(root, path.join(root, "agent", "PLAN.md"), templates.plan(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "STATE.md"), templates.state(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "STATE.json"), templates.stateJson(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "TASK_BOX.json"), templates.taskBoxJson(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "ROUTE_CANONICAL.json"), templates.routeCanonicalJson(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "PROGRESS_STATE.json"), templates.progressStateJson(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "CURRENT_STATE.md"), templates.currentState(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "RUN_STATE.json"), templates.runStateJson(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "NEXT_ACTION.md"), templates.nextAction(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "BLOCKERS.md"), templates.blockers(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "REVIEW_PENDING.md"), templates.reviewPending(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "ANTI_SNOWBALL.md"), templates.antiSnowball(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "EXPERIMENT_LEDGER.md"), templates.experimentLedger(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "RUNTIME_STATE.md"), templates.runtimeState(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "DAILY_HANDOFF.md"), templates.dailyHandoff(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "MORNING_BRIEF.md"), templates.morningBrief(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "SAFETY.md"), templates.safety(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "TODO.md"), templates.todo(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "workspace_write_policy.example.json"), templates.workspaceWritePolicyExample(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "SECONDARY_SKILLS.example.json"), templates.secondarySkillsExample(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "status", "QUEUE_STATUS.md"), templates.queueStatus(), created, skipped);
    await writeIfAbsent(root, path.join(root, "agent", "EVIDENCE_LEDGER.jsonl"), templates.evidenceLedgerJsonl(), created, skipped);
    await writeIfAbsent(root, path.join(root, "research", "RESEARCH_LEDGER.md"), templates.researchLedger(), created, skipped);
    await writeIfAbsent(root, path.join(root, "research", "LEDGER_NOTES.md"), templates.ledgerNotes(), created, skipped);

    const generatedFiles = await generatedFilesHelpers.generatedWatcherFileEntries(root);
    for (const entry of generatedFiles) {
      await writeIfAbsent(root, entry.file, entry.content, created, skipped);
      if (entry.mode && fs.existsSync(entry.file)) {
        await fsp.chmod(entry.file, entry.mode);
      }
    }

    await generatedFilesHelpers.writeGeneratedManifestForRoot(root);

    return { created, skipped };
  }

  async function ensureWatchdogReadme(root) {
    const created = [];
    const skipped = [];
    await writeIfAbsent(root, path.join(root, "README.codex-watchdog.md"), templates.watchdogReadme(), created, skipped);
    if (created.length) {
      output.appendLine(`Created ${created.join(", ")}`);
    }
    return created.length > 0;
  }

  async function createDemoProjectTemplate(root) {
    const created = [];
    const skipped = [];

    await ensureDir(root);
    await ensureDir(path.join(root, "logs"));
    await writeIfAbsent(root, path.join(root, "README.md"), templates.demoReadme(), created, skipped);
    await writeIfAbsent(root, path.join(root, "logs", "train.log"), templates.demoTrainLog(), created, skipped);

    const bootstrapResult = await bootstrapProject(root);
    created.push(...bootstrapResult.created);
    skipped.push(...bootstrapResult.skipped);

    await writeDemoFileIfFreshOrTemplate(root, "agent/DAILY_HANDOFF.md", templates.demoDailyHandoff(), bootstrapResult.created, created);
    await writeDemoFileIfFreshOrTemplate(root, "agent/PLAN.md", templates.demoPlan(), bootstrapResult.created, created);
    await writeDemoFileIfFreshOrTemplate(root, "agent/TODO.md", templates.demoTodo(), bootstrapResult.created, created);
    await writeDemoFileIfFreshOrTemplate(root, "agent/STATE.md", templates.demoState(), bootstrapResult.created, created);
    await writeDemoFileIfFreshOrTemplate(root, "agent/SAFETY.md", templates.demoSafety(), bootstrapResult.created, created);
    await writeDemoStateJsonIfFreshOrDefault(root, "agent/STATE.json", templates.demoStateJson(), bootstrapResult.created, created);

    return { created, skipped };
  }

  function showBootstrapResult(result) {
    output.show(true);
    output.appendLine(`# Codex Watchdog bootstrap ${new Date().toISOString()}`);
    output.appendLine(`Created ${result.created.length} files.`);
    for (const file of result.created) {
      output.appendLine(`  + ${file}`);
    }
    if (result.skipped.length) {
      output.appendLine(`Skipped ${result.skipped.length} existing files.`);
      for (const file of result.skipped) {
        output.appendLine(`  = ${file}`);
      }
    }
    vscode.window.showInformationMessage("Codex Watchdog project files are ready.");
  }

  async function offerProjectInitialization(root) {
    if (isWatchdogInitialized(root)) {
      const createdReadme = await ensureWatchdogReadme(root);
      const suffix = createdReadme ? " Created README.codex-watchdog.md." : "";
      vscode.window.showInformationMessage(`Codex Watchdog project root set to: ${root}.${suffix}`);
      return;
    }

    const empty = await isEffectivelyEmptyDir(root);
    const message = empty
      ? `Selected folder is empty. Prepare a Codex Watchdog project template here?\n${root}`
      : `Selected folder has no Codex Watchdog agent/ template yet. Initialize it?\n${root}`;
    const answer = await vscode.window.showInformationMessage(
      message,
      "Prepare Project",
      "Create Demo Template",
      "Select Only"
    );

    if (answer === "Prepare Project") {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Preparing Codex Watchdog project template",
        cancellable: false
      }, async () => {
        await getProjectSetupHelpers().prepareProjectForInstantiation(root);
        await getProjectSetupHelpers().openInstantiationFiles(root);
      });
      vscode.window.showInformationMessage("Project template prepared. Continue in the Bootstrap Conversation section to instantiate PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF, then Start Guard when ready.");
      return;
    }

    if (answer === "Create Demo Template") {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Creating Codex Watchdog demo template",
        cancellable: false
      }, async () => {
        const result = await createDemoProjectTemplate(root);
        showBootstrapResult(result);
      });
      vscode.window.showInformationMessage("Demo template created. Run Codex Watchdog: Run Once Now to instantiate the watchdog cycle.");
      return;
    }

    vscode.window.showInformationMessage(`Codex Watchdog project root set to: ${root}`);
  }

  async function showProjectRootSelected(root) {
    if (isWatchdogInitialized(root)) {
      const createdReadme = await ensureWatchdogReadme(root);
      const suffix = createdReadme ? " Created README.codex-watchdog.md." : "";
      vscode.window.showInformationMessage(`Codex Watchdog project selected. Next: Start Guard when the task is ready.${suffix}`);
      return;
    }
    vscode.window.showInformationMessage("Codex Watchdog project selected. Next: click Prepare Project.");
  }

  async function writeIfAbsent(baseRoot, file, content, created, skipped) {
    const rel = path.relative(baseRoot, file);
    if (fs.existsSync(file)) {
      skipped.push(rel);
      return false;
    }
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, content);
    created.push(rel);
    return true;
  }

  async function writeDemoFileIfFreshOrTemplate(root, rel, content, freshlyCreated, created) {
    const file = path.join(root, rel);
    const existing = fs.existsSync(file) ? await fsp.readFile(file, "utf8") : "";
    if (!freshlyCreated.includes(rel) && !existing.includes("CODEX_WATCHDOG_TEMPLATE_FILE")) {
      return;
    }
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, content);
    created.push(`${rel} (demo content)`);
  }

  async function writeDemoStateJsonIfFreshOrDefault(root, rel, content, freshlyCreated, created) {
    const file = path.join(root, rel);
    let shouldWrite = freshlyCreated.includes(rel);

    if (!shouldWrite && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
        shouldWrite = Boolean(
          parsed &&
          parsed.schema_version === 1 &&
          Array.isArray(parsed.tasks) &&
          parsed.tasks.length === 0 &&
          parsed.allowed_next_action === "report_only"
        );
      } catch (_error) {
        shouldWrite = false;
      }
    }

    if (!shouldWrite) {
      return;
    }

    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, content);
    created.push(`${rel} (demo content)`);
  }

  return {
    bootstrapProject,
    ensureWatchdogReadme,
    createDemoProjectTemplate,
    showBootstrapResult,
    offerProjectInitialization,
    showProjectRootSelected
  };
}

module.exports = {
  createBootstrapScaffoldingHelpers
};
