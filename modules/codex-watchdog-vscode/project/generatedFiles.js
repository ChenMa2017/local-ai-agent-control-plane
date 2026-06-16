"use strict";

const {
  collaborationHandoffEntries,
  dailyHandoffEntries,
  generatedWatcherEntries
} = require("../templates/templateEntries");

function createGeneratedFilesHelpers({
  fs,
  fsp,
  path,
  crypto,
  packageVersion,
  templates,
  ensureDir,
  output,
  ensureCodexHome,
  renderWatchdogEnv
}) {
  async function ensureGeneratedDirs(root) {
    await ensureDir(path.join(root, "agent", "bin"));
    await ensureDir(path.join(root, "agent", "control"));
    await ensureDir(path.join(root, "agent", "queue", "queued"));
    await ensureDir(path.join(root, "agent", "queue", "running"));
    await ensureDir(path.join(root, "agent", "queue", "done"));
    await ensureDir(path.join(root, "agent", "queue", "failed"));
    await ensureDir(path.join(root, "agent", "gates", "pending"));
    await ensureDir(path.join(root, "agent", "gates", "passed"));
    await ensureDir(path.join(root, "agent", "gates", "failed"));
    await ensureDir(path.join(root, "agent", "gates", "review_required"));
    await ensureDir(path.join(root, "agent", "prompts"));
    await ensureDir(path.join(root, "agent", "schemas"));
    await ensureDir(path.join(root, "agent", "skills"));
    await ensureDir(path.join(root, "agent", "status"));
    await ensureDir(path.join(root, "agent", "reports"));
    await ensureDir(path.join(root, "agent", "pending", "review_required"));
    await ensureDir(path.join(root, "agent", "pending", "proposed_actions"));
    await ensureDir(path.join(root, "agent", "task_profiles"));
    await ensureDir(path.join(root, "agent", "logs"));
    await ensureDir(path.join(root, "workspace"));
    await ensureDir(path.join(root, "runs"));
    await ensureDir(path.join(root, "project_index", "schema"));
    await ensureDir(path.join(root, "research", "proposals"));
    await ensureDir(path.join(root, "research", "analysis"));
  }

  async function generatedWatcherFileEntries(root) {
    const watchdogEnv = await renderWatchdogEnv(root);
    const files = generatedWatcherEntries(root, templates, watchdogEnv);
    return files.map(([rel, content, mode]) => ({
      rel,
      file: path.join(root, rel),
      content,
      mode
    }));
  }

  function sha256Text(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }

  function generatedManifestContent(entries) {
    const templateHashes = {};
    for (const entry of entries.slice().sort((a, b) => a.rel.localeCompare(b.rel))) {
      templateHashes[entry.rel] = `sha256:${sha256Text(entry.content)}`;
    }
    return `${JSON.stringify({
      schema_version: 1,
      control_plane_module: "codex-watchdog-vscode",
      control_plane_version: packageVersion,
      generated_at: new Date().toISOString(),
      placeholder_policy: {
        public_paths: ["$PROJECT_ROOT", "$CONTROL_PLANE_ROOT", "$COLLAB_ROOT"]
      },
      template_hashes: templateHashes
    }, null, 2)}\n`;
  }

  async function writeGeneratedManifest(root, entries) {
    const manifest = path.join(root, "agent", "status", "generated_manifest.json");
    await ensureDir(path.dirname(manifest));
    await fsp.writeFile(manifest, generatedManifestContent(entries));
    return manifest;
  }

  async function writeGeneratedManifestForRoot(root) {
    const entries = await generatedWatcherFileEntries(root);
    await writeGeneratedManifest(root, entries);
  }

  async function refreshGeneratedWatcherFiles(root) {
    await ensureCodexHome(root);
    const files = await generatedWatcherFileEntries(root);
    for (const { file, content, mode } of files) {
      await ensureDir(path.dirname(file));
      await fsp.writeFile(file, content);
      await fsp.chmod(file, mode);
      output.appendLine(`Refreshed ${path.relative(root, file)}`);
    }
    await writeGeneratedManifest(root, files);
    output.appendLine("Refreshed agent/status/generated_manifest.json");

    const runtimeState = path.join(root, "agent", "RUNTIME_STATE.md");
    if (!fs.existsSync(runtimeState)) {
      await fsp.writeFile(runtimeState, templates.runtimeState());
      output.appendLine("Created agent/RUNTIME_STATE.md");
    }
    await ensureCollaborationHandoffFiles(root);
    const stateJson = path.join(root, "agent", "STATE.json");
    if (!fs.existsSync(stateJson)) {
      await fsp.writeFile(stateJson, templates.stateJson());
      output.appendLine("Created agent/STATE.json");
    }
    const progressState = path.join(root, "agent", "PROGRESS_STATE.json");
    if (!fs.existsSync(progressState)) {
      await fsp.writeFile(progressState, templates.progressStateJson());
      output.appendLine("Created agent/PROGRESS_STATE.json");
    }
    const queueStatus = path.join(root, "agent", "status", "QUEUE_STATUS.md");
    if (!fs.existsSync(queueStatus)) {
      await fsp.writeFile(queueStatus, templates.queueStatus());
      output.appendLine("Created agent/status/QUEUE_STATUS.md");
    }
    const researchLedger = path.join(root, "research", "RESEARCH_LEDGER.md");
    if (!fs.existsSync(researchLedger)) {
      await ensureDir(path.dirname(researchLedger));
      await fsp.writeFile(researchLedger, templates.researchLedger());
      output.appendLine("Created research/RESEARCH_LEDGER.md");
    }
    const ledgerNotes = path.join(root, "research", "LEDGER_NOTES.md");
    if (!fs.existsSync(ledgerNotes)) {
      await ensureDir(path.dirname(ledgerNotes));
      await fsp.writeFile(ledgerNotes, templates.ledgerNotes());
      output.appendLine("Created research/LEDGER_NOTES.md");
    }
    const taskRequest = path.join(root, "agent", "TASK_REQUEST.md");
    if (!fs.existsSync(taskRequest)) {
      await fsp.writeFile(taskRequest, templates.taskRequest());
      output.appendLine("Created agent/TASK_REQUEST.md");
    }
    const workspaceWritePolicyExample = path.join(root, "agent", "workspace_write_policy.example.json");
    if (!fs.existsSync(workspaceWritePolicyExample)) {
      await fsp.writeFile(workspaceWritePolicyExample, templates.workspaceWritePolicyExample());
      output.appendLine("Created agent/workspace_write_policy.example.json");
    }
    const secondarySkillsExample = path.join(root, "agent", "SECONDARY_SKILLS.example.json");
    if (!fs.existsSync(secondarySkillsExample)) {
      await fsp.writeFile(secondarySkillsExample, templates.secondarySkillsExample());
      output.appendLine("Created agent/SECONDARY_SKILLS.example.json");
    }
    const projectIndexDocumentIndex = path.join(root, "project_index", "document_index.jsonl");
    if (!fs.existsSync(projectIndexDocumentIndex)) {
      await ensureDir(path.dirname(projectIndexDocumentIndex));
      await fsp.writeFile(projectIndexDocumentIndex, templates.projectIndexDocumentIndex());
      output.appendLine("Created project_index/document_index.jsonl");
    }
    const projectIndexExperimentIndex = path.join(root, "project_index", "experiment_index.jsonl");
    if (!fs.existsSync(projectIndexExperimentIndex)) {
      await ensureDir(path.dirname(projectIndexExperimentIndex));
      await fsp.writeFile(projectIndexExperimentIndex, templates.projectIndexExperimentIndex());
      output.appendLine("Created project_index/experiment_index.jsonl");
    }
    const projectIndexCurrentConclusions = path.join(root, "project_index", "current_conclusions.json");
    if (!fs.existsSync(projectIndexCurrentConclusions)) {
      await ensureDir(path.dirname(projectIndexCurrentConclusions));
      await fsp.writeFile(projectIndexCurrentConclusions, templates.projectIndexCurrentConclusions());
      output.appendLine("Created project_index/current_conclusions.json");
    }
    const projectIndexGoldenQueries = path.join(root, "project_index", "golden_queries.json");
    if (!fs.existsSync(projectIndexGoldenQueries)) {
      await ensureDir(path.dirname(projectIndexGoldenQueries));
      await fsp.writeFile(projectIndexGoldenQueries, templates.projectIndexGoldenQueries());
      output.appendLine("Created project_index/golden_queries.json");
    }
    await ensureHandoffFiles(root);
  }

  async function ensureCollaborationHandoffFiles(root) {
    const files = collaborationHandoffEntries(templates);
    for (const [rel, content] of files) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) {
        await ensureDir(path.dirname(file));
        await fsp.writeFile(file, content);
        output.appendLine(`Created ${rel}`);
      }
    }
  }

  async function ensureHandoffFiles(root) {
    for (const [rel, content] of dailyHandoffEntries(templates)) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) {
        await fsp.writeFile(file, content);
        output.appendLine(`Created ${rel}`);
      }
    }
  }

  return {
    ensureGeneratedDirs,
    generatedWatcherFileEntries,
    writeGeneratedManifestForRoot,
    refreshGeneratedWatcherFiles,
    ensureCollaborationHandoffFiles,
    ensureHandoffFiles
  };
}

module.exports = {
  createGeneratedFilesHelpers
};
