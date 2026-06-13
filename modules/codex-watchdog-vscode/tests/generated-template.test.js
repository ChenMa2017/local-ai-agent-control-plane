"use strict";

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const moduleRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(moduleRoot, "extension.js");

function loadExtensionTestApi(projectRoot) {
  const fakeVscode = {
    workspace: {
      getConfiguration: () => ({ inspect: () => undefined, get: (_key, fallback) => fallback }),
      workspaceFolders: [{ uri: { fsPath: projectRoot } }]
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      withProgress: async (_options, callback) => callback()
    },
    commands: {
      registerCommand: () => ({ dispose() {} })
    },
    StatusBarAlignment: { Left: 1 },
    ProgressLocation: { Notification: 1 },
    Uri: { file: (fsPath) => ({ fsPath }) },
    Disposable: class {
      constructor(callback) {
        this.callback = callback;
      }
      dispose() {
        if (this.callback) {
          this.callback();
        }
      }
    }
  };

  const source = fs.readFileSync(extensionPath, "utf8");
  const sandboxRequire = (id) => {
    if (id === "vscode") {
      return fakeVscode;
    }
    if (id.startsWith(".")) {
      return require(path.resolve(moduleRoot, id));
    }
    return require(id);
  };
  const sandbox = {
    Buffer,
    clearInterval,
    console,
    exports: {},
    module: { exports: {} },
    process,
    require: sandboxRequire,
    setInterval,
    setTimeout,
    __dirname: moduleRoot,
    __filename: extensionPath
  };
  vm.runInNewContext(`${source}
output = { appendLine() {} };
module.exports.__test__ = {
  ensureGeneratedDirs,
  refreshGeneratedWatcherFiles,
  readBootstrapConversation,
  writeBootstrapConversation,
  renderBootstrapConversationMarkdown,
  writeBootstrapChangePreview,
  archiveAndResetBootstrapConversation,
  stageBootstrapDraftFiles,
  applyBootstrapDraftFiles,
  taskLooksInstantiated,
  codexHomePlan,
  ensureCodexHome,
  mergeWatcherConfigText,
  inspectWatcherHomeBootstrapState,
  seedWatcherHomeBootstrapFromProfilePaths,
  inspectProjectRuntimeClarity,
  readWatcherUnitDrift,
  systemdEnvValue,
  unitNames
};`, sandbox, {
    filename: extensionPath
  });
  return sandbox.module.exports.__test__;
}

function run(command, args, options) {
  return cp.execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function writeFile(projectRoot, relativePath, content) {
  const target = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeJson(projectRoot, relativePath, value) {
  writeFile(projectRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runRoute(projectRoot, env = {}) {
  const output = run("python3", [path.join(projectRoot, "agent", "bin", "route_skill.py")], {
    cwd: projectRoot,
    env: { ...process.env, ...env }
  });
  return JSON.parse(output);
}

function runRender(projectRoot, payload, env = {}) {
  const inputPath = path.join(projectRoot, "agent", "status", "render-input.json");
  writeJson(projectRoot, "agent/status/render-input.json", payload);
  run("python3", [path.join(projectRoot, "agent", "bin", "render_report.py"), inputPath], {
    cwd: projectRoot,
    env: { ...process.env, ...env }
  });
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-generated-"));
  const api = loadExtensionTestApi(projectRoot);
  await api.ensureGeneratedDirs(projectRoot);
  await api.refreshGeneratedWatcherFiles(projectRoot);

  const manifestPath = path.join(projectRoot, "agent", "status", "generated_manifest.json");
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.strictEqual(manifest.schema_version, 1);
  assert.strictEqual(manifest.control_plane_module, "codex-watchdog-vscode");
  assert.match(manifest.control_plane_version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.template_hashes["agent/bin/run_watchdog.sh"], /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.template_hashes["agent/schemas/bootstrap_conversation_turn.schema.json"], /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.template_hashes["agent/schemas/bootstrap_instantiation.schema.json"], /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.template_hashes["agent/schemas/secondary_skills.schema.json"], /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.template_hashes["agent/TASK_BOX.json"], /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.template_hashes["agent/ROUTE_CANONICAL.json"], /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.template_hashes["agent/EVIDENCE_LEDGER.jsonl"], /^sha256:[a-f0-9]{64}$/);
  assert.ok(manifest.placeholder_policy.public_paths.includes("$PROJECT_ROOT"));
  assert.ok(manifest.placeholder_policy.public_paths.includes("$CONTROL_PLANE_ROOT"));
  assert.ok(manifest.placeholder_policy.public_paths.includes("$COLLAB_ROOT"));
  assert.ok(!manifestText.includes("/home/chenma"));

  run("bash", ["-n", path.join(projectRoot, "agent", "bin", "run_watchdog.sh")]);
  run("bash", ["-n", path.join(projectRoot, "agent", "bin", "watchdog_timer.sh")]);
  run("bash", ["-n", path.join(projectRoot, "agent", "bin", "watchdog_guard.sh")]);
  run("python3", ["-m", "py_compile",
    path.join(projectRoot, "agent", "bin", "render_report.py"),
    path.join(projectRoot, "agent", "bin", "route_skill.py"),
    path.join(projectRoot, "agent", "bin", "validate_runtime.py")
  ]);

  const validateOutput = run(path.join(projectRoot, "agent", "bin", "watchdog"), ["validate"], {
    cwd: projectRoot
  });
  assert.match(validateOutput, /generated manifest ok:/);

  const watchSchema = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "schemas", "watch_decision.schema.json"), "utf8"));
  assert.deepStrictEqual(
    new Set(watchSchema.required),
    new Set(Object.keys(watchSchema.properties)),
    "watch_decision schema root required must include every root property for strict response_format validation"
  );
  assert.ok(watchSchema.required.includes("supervisor_mode"));
  assert.ok(watchSchema.required.includes("review_scope"));
  assert.ok(watchSchema.required.includes("review_resolver"));
  assert.ok(watchSchema.required.includes("secondary_skills_consulted"));
  assert.ok(watchSchema.required.includes("successor_task_draft"));
  assert.ok(watchSchema.required.includes("task_profile_draft"));
  assert.ok(watchSchema.required.includes("queue_request_draft"));
  assert.ok(watchSchema.required.includes("route_canonical_update"));
  assert.ok(watchSchema.required.includes("task_box_update"));

  const bootstrapSchema = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "schemas", "bootstrap_instantiation.schema.json"), "utf8"));
  assert.deepStrictEqual(
    new Set(bootstrapSchema.required),
    new Set(Object.keys(bootstrapSchema.properties)),
    "bootstrap_instantiation schema root required must include every property for strict response_format validation"
  );
  assert.ok(bootstrapSchema.required.includes("assistant_reply"));
  assert.ok(bootstrapSchema.required.includes("ready_for_start_guard"));

  const bootstrapConversationSchema = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "schemas", "bootstrap_conversation_turn.schema.json"), "utf8"));
  assert.deepStrictEqual(
    new Set(bootstrapConversationSchema.required),
    new Set(Object.keys(bootstrapConversationSchema.properties)),
    "bootstrap_conversation_turn schema root required must include every property for strict response_format validation"
  );
  assert.ok(bootstrapConversationSchema.required.includes("assistant_reply"));
  assert.ok(bootstrapConversationSchema.required.includes("suggested_next_step"));
  assert.ok(fs.existsSync(path.join(projectRoot, "agent", "TASK_BOX.json")));
  assert.ok(fs.existsSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json")));
  assert.ok(fs.existsSync(path.join(projectRoot, "agent", "EVIDENCE_LEDGER.jsonl")));
  assert.ok(fs.existsSync(path.join(projectRoot, "agent", "SECONDARY_SKILLS.example.json")));
  assert.ok(fs.existsSync(path.join(projectRoot, "agent", "skills", "project-secondary-example", "SKILL.example.md")));
  const initialTaskBox = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "TASK_BOX.json"), "utf8"));
  assert.ok(initialTaskBox.project_question);
  assert.ok(initialTaskBox.decision_relevance);
  assert.ok(initialTaskBox.claim_scope);
  assert.strictEqual(initialTaskBox.route_task_id, null);
  assert.ok(Array.isArray(initialTaskBox.forbidden_conclusions));
  assert.strictEqual(initialTaskBox.gate_policy.topic_alignment_check, true);
  assert.strictEqual(initialTaskBox.gate_policy.claim_scope_gate, true);
  assert.strictEqual(initialTaskBox.gate_policy.fair_comparability_gate, true);
  assert.strictEqual(initialTaskBox.gate_policy.value_of_information_gate, true);
  assert.strictEqual(initialTaskBox.gate_policy.successor_contract_gate, true);
  const initialRouteCanonical = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json"), "utf8"));
  assert.strictEqual(initialRouteCanonical.successor_contract_required, false);
  assert.strictEqual(initialRouteCanonical.exact_next_object_path, null);
  const initialStateJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(initialStateJson.route_task_id, null);
  const initialProgressJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "PROGRESS_STATE.json"), "utf8"));
  assert.strictEqual(initialProgressJson.route_task_id, null);

  await api.writeBootstrapConversation(projectRoot, {
    updated_at: "2026-06-04T12:00:00Z",
    draft_input: "请把这个项目初始化成 watchdog 项目。",
    turns: [
      { role: "user", text: "Please initialize this project as a watchdog bootstrap.", created_at: "2026-06-04T11:59:00Z" },
      { role: "assistant", text: "Drafted PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF for a read-only bootstrap.", created_at: "2026-06-04T12:00:00Z" }
    ],
    latest_result: {
      ready_for_start_guard: false,
      open_questions: ["Should Start Guard wait until after a manual readiness review?"],
      suggested_next_step: "Review the drafted files in the panel before starting the guard."
    }
  });
  const conversation = await api.readBootstrapConversation(projectRoot);
  assert.strictEqual(conversation.turns.length, 2);
  assert.strictEqual(conversation.turns[0].role, "user");
  assert.strictEqual(conversation.draft_input, "请把这个项目初始化成 watchdog 项目。");
  assert.strictEqual(conversation.latest_result.ready_for_start_guard, false);
  const transcriptMarkdown = fs.readFileSync(path.join(projectRoot, "agent", "status", "bootstrap_conversation.md"), "utf8");
  assert.match(transcriptMarkdown, /Bootstrap Conversation/);
  assert.match(transcriptMarkdown, /AI reply/);
  assert.match(transcriptMarkdown, /Should Start Guard wait until after a manual readiness review/);
  assert.match(api.renderBootstrapConversationMarkdown(conversation), /Latest Setup Status/);

  await api.writeBootstrapChangePreview(projectRoot, [
    {
      relativePath: "agent/PLAN.md",
      changed: true,
      previousLength: 12,
      nextLength: 48,
      preview: "# Plan\n\nConcrete watchdog bootstrap objective."
    },
    {
      relativePath: "agent/TODO.md",
      changed: false,
      previousLength: 32,
      nextLength: 32,
      preview: "# TODO\n\n- unchanged"
    }
  ]);
  const previewMarkdown = fs.readFileSync(path.join(projectRoot, "agent", "status", "bootstrap_change_preview.md"), "utf8");
  assert.match(previewMarkdown, /Bootstrap Change Preview/);
  assert.match(previewMarkdown, /agent\/PLAN\.md/);
  assert.match(previewMarkdown, /Status: updated/);

  writeFile(projectRoot, "agent/PLAN.md", "# PLAN\n\nTemplate placeholder.\n");
  writeFile(projectRoot, "agent/TODO.md", "# TODO\n\nTemplate placeholder.\n");
  writeFile(projectRoot, "agent/STATE.md", "# STATE\n\nTemplate placeholder.\n");
  writeFile(projectRoot, "agent/SAFETY.md", "# SAFETY\n\nTemplate placeholder.\n");
  writeFile(projectRoot, "agent/DAILY_HANDOFF.md", "# DAILY HANDOFF\n\nTemplate placeholder.\n");
  const templatePlanPath = path.join(projectRoot, "agent", "PLAN.md");
  const templatePlanBeforeDraft = fs.readFileSync(templatePlanPath, "utf8");
  await api.stageBootstrapDraftFiles(projectRoot, {
    assistant_reply: "Drafted the bootstrap files but did not apply them yet.",
    plan_md: "# PLAN\n\nConcrete bootstrap plan.\n",
    todo_md: "# TODO\n\n- [ ] First concrete task.\n",
    state_md: "# STATE\n\nBootstrap draft is ready.\n",
    safety_md: "# SAFETY\n\nRead-only bootstrap for now.\n",
    daily_handoff_md: "# DAILY HANDOFF\n\nNo guard start yet.\n",
    open_questions: ["Should the first guard cycle stay read-only?"],
    suggested_next_step: "Instantiate the project when the setup looks right.",
    ready_for_start_guard: false
  });
  const templatePlanAfterDraft = fs.readFileSync(templatePlanPath, "utf8");
  assert.strictEqual(templatePlanAfterDraft, templatePlanBeforeDraft, "staging a bootstrap draft must not write PLAN.md yet");
  await api.applyBootstrapDraftFiles(projectRoot, {
    assistant_reply: "Apply the same staged draft.",
    plan_md: "# PLAN\n\nConcrete bootstrap plan.\n",
    todo_md: "# TODO\n\n- [ ] First concrete task.\n",
    state_md: "# STATE\n\nBootstrap draft is ready.\n",
    safety_md: "# SAFETY\n\nRead-only bootstrap for now.\n",
    daily_handoff_md: "# DAILY HANDOFF\n\nNo guard start yet.\n",
    open_questions: [],
    suggested_next_step: "Review and start later.",
    ready_for_start_guard: false
  });
  const templatePlanAfterApply = fs.readFileSync(templatePlanPath, "utf8");
  assert.match(templatePlanAfterApply, /Concrete bootstrap plan/);
  assert.ok(api.taskLooksInstantiated(projectRoot), "concrete instantiated files should be accepted even if safety stays read-only");

  writeFile(projectRoot, "agent/SAFETY.md", [
    "<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->",
    "",
    "# Safety Policy",
    "",
    "Default watcher mode: read-only reasoning.",
    ""
  ].join("\n"));
  assert.ok(!api.taskLooksInstantiated(projectRoot), "template marker must still block Start Guard readiness");

  await api.archiveAndResetBootstrapConversation(projectRoot);
  const resetConversation = await api.readBootstrapConversation(projectRoot);
  assert.strictEqual(resetConversation.turns.length, 0);
  assert.strictEqual(resetConversation.latest_result.ready_for_start_guard, false);
  const archiveDir = path.join(projectRoot, "agent", "status", "bootstrap_archive");
  const archivedNames = fs.readdirSync(archiveDir);
  assert.ok(archivedNames.some((name) => name.endsWith("bootstrap_conversation.json")));
  assert.ok(archivedNames.some((name) => name.endsWith("bootstrap_change_preview.md")));

  const mergedWatcherConfig = api.mergeWatcherConfigText("[features]\nhooks = true\n", {
    model: "gpt-5.4",
    modelReasoningEffort: "xhigh"
  });
  assert.match(mergedWatcherConfig.text, /^approval_policy = "never"/m);
  assert.match(mergedWatcherConfig.text, /^sandbox_mode = "read-only"/m);
  assert.match(mergedWatcherConfig.text, /^allow_login_shell = false$/m);
  assert.match(mergedWatcherConfig.text, /^model = "gpt-5\.4"$/m);
  assert.match(mergedWatcherConfig.text, /^model_reasoning_effort = "xhigh"$/m);
  assert.match(mergedWatcherConfig.text, /^\[features\]\nhooks = true$/m);

  const legacyHooksConfig = api.mergeWatcherConfigText("codex_hooks = true\n", {
    model: "",
    modelReasoningEffort: ""
  });
  assert.doesNotMatch(legacyHooksConfig.text, /codex_hooks/);
  assert.match(legacyHooksConfig.text, /^hooks = true$/m);

  const watcherHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-home-"));
  const mainCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-main-home-"));
  try {
    writeFile("", path.join(mainCodexHome, "auth.json"), "{\n  \"token\": \"example\"\n}\n");
    writeFile("", path.join(mainCodexHome, "models_cache.json"), "{\n  \"models\": []\n}\n");
    writeFile("", path.join(watcherHome, "config.toml"), "approval_policy = \"never\"\n");
    let bootstrap = api.inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome);
    assert.strictEqual(bootstrap.authExists, false);
    assert.strictEqual(bootstrap.canSeedFromMainAuth, true);
    assert.match(bootstrap.bootstrapText, /does not have auth\.json yet/i);
    const seeded = await api.seedWatcherHomeBootstrapFromProfilePaths(watcherHome, mainCodexHome);
    assert.strictEqual(seeded.copiedAuth, true);
    assert.strictEqual(seeded.copiedModelsCache, true);
    bootstrap = api.inspectWatcherHomeBootstrapState(watcherHome, mainCodexHome);
    assert.strictEqual(bootstrap.authExists, true);
    assert.ok(fs.existsSync(path.join(watcherHome, "auth.json")));
    assert.ok(fs.existsSync(path.join(watcherHome, "models_cache.json")));
  } finally {
    fs.rmSync(watcherHome, { recursive: true, force: true });
    fs.rmSync(mainCodexHome, { recursive: true, force: true });
  }

  const realBoundRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-bind-real-"));
  const linkedRoot = path.join(os.homedir(), `.codex-watchdog-bind-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  let migratedWatcherHome = "";
  try {
    fs.symlinkSync(realBoundRoot, linkedRoot, "dir");
    writeJson(linkedRoot, ".vscode/settings.json", {
      "codexWatchdog.codexHome": path.join(linkedRoot, "agent", "runtime", "codex-home")
    });
    const bindApi = loadExtensionTestApi(linkedRoot);
    const bindPlan = bindApi.codexHomePlan(linkedRoot);
    migratedWatcherHome = bindPlan.effectivePath;
    assert.notStrictEqual(bindPlan.effectivePath, bindPlan.configuredPath, "bind-mounted project-local codexHome should migrate to a safe home-local watcher path");
    assert.ok(bindPlan.effectivePath.startsWith(path.join(os.homedir(), ".codex-watchers")), "migrated watcher home should stay under ~/.codex-watchers");
    await bindApi.ensureCodexHome(linkedRoot);
    const migratedSettings = JSON.parse(fs.readFileSync(path.join(linkedRoot, ".vscode", "settings.json"), "utf8"));
    assert.strictEqual(migratedSettings["codexWatchdog.codexHome"], bindPlan.effectivePath);
    const migratedConfigPath = path.join(bindPlan.effectivePath, "config.toml");
    assert.ok(fs.existsSync(migratedConfigPath), "ensureCodexHome should create the migrated watcher config");
    const migratedConfig = fs.readFileSync(migratedConfigPath, "utf8");
    assert.match(migratedConfig, /^approval_policy = "never"$/m);
    assert.match(migratedConfig, /^sandbox_mode = "read-only"$/m);
  } finally {
    try {
      fs.rmSync(linkedRoot, { recursive: true, force: true });
    } catch (_error) {}
    try {
      fs.rmSync(realBoundRoot, { recursive: true, force: true });
    } catch (_error) {}
    if (migratedWatcherHome) {
      try {
        fs.rmSync(migratedWatcherHome, { recursive: true, force: true });
      } catch (_error) {}
    }
  }

  const driftRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-drift-"));
  const driftUnitDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-units-"));
  try {
    const driftSettings = {
      codexBin: "/usr/bin/codex",
      codexHome: "/home/test/.codex-watchers/project-a",
      sandboxMode: "read-only",
      intervalMinutes: 30,
      timeoutMinutes: 25,
      compactEveryRuns: 6,
      role: "runner",
      phaseOffsetMinutes: 10,
      supervisorLightFollowup: true,
      supervisorAuditEveryRunnerRuns: 4
    };
    const driftUnits = api.unitNames(driftRoot);
    fs.writeFileSync(path.join(driftUnitDir, driftUnits.service), [
      "[Service]",
      `Environment=CODEX_BIN=${api.systemdEnvValue(driftSettings.codexBin)}`,
      `Environment=CODEX_HOME=${api.systemdEnvValue(driftSettings.codexHome)}`,
      `Environment=CODEX_SANDBOX_MODE=${api.systemdEnvValue(driftSettings.sandboxMode)}`,
      `Environment=WATCHDOG_TIMEOUT_MINUTES=${driftSettings.timeoutMinutes}`,
      `Environment=WATCHDOG_COMPACT_EVERY_RUNS=${driftSettings.compactEveryRuns}`,
      `Environment=WATCHDOG_ROLE=${api.systemdEnvValue(driftSettings.role)}`,
      `Environment=WATCHDOG_PHASE_OFFSET_MINUTES=${driftSettings.phaseOffsetMinutes}`,
      `Environment=WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=1`,
      `Environment=WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=${driftSettings.supervisorAuditEveryRunnerRuns}`,
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(driftUnitDir, driftUnits.timer), [
      "[Timer]",
      `OnActiveSec=${driftSettings.phaseOffsetMinutes}min`,
      `OnUnitActiveSec=${driftSettings.intervalMinutes}min`,
      ""
    ].join("\n"));
    let drift = api.readWatcherUnitDrift(driftRoot, driftSettings, driftUnitDir);
    assert.strictEqual(drift.needsReinstall, false, "matching units should not require reinstall");
    fs.writeFileSync(path.join(driftUnitDir, driftUnits.service), [
      "[Service]",
      `Environment=CODEX_BIN=${api.systemdEnvValue(driftSettings.codexBin)}`,
      `Environment=CODEX_HOME=${api.systemdEnvValue("/old/home/.codex-watchers/project-a")}`,
      `Environment=CODEX_SANDBOX_MODE=${api.systemdEnvValue(driftSettings.sandboxMode)}`,
      `Environment=WATCHDOG_TIMEOUT_MINUTES=${driftSettings.timeoutMinutes}`,
      `Environment=WATCHDOG_COMPACT_EVERY_RUNS=${driftSettings.compactEveryRuns}`,
      `Environment=WATCHDOG_ROLE=${api.systemdEnvValue(driftSettings.role)}`,
      `Environment=WATCHDOG_PHASE_OFFSET_MINUTES=5`,
      `Environment=WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=1`,
      `Environment=WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=${driftSettings.supervisorAuditEveryRunnerRuns}`,
      ""
    ].join("\n"));
    drift = api.readWatcherUnitDrift(driftRoot, driftSettings, driftUnitDir);
    assert.strictEqual(drift.needsReinstall, true, "stale unit files should require reinstall");
    assert.match(drift.text, /timer-install|Start Guard/i);
  } finally {
    fs.rmSync(driftRoot, { recursive: true, force: true });
    fs.rmSync(driftUnitDir, { recursive: true, force: true });
  }

  writeJson(projectRoot, "agent/RUN_STATE.json", {
    blocker_type: "stale_state"
  });
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: pending_send",
    "- pending_send: yes",
    "- requires_human_review: true",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/control/PAUSE", "Paused at: 2026-06-05T00:00:00Z\nReason: test pause\n");
  writeJson(projectRoot, "agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json", {
    timestamp_utc: "2026-06-05T01:00:00Z",
    reconciliation: { changed: true }
  });
  writeJson(projectRoot, "agent/queue/running/job.json", { status: "running" });
  writeJson(projectRoot, "agent/queue/failed/old.json", { status: "failed" });
  const runtimeClarity = api.inspectProjectRuntimeClarity(projectRoot);
  assert.match(runtimeClarity.queueText, /queued=0, running=1, done=0, failed=1/);
  assert.ok(runtimeClarity.signals.some((signal) => /PAUSE/.test(signal.text)));
  assert.ok(runtimeClarity.signals.some((signal) => /blocker_type=stale_state/.test(signal.text)));
  assert.ok(runtimeClarity.signals.some((signal) => /Review pending is active/.test(signal.text)));
  assert.ok(runtimeClarity.signals.some((signal) => /running and failed queue records coexist/i.test(signal.text)));
  assert.ok(runtimeClarity.signals.some((signal) => /reconciliation last ran/i.test(signal.text)));
  fs.rmSync(path.join(projectRoot, "agent", "control", "PAUSE"), { force: true });
  fs.rmSync(path.join(projectRoot, "agent", "status", "SUPERVISOR_STALE_STATE_RECONCILIATION.json"), { force: true });
  fs.rmSync(path.join(projectRoot, "agent", "queue", "running", "job.json"), { force: true });
  fs.rmSync(path.join(projectRoot, "agent", "queue", "failed", "old.json"), { force: true });
  writeJson(projectRoot, "agent/RUN_STATE.json", {
    blocker_type: "none"
  });

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "observer",
    requires_review: false,
    tasks: []
  });
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: none",
    "- pending_send: no",
    "- requires_human_review: false",
    "- scope: none",
    "- resolver: none",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/BLOCKERS.md", [
    "# Blockers",
    "",
    "Blocker type: none",
    "- Required: false",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/TODO.md", "# TODO\n\n- none\n");
  writeJson(projectRoot, "agent/queue/done/old-result.json", {
    job_id: "old",
    task_id: "old_task",
    created_utc: "2026-06-03T00:00:00Z",
    runner: "cpu",
    command_profile: "test",
    expected_outputs: ["agent/reports/old.md"],
    max_runtime_minutes: 1,
    status: "done"
  });
  const oldDonePath = path.join(projectRoot, "agent", "queue", "done", "old-result.json");
  const oldDate = new Date(Date.now() - 8 * 60 * 60 * 1000);
  fs.utimesSync(oldDonePath, oldDate, oldDate);
  let route = runRoute(projectRoot, { WATCHDOG_QUEUE_RESULT_FRESH_MINUTES: "240" });
  assert.notStrictEqual(route.primary_skill, "watchdog-gate-evaluator", "stale done result must not retrigger gate evaluator");

  const freshDate = new Date();
  fs.utimesSync(oldDonePath, freshDate, freshDate);
  route = runRoute(projectRoot, { WATCHDOG_QUEUE_RESULT_FRESH_MINUTES: "240" });
  assert.strictEqual(route.primary_skill, "watchdog-gate-evaluator", "fresh done result should trigger gate evaluator");
  fs.utimesSync(oldDonePath, oldDate, oldDate);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "observer",
    requires_review: false,
    tasks: [
      {
        task_id: "report_only_inventory",
        status: "pending",
        allowed_runner: "report_only",
        description: "Prepare a report-only inventory; do not execute jobs."
      }
    ]
  });
  writeFile(projectRoot, "agent/DAILY_HANDOFF.md", [
    "# Daily Handoff",
    "",
    "Historical note: a previous cycle mentioned review_required=true.",
    "This line is context, not an active review marker.",
    ""
  ].join("\n"));
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "report_only_inventory");
  assert.match(route.reason, /report-only task can proceed|autonomous mode allows one bounded report_only step/);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "observer",
    requires_review: false,
    tasks: []
  });
  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "task-box-autonomy",
    route_id: "route-autonomy",
    route_epoch: "route-001",
    requires_review: false,
    tasks: [
      {
        task_id: "task_box_cpu_probe",
        status: "pending",
        allowed_runner: "cpu",
        title: "Run one bounded CPU eval from TASK_BOX.json."
      }
    ]
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-autonomy",
    route_epoch: "route-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-001"
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "task_box_cpu_probe");
  assert.match(route.reason, /TASK_BOX\.json/);
  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "observer",
    requires_review: false,
    route_id: "route-autonomy",
    route_epoch: "route-001",
    tasks: [
      {
        task_id: "stale_state_report_only_task",
        status: "pending",
        allowed_runner: "report_only",
        description: "Old state task that should not outrank TASK_BOX."
      }
    ],
    blocked_actions: [],
    important_paths: []
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "task_box_cpu_probe");
  assert.match(route.reason, /TASK_BOX\.json/);
  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "observer",
    requires_review: false,
    tasks: []
  });
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: pending_send",
    "- requires_human_review: true",
    "- scope: external_review",
    "- resolver: human",
    ""
  ].join("\n"));
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "task_box_cpu_probe");
  assert.match(route.reason, /autonomous mode allows one bounded bounded_cpu_eval step/);
  writeFile(projectRoot, "agent/skills/project-local-discipline/SKILL.md", [
    "# Project Local Discipline",
    "",
    "Require comparability notes and explicit evidence hygiene for bounded CPU probes.",
    ""
  ].join("\n"));
  writeJson(projectRoot, "agent/SECONDARY_SKILLS.json", {
    schema_version: 1,
    skills: [
      {
        skill_id: "project-local-discipline",
        path: "agent/skills/project-local-discipline/SKILL.md",
        selectors: {
          primary_skills: ["watchdog-orchestrator"],
          roles: ["runner"],
          supervisor_modes: [],
          task_capabilities: ["bounded_cpu_eval"]
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.deepStrictEqual(route.secondary_skills, [
    {
      skill_id: "project-local-discipline",
      path: "agent/skills/project-local-discipline/SKILL.md"
    }
  ]);
  assert.strictEqual(route.route_capability, "bounded_cpu_eval");
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: none",
    "- pending_send: no",
    "- requires_human_review: false",
    "- scope: none",
    "- resolver: none",
    ""
  ].join("\n"));
  fs.unlinkSync(path.join(projectRoot, "agent", "SECONDARY_SKILLS.json"));
  writeJson(projectRoot, "agent/SECONDARY_SKILLS.json", {
    schema_version: 1,
    skills: [
      {
        skill_id: "broken-secondary-skill",
        path: "agent/skills/missing-secondary-skill/SKILL.md",
        selectors: {
          primary_skills: ["watchdog-orchestrator"],
          roles: ["runner"],
          supervisor_modes: [],
          task_capabilities: ["bounded_cpu_eval"]
        }
      }
    ]
  });
  let secondaryValidationError = null;
  try {
    run("python3", [path.join(projectRoot, "agent", "bin", "validate_runtime.py")], {
      cwd: projectRoot
    });
  } catch (error) {
    secondaryValidationError = error;
  }
  assert.ok(secondaryValidationError, "invalid SECONDARY_SKILLS.json should fail runtime validation");
  assert.match(
    String(secondaryValidationError.stderr || "") + String(secondaryValidationError.stdout || "") + String(secondaryValidationError.message || ""),
    /SECONDARY_SKILLS\.json/
  );
  fs.unlinkSync(path.join(projectRoot, "agent", "SECONDARY_SKILLS.json"));

  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-old"
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.match(route.reason, /Canonical route_epoch=route-001/);

  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-001"
  });
  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "queue-draft-box",
    route_id: "route-queue-draft",
    route_epoch: "route-queue-001",
    requires_review: false,
    tasks: [
      {
        task_id: "prepare_local_queue_draft",
        status: "pending",
        allowed_runner: "gpu",
        title: "Prepare queue draft only for a controlled GPU taskbox; do not enqueue yet."
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "prepare_local_queue_draft");

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "research-gate-box",
    route_id: "route-research-gate",
    route_epoch: "route-research-gate-001",
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: ["bounded_cpu_eval"],
    blocked_actions: [],
    forbidden_conclusions: [
      "Do not treat this exact CPU follow-up as a project-level superiority claim."
    ],
    allowed_write_paths: ["agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: [
      {
        task_id: "bounded_cpu_missing_research_contract",
        status: "pending",
        allowed_runner: "cpu",
        title: "Run one bounded CPU probe for the new route."
      }
    ]
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-research-gate",
    route_epoch: "route-research-gate-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-research-gate-001"
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "bounded_cpu_missing_research_contract");
  assert.match(route.reason, /missing research-contract fields/i);
  assert.match(route.stop_condition, /structured task contract/i);

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "research-gate-box",
    route_id: "route-research-gate",
    route_epoch: "route-research-gate-001",
    project_question: "Does the current CPU probe reduce uncertainty about the next route decision?",
    decision_relevance: "A positive result decides whether the route can proceed to the next bounded follow-up.",
    claim_scope: "bounded_cpu_diagnostic",
    forbidden_conclusions: ["Do not treat this CPU probe as a project-level superiority claim."],
    diagnosis_target: "carrier behavior",
    fair_comparability: {
      same_family_or_not: "same_family",
      same_budget_or_not: "same_budget",
      same_training_contract_or_not: "same_training_contract",
      same_eval_contract_or_not: "same_eval_contract"
    },
    value_of_information: {
      expected_information_gain: "medium",
      decision_change_if_positive: "Proceed to the next bounded follow-up.",
      decision_change_if_negative: "Pause this branch and re-evaluate the route.",
      cheaper_alternative_exists: false
    },
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: ["bounded_cpu_eval"],
    blocked_actions: [],
    forbidden_conclusions: [
      "Do not treat this exact CPU follow-up as a project-level superiority claim."
    ],
    allowed_write_paths: ["agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: [
      {
        task_id: "bounded_cpu_missing_research_contract",
        status: "pending",
        allowed_runner: "cpu",
        title: "Run one bounded CPU probe for the new route."
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "bounded_cpu_missing_research_contract");
  assert.match(route.reason, /autonomous mode allows one bounded bounded_cpu_eval step/i);

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "queue-enqueue-box",
    route_id: "route-queue-enqueue",
    route_epoch: "route-queue-enqueue-001",
    requires_review: false,
    allowed_actions: ["queue_enqueue"],
    blocked_actions: [],
    allowed_write_paths: ["agent/status/", "agent/queue/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: true
    },
    tasks: [
      {
        task_id: "controlled_queue_enqueue",
        status: "pending",
        allowed_runner: "gpu",
        title: "Enqueue exactly one bounded GPU task into the controlled queue.",
        queue_target: "gpu_queue",
        command_profile: "stage06_g1_profile",
        budget_contract: "one bounded queue job",
        expected_outputs: ["runs/stage06_g1/metrics.json"],
        max_runtime_minutes: 30
      }
    ]
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-queue-enqueue",
    route_epoch: "route-queue-enqueue-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-queue-enqueue-001"
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "controlled_queue_enqueue");
  assert.match(route.reason, /Autonomous queue policy allows one controlled queue enqueue/);

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "queue-enqueue-from-draft-box",
    route_id: "route-queue-enqueue-from-draft",
    route_epoch: "route-queue-enqueue-from-draft-001",
    requires_review: false,
    allowed_actions: ["queue_enqueue"],
    blocked_actions: [],
    allowed_write_paths: ["agent/status/", "agent/queue/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: true
    },
    tasks: [
      {
        task_id: "controlled_queue_enqueue_from_exact_draft",
        status: "pending",
        allowed_runner: "gpu",
        title: "Enqueue exactly one bounded GPU task into the controlled queue."
      }
    ]
  });
  writeJson(projectRoot, "agent/queue/drafts/controlled_queue_enqueue_from_exact_draft.json", {
    task_id: "controlled_queue_enqueue_from_exact_draft",
    queue_target: "gpu_queue",
    command_profile: "stage06_g1_profile_exact",
    expected_outputs: ["runs/stage06_g1_exact/metrics.json"],
    max_runtime_minutes: 35,
    budget_contract: "one bounded queue job"
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-queue-enqueue-from-draft",
    route_epoch: "route-queue-enqueue-from-draft-001",
    owner_mode: "fully_autonomous",
    requires_review: false,
    exact_next_task_id: "controlled_queue_enqueue_from_exact_draft",
    exact_queue_draft_path: "agent/queue/drafts/controlled_queue_enqueue_from_exact_draft.json"
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-queue-enqueue-from-draft-001"
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "controlled_queue_enqueue_from_exact_draft");
  assert.match(route.reason, /exact queue draft already defines queue target, profile, budget, timeout, and expected outputs/i);

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "queue-draft-fallback-box",
    route_id: "route-queue-draft-fallback",
    route_epoch: "route-queue-draft-fallback-001",
    requires_review: false,
    allowed_actions: ["queue_enqueue"],
    blocked_actions: [],
    allowed_write_paths: ["agent/status/", "agent/queue/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: [
      {
        task_id: "controlled_queue_draft_only",
        status: "pending",
        allowed_runner: "gpu",
        title: "Enqueue one bounded GPU task into the controlled queue once the contract is complete.",
        queue_target: "gpu_queue",
        command_profile: "stage06_g2_profile",
        budget_contract: "one bounded queue job",
        expected_outputs: ["runs/stage06_g2/metrics.json"],
        max_runtime_minutes: 25
      }
    ]
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-queue-draft-fallback",
    route_epoch: "route-queue-draft-fallback-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-queue-draft-fallback-001"
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "controlled_queue_draft_only");
  assert.match(route.reason, /prepare the exact queue\/profile draft locally/i);
  assert.match(route.stop_condition, /do not enqueue yet/i);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "observer",
    requires_review: false,
    tasks: []
  });
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: none",
    "- pending_send: no",
    "- requires_human_review: false",
    "- scope: none",
    "- resolver: none",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/BLOCKERS.md", [
    "# Blockers",
    "",
    "Blocker type: none",
    "- Required: false",
    "",
    "Use blocker types: env, queue, permission, reviewer, allowlist, pending_send, stale_state.",
    ""
  ].join("\n"));
  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "empty-box",
    route_id: "empty-route",
    route_epoch: "empty-001",
    requires_review: false,
    tasks: []
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "empty-route",
    route_epoch: "empty-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "empty-001"
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-handoff-writer");
  assert.match(route.reason, /No paused state/);
  assert.doesNotMatch(route.reason, /pending_send|permission|requires_review|REVIEW_PENDING/i);

  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: pending_send",
    "- requires_human_review: true",
    "- scope: external_review",
    "- resolver: human",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/TODO.md", [
    "# TODO",
    "",
    "- [ ] Pending report-only bookkeeping while external review is waiting.",
    ""
  ].join("\n"));
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.match(route.reason, /continue with one bounded next step/);

  writeFile(projectRoot, "agent/TODO.md", "# TODO\n\n- none\n");
  route = runRoute(projectRoot, { WATCHDOG_COMPACTION_DUE: "1" });
  assert.strictEqual(route.primary_skill, "watchdog-report-curator");
  assert.match(route.reason, /compaction cycle is due/i);

  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-handoff-writer");
  assert.match(route.reason, /REVIEW_PENDING\.md state=pending_send/);

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "route-old-box",
    route_id: "route-old",
    route_epoch: "route-001",
    requires_review: false,
    tasks: []
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-old",
    route_epoch: "route-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeFile(projectRoot, "agent/skills/research-comparability/SKILL.md", [
    "# Research Comparability",
    "",
    "Require explicit comparability notes when the route changes the active successor contract.",
    ""
  ].join("\n"));
  writeJson(projectRoot, "agent/status/SKILL_ROUTE.json", {
    primary_skill: "watchdog-orchestrator",
    secondary_skills: [
      {
        skill_id: "research-comparability",
        path: "agent/skills/research-comparability/SKILL.md"
      }
    ],
    reason: "Test render path for successor contract generation.",
    stop_condition: "Prepare one successor contract and stop.",
    permission_guardian_required: false,
    permission_guardian_result: "not_required",
    route_locked: true,
    task_id: "stage06_g1_followup"
  });
  assert.throws(() => runRender(projectRoot, {
    timestamp_utc: "2026-06-08T12:00:00Z",
    report_markdown: "# Report\n\nAccepted successor route and prepared the next exact contract.",
    overall_status: "active",
    report_type: "decision",
    primary_skill: "watchdog-orchestrator",
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "Accepted the successor route and materialized the next runnable object.",
    blocked_items: [],
    completed_items: ["Accepted successor route"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "execute_exact_successor",
      description: "Use the exact queue draft path for the next bounded task.",
      can_execute_automatically: true,
      reason: "The successor contract now has exact task, profile, and queue draft objects."
    },
    skill_stop_condition: "Prepare exactly one successor contract and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "Runtime state updated for successor route.",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: {
      task_id: "stage06_g1_followup",
      status: "pending",
      allowed_runner: "gpu",
      title: "Enqueue the next bounded GPU follow-up task."
    },
    task_profile_draft: {
      task_id: "stage06_g1_followup",
      profile_kind: "gpu_eval",
      entrypoint: "python scripts/run_stage06_g1.py"
    },
    queue_request_draft: {
      task_id: "stage06_g1_followup",
      queue_target: "gpu_queue",
      command_profile: "stage06_g1_followup",
      expected_outputs: ["runs/stage06_g1_followup/metrics.json"],
      max_runtime_minutes: 45,
      budget_contract: "one bounded queue job"
    },
    route_canonical_update: {
      route_id: "route-new",
      route_epoch: "route-002",
      owner_mode: "fully_autonomous",
      requires_review: false,
      active_carrier: "g1"
    }
  }), /secondary_skills_consulted mismatch/);
  runRender(projectRoot, {
    timestamp_utc: "2026-06-08T12:00:00Z",
    report_markdown: "# Report\n\nAccepted successor route and prepared the next exact contract.",
    overall_status: "active",
    report_type: "decision",
    primary_skill: "watchdog-orchestrator",
    secondary_skills_consulted: ["research-comparability"],
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "Accepted the successor route and materialized the next runnable object.",
    blocked_items: [],
    completed_items: ["Accepted successor route"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "execute_exact_successor",
      description: "Use the exact queue draft path for the next bounded task.",
      can_execute_automatically: true,
      reason: "The successor contract now has exact task, profile, and queue draft objects."
    },
    skill_stop_condition: "Prepare exactly one successor contract and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "Runtime state updated for successor route.",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: {
      task_id: "stage06_g1_followup",
      status: "pending",
      allowed_runner: "gpu",
      title: "Enqueue the next bounded GPU follow-up task."
    },
    task_profile_draft: {
      task_id: "stage06_g1_followup",
      profile_kind: "gpu_eval",
      entrypoint: "python scripts/run_stage06_g1.py"
    },
    queue_request_draft: {
      task_id: "stage06_g1_followup",
      queue_target: "gpu_queue",
      command_profile: "stage06_g1_followup",
      expected_outputs: ["runs/stage06_g1_followup/metrics.json"],
      max_runtime_minutes: 45,
      budget_contract: "one bounded queue job"
    },
    route_canonical_update: {
      route_id: "route-new",
      route_epoch: "route-002",
      owner_mode: "fully_autonomous",
      requires_review: false,
      active_carrier: "g1"
    }
  });
  const nextTaskDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "NEXT_TASK_DRAFT.json"), "utf8"));
  assert.strictEqual(nextTaskDraft.task_id, "stage06_g1_followup");
  const taskProfileDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "task_profiles", "stage06_g1_followup.json"), "utf8"));
  assert.strictEqual(taskProfileDraft.profile_kind, "gpu_eval");
  const queueDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "queue", "drafts", "stage06_g1_followup.json"), "utf8"));
  assert.strictEqual(queueDraft.queue_target, "gpu_queue");
  assert.strictEqual(queueDraft.status, "draft");
  const routeCanonical = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json"), "utf8"));
  assert.strictEqual(routeCanonical.route_id, "route-new");
  assert.strictEqual(routeCanonical.route_epoch, "route-002");
  assert.strictEqual(routeCanonical.exact_next_task_id, "stage06_g1_followup");
  assert.strictEqual(routeCanonical.exact_profile_path, "agent/task_profiles/stage06_g1_followup.json");
  assert.strictEqual(routeCanonical.exact_queue_draft_path, "agent/queue/drafts/stage06_g1_followup.json");
  assert.strictEqual(routeCanonical.required_successor_exactness, "queue_exact");
  assert.strictEqual(routeCanonical.successor_materialization_status, "queue_exact");
  assert.strictEqual(routeCanonical.experiment_gate_status, "not_required");
  const mirroredState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(mirroredState.route_id, "route-new");
  assert.strictEqual(mirroredState.route_epoch, "route-002");
  assert.strictEqual(mirroredState.exact_next_task_id, "stage06_g1_followup");
  assert.strictEqual(mirroredState.exact_profile_path, "agent/task_profiles/stage06_g1_followup.json");
  assert.strictEqual(mirroredState.exact_queue_draft_path, "agent/queue/drafts/stage06_g1_followup.json");
  assert.strictEqual(mirroredState.exact_next_object_path, "agent/queue/drafts/stage06_g1_followup.json");
  assert.strictEqual(mirroredState.required_successor_exactness, "queue_exact");
  assert.strictEqual(mirroredState.successor_materialization_status, "queue_exact");
  assert.strictEqual(mirroredState.experiment_gate_status, "not_required");
  assert.strictEqual(mirroredState.derived_from_route_canonical, true);
  const taskBox = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "TASK_BOX.json"), "utf8"));
  assert.strictEqual(taskBox.route_id, "route-new");
  assert.strictEqual(taskBox.route_epoch, "route-002");
  assert.strictEqual(taskBox.exact_profile_path, "agent/task_profiles/stage06_g1_followup.json");
  assert.strictEqual(taskBox.exact_queue_draft_path, "agent/queue/drafts/stage06_g1_followup.json");
  assert.strictEqual(taskBox.required_successor_exactness, "queue_exact");
  assert.strictEqual(taskBox.successor_materialization_status, "queue_exact");
  assert.ok(taskBox.tasks.some((task) => task.task_id === "stage06_g1_followup"));
  const queueProgressState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "PROGRESS_STATE.json"), "utf8"));
  assert.strictEqual(queueProgressState.exact_queue_draft_path, "agent/queue/drafts/stage06_g1_followup.json");
  assert.strictEqual(queueProgressState.required_successor_exactness, "queue_exact");
  assert.strictEqual(queueProgressState.successor_materialization_status, "queue_exact");
  const queueRunState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "RUN_STATE.json"), "utf8"));
  assert.strictEqual(queueRunState.exact_queue_draft_path, "agent/queue/drafts/stage06_g1_followup.json");
  assert.strictEqual(queueRunState.required_successor_exactness, "queue_exact");
  assert.strictEqual(queueRunState.successor_materialization_status, "queue_exact");
  const nextActionText = fs.readFileSync(path.join(projectRoot, "agent", "NEXT_ACTION.md"), "utf8");
  assert.match(nextActionText, /Exact next task: stage06_g1_followup/);
  assert.match(nextActionText, /Exact profile path: agent\/task_profiles\/stage06_g1_followup\.json/);
  assert.match(nextActionText, /Exact queue draft path: agent\/queue\/drafts\/stage06_g1_followup\.json/);
  assert.match(nextActionText, /Required successor exactness: queue_exact/);
  assert.match(nextActionText, /Successor materialization status: queue_exact/);
  assert.match(nextActionText, /Exact object path: agent\/queue\/drafts\/stage06_g1_followup\.json/);
  const currentStateText = fs.readFileSync(path.join(projectRoot, "agent", "CURRENT_STATE.md"), "utf8");
  assert.match(currentStateText, /Route ID: route-new/);
  assert.match(currentStateText, /Secondary skills: research-comparability/);
  assert.match(currentStateText, /Exact queue draft path: agent\/queue\/drafts\/stage06_g1_followup\.json/);
  assert.match(currentStateText, /Required successor exactness: queue_exact/);
  assert.match(currentStateText, /Exact next object: agent\/queue\/drafts\/stage06_g1_followup\.json/);
  const evidenceLedgerLines = fs.readFileSync(path.join(projectRoot, "agent", "EVIDENCE_LEDGER.jsonl"), "utf8").trim().split("\n");
  const latestLedgerEntry = JSON.parse(evidenceLedgerLines[evidenceLedgerLines.length - 1]);
  assert.ok(latestLedgerEntry.output_paths.includes("agent/status/NEXT_TASK_DRAFT.json"));
  assert.ok(latestLedgerEntry.output_paths.includes("agent/task_profiles/stage06_g1_followup.json"));
  assert.ok(latestLedgerEntry.output_paths.includes("agent/queue/drafts/stage06_g1_followup.json"));
  assert.deepStrictEqual(latestLedgerEntry.secondary_skills_consulted, ["research-comparability"]);
  assert.strictEqual(latestLedgerEntry.claim_scope, null);
  assert.strictEqual(latestLedgerEntry.successor_contract_generated, true);
  assert.strictEqual(latestLedgerEntry.exact_next_object_path, "agent/queue/drafts/stage06_g1_followup.json");

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "auto-successor-box",
    route_id: "route-auto",
    route_epoch: "route-auto-001",
    requires_review: false,
    allowed_actions: ["queue_enqueue"],
    blocked_actions: [],
    allowed_write_paths: ["agent/status/", "agent/reports/", "agent/task_profiles/", "agent/queue/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: true
    },
    tasks: []
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-auto",
    route_epoch: "route-auto-001",
    owner_mode: "fully_autonomous",
    requires_review: false,
    current_allowed_step: "queue_enqueue",
    current_budget_contract: "one bounded queue job"
  });
  runRender(projectRoot, {
    timestamp_utc: "2026-06-08T13:00:00Z",
    report_markdown: "# Report\n\nAccepted the route switch and automatically materialized the next queue-bound successor contract.",
    overall_status: "active",
    report_type: "progress",
    primary_skill: "watchdog-orchestrator",
    secondary_skills_consulted: ["research-comparability"],
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "Accepted the route shift and auto-created the exact follow-up queue contract.",
    blocked_items: [],
    completed_items: ["Accepted successor route"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "safe_script_candidate",
      description: "Enqueue exactly one bounded GPU follow-up for the accepted route.",
      can_execute_automatically: true,
      reason: "The route changed and the next bounded step should go through the controlled GPU queue."
    },
    skill_stop_condition: "Materialize one exact successor contract and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "Runtime state updated for automatic successor materialization.",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: null,
    task_profile_draft: null,
    queue_request_draft: null,
    route_canonical_update: {
      route_id: "route-auto",
      route_epoch: "route-auto-002",
      owner_mode: "fully_autonomous",
      requires_review: false,
      current_allowed_step: "queue_enqueue",
      exact_next_task_id: "route_auto_gpu_followup",
      successor_contract_required: true
    },
    task_box_update: {
      project_question: "Does one more bounded GPU follow-up change whether this route stays primary?",
      decision_relevance: "A positive result keeps the route alive; a negative result demotes it.",
      claim_scope: "bounded_gpu_diagnostic",
      diagnosis_target: "successor queue viability",
      fair_comparability: {
        same_family_or_not: "same_family",
        same_budget_or_not: "same_budget",
        same_training_contract_or_not: "same_training_contract",
        same_eval_contract_or_not: "same_eval_contract"
      },
      value_of_information: {
        expected_information_gain: "medium",
        decision_change_if_positive: "Keep the route alive for one more bounded queue cycle.",
        decision_change_if_negative: "Demote the route and choose a replacement.",
        cheaper_alternative_exists: false
      }
    }
  });
  const autoSuccessorDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "NEXT_TASK_DRAFT.json"), "utf8"));
  assert.strictEqual(autoSuccessorDraft.task_id, "route_auto_gpu_followup");
  assert.strictEqual(autoSuccessorDraft.kind, "queue_enqueue");
  assert.strictEqual(autoSuccessorDraft.queue_target, "gpu_queue");
  assert.strictEqual(autoSuccessorDraft.command_profile, "route_auto_gpu_followup");
  assert.strictEqual(autoSuccessorDraft.budget_contract, "one bounded queue job");
  assert.deepStrictEqual(autoSuccessorDraft.expected_outputs, ["runs/route_auto_gpu_followup/metrics.json"]);
  const autoProfileDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "task_profiles", "route_auto_gpu_followup.json"), "utf8"));
  assert.strictEqual(autoProfileDraft.profile_kind, "gpu_queue_followup");
  const autoQueueDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "queue", "drafts", "route_auto_gpu_followup.json"), "utf8"));
  assert.strictEqual(autoQueueDraft.queue_target, "gpu_queue");
  assert.strictEqual(autoQueueDraft.command_profile, "route_auto_gpu_followup");
  assert.deepStrictEqual(autoQueueDraft.expected_outputs, ["runs/route_auto_gpu_followup/metrics.json"]);
  const autoRouteCanonical = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json"), "utf8"));
  assert.strictEqual(autoRouteCanonical.exact_next_task_id, "route_auto_gpu_followup");
  assert.strictEqual(autoRouteCanonical.exact_profile_path, "agent/task_profiles/route_auto_gpu_followup.json");
  assert.strictEqual(autoRouteCanonical.exact_queue_draft_path, "agent/queue/drafts/route_auto_gpu_followup.json");
  assert.strictEqual(autoRouteCanonical.exact_next_object_path, "agent/queue/drafts/route_auto_gpu_followup.json");
  assert.strictEqual(autoRouteCanonical.required_successor_exactness, "queue_exact");
  assert.strictEqual(autoRouteCanonical.successor_materialization_status, "queue_exact");
  const autoStateMirror = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(autoStateMirror.route_id, "route-auto");
  assert.strictEqual(autoStateMirror.route_epoch, "route-auto-002");
  assert.strictEqual(autoStateMirror.exact_next_task_id, "route_auto_gpu_followup");
  assert.strictEqual(autoStateMirror.exact_queue_draft_path, "agent/queue/drafts/route_auto_gpu_followup.json");
  assert.strictEqual(autoStateMirror.required_successor_exactness, "queue_exact");
  assert.strictEqual(autoStateMirror.successor_materialization_status, "queue_exact");
  assert.strictEqual(autoStateMirror.exact_next_object_path, "agent/queue/drafts/route_auto_gpu_followup.json");
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.task_id, "route_auto_gpu_followup");
  assert.match(route.reason, /exact queue draft already defines queue target, profile, budget, timeout, and expected outputs/i);

  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: null,
    next_safe_action: { kind: "none", description: "", reason: "" }
  });
  writeJson(projectRoot, "agent/RUN_STATE.json", {
    schema_version: 1,
    blocker_type: "none",
    requires_human_review: false,
    next_action: { kind: "none", description: "", reason: "" }
  });
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: none",
    "- pending_send: no",
    "- requires_human_review: false",
    "- scope: none",
    "- resolver: none",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/BLOCKERS.md", [
    "# Blockers",
    "",
    "Blocker type: none",
    "- Required: false",
    ""
  ].join("\n"));

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "route-local-copy-box",
    route_id: "route-local-copy",
    route_epoch: "route-local-copy-001",
    requires_review: false,
    allowed_actions: ["local_workspace_copy"],
    blocked_actions: [],
    allowed_write_paths: ["workspace/", "runs/", "agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: []
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-local-copy",
    route_epoch: "route-local-copy-001",
    owner_mode: "fully_autonomous",
    requires_review: false,
    current_allowed_step: "local_workspace_copy"
  });
  runRender(projectRoot, {
    timestamp_utc: "2026-06-08T13:15:00Z",
    report_markdown: "# Report\n\nAccepted the route shift and auto-created the next local workspace copy successor contract.",
    overall_status: "active",
    report_type: "progress",
    primary_skill: "watchdog-orchestrator",
    secondary_skills_consulted: [],
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "Accepted the route shift and prepared a project-local copy successor task.",
    blocked_items: [],
    completed_items: ["Accepted local workspace successor route"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "safe_script_candidate",
      description: "Create one local workspace copy follow-up and keep shared files untouched.",
      can_execute_automatically: true,
      reason: "The route changed and the next bounded step should run inside a project-local workspace copy."
    },
    skill_stop_condition: "Materialize one exact local workspace successor contract and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "Runtime state updated for local workspace successor materialization.",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: null,
    task_profile_draft: null,
    queue_request_draft: null,
    route_canonical_update: {
      route_id: "route-local-copy",
      route_epoch: "route-local-copy-002",
      owner_mode: "fully_autonomous",
      requires_review: false,
      current_allowed_step: "local_workspace_copy",
      exact_next_task_id: "route_local_copy_followup",
      successor_contract_required: true
    },
    task_box_update: {
      project_question: "Does one local workspace copy follow-up reduce uncertainty about whether this route should continue?",
      decision_relevance: "A positive result keeps the route alive; a negative one demotes it.",
      claim_scope: "local_workspace_adapter",
      diagnosis_target: "successor local-workspace viability",
      fair_comparability: {
        same_family_or_not: "same_family",
        same_budget_or_not: "same_budget",
        same_training_contract_or_not: "same_training_contract",
        same_eval_contract_or_not: "same_eval_contract"
      },
      value_of_information: {
        expected_information_gain: "medium",
        decision_change_if_positive: "Keep the route alive for one more bounded local adaptation cycle.",
        decision_change_if_negative: "Demote the route and choose a replacement.",
        cheaper_alternative_exists: false
      }
    }
  });
  const localCopyDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "NEXT_TASK_DRAFT.json"), "utf8"));
  assert.strictEqual(localCopyDraft.task_id, "route_local_copy_followup");
  assert.strictEqual(localCopyDraft.kind, "local_workspace_copy");
  assert.strictEqual(localCopyDraft.workspace_mode, "project_local_copy");
  assert.strictEqual(localCopyDraft.workspace_root, "workspace/route_local_copy_followup/");
  assert.strictEqual(localCopyDraft.max_runtime_minutes, 20);
  assert.strictEqual(localCopyDraft.budget_contract, "one bounded cpu follow-up");
  assert.deepStrictEqual(localCopyDraft.expected_outputs, ["workspace/route_local_copy_followup/", "agent/reports/route_local_copy_followup.md"]);
  const localCopyProfile = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "task_profiles", "route_local_copy_followup.json"), "utf8"));
  assert.strictEqual(localCopyProfile.profile_kind, "local_workspace_copy");
  assert.strictEqual(localCopyProfile.workspace_mode, "project_local_copy");
  assert.strictEqual(localCopyProfile.workspace_root, "workspace/route_local_copy_followup/");
  assert.strictEqual(localCopyProfile.max_runtime_minutes, 20);
  assert.strictEqual(localCopyProfile.budget_contract, "one bounded cpu follow-up");
  const localCopyRouteCanonical = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json"), "utf8"));
  assert.strictEqual(localCopyRouteCanonical.exact_profile_path, "agent/task_profiles/route_local_copy_followup.json");
  assert.strictEqual(localCopyRouteCanonical.exact_next_object_path, "agent/task_profiles/route_local_copy_followup.json");
  assert.strictEqual(localCopyRouteCanonical.required_successor_exactness, "profile_exact");
  assert.strictEqual(localCopyRouteCanonical.successor_materialization_status, "profile_exact");
  const localCopyStateMirror = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(localCopyStateMirror.mode, "project-local-worker");
  assert.strictEqual(localCopyStateMirror.exact_next_task_id, "route_local_copy_followup");
  assert.strictEqual(localCopyStateMirror.exact_profile_path, "agent/task_profiles/route_local_copy_followup.json");
  assert.strictEqual(localCopyStateMirror.required_successor_exactness, "profile_exact");
  assert.strictEqual(localCopyStateMirror.successor_materialization_status, "profile_exact");
  assert.strictEqual(localCopyStateMirror.exact_next_object_path, "agent/task_profiles/route_local_copy_followup.json");
  const localCopyNextAction = fs.readFileSync(path.join(projectRoot, "agent", "NEXT_ACTION.md"), "utf8");
  assert.match(localCopyNextAction, /Exact profile path: agent\/task_profiles\/route_local_copy_followup\.json/);
  assert.match(localCopyNextAction, /Required successor exactness: profile_exact/);
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.task_id, "route_local_copy_followup");
  assert.match(route.reason, /exact profile already defines workspace root, write paths, budget, timeout, and expected outputs/i);

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "fallback-successor-box",
    route_id: "route-fallback",
    route_epoch: "route-fallback-001",
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: ["bounded_cpu_eval"],
    blocked_actions: [],
    forbidden_conclusions: [
      "Do not treat this exact CPU follow-up as a project-level superiority claim."
    ],
    allowed_write_paths: ["agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: []
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-fallback",
    route_epoch: "route-fallback-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeJson(projectRoot, "agent/status/SKILL_ROUTE.json", {
    primary_skill: "watchdog-orchestrator",
    reason: "Test successor fallback synthesis.",
    stop_condition: "Prepare one fallback successor contract and stop.",
    permission_guardian_required: false,
    permission_guardian_result: "not_required",
    route_locked: true,
    task_id: "route_fallback_cpu_followup"
  });
  runRender(projectRoot, {
    timestamp_utc: "2026-06-11T12:00:00Z",
    report_markdown: "# Report\n\nThe route changed and now needs one exact successor object.",
    overall_status: "active",
    report_type: "progress",
    primary_skill: "watchdog-orchestrator",
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "A route-level decision was made and the fallback successor contract should now exist.",
    blocked_items: [],
    completed_items: ["Accepted a route-level successor decision"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "safe_script_candidate",
      description: "Run one bounded CPU follow-up probe for the new route.",
      can_execute_automatically: true,
      reason: "The route now needs an exact bounded follow-up task."
    },
    skill_stop_condition: "Create the successor contract and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "Runtime state updated for fallback successor synthesis.",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: null,
    task_profile_draft: null,
    queue_request_draft: null,
    route_canonical_update: {
      route_id: "route-fallback",
      route_epoch: "route-fallback-002",
      owner_mode: "fully_autonomous",
      requires_review: false,
      current_allowed_step: "cpu_followup",
      exact_next_task_id: "route_fallback_cpu_followup",
      successor_contract_required: true
    },
    task_box_update: {
      project_question: "Does the CPU follow-up reduce uncertainty about whether this route should continue?",
      decision_relevance: "A positive result keeps the route alive; a negative one demotes it.",
      claim_scope: "bounded_cpu_diagnostic",
      forbidden_conclusions: ["Do not treat this follow-up as a project-level win."],
      diagnosis_target: "successor route viability",
      fair_comparability: {
        same_family_or_not: "same_family",
        same_budget_or_not: "same_budget",
        same_training_contract_or_not: "same_training_contract",
        same_eval_contract_or_not: "same_eval_contract"
      },
      value_of_information: {
        expected_information_gain: "medium",
        decision_change_if_positive: "Keep the route alive for one more bounded cycle.",
        decision_change_if_negative: "Demote this route and draft a replacement.",
        cheaper_alternative_exists: false
      }
    }
  });
  const fallbackDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "NEXT_TASK_DRAFT.json"), "utf8"));
  assert.strictEqual(fallbackDraft.task_id, "route_fallback_cpu_followup");
  assert.strictEqual(fallbackDraft.allowed_runner, "cpu");
  assert.strictEqual(fallbackDraft.kind, "bounded_cpu_eval");
  assert.strictEqual(fallbackDraft.budget_contract, "one bounded cpu follow-up");
  assert.strictEqual(fallbackDraft.successor_contract_inferred, true);
  const fallbackRouteCanonical = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json"), "utf8"));
  assert.strictEqual(fallbackRouteCanonical.route_epoch, "route-fallback-002");
  assert.strictEqual(fallbackRouteCanonical.successor_contract_required, false);
  assert.strictEqual(fallbackRouteCanonical.exact_profile_path, "agent/task_profiles/route_fallback_cpu_followup.json");
  assert.strictEqual(fallbackRouteCanonical.exact_next_object_path, "agent/task_profiles/route_fallback_cpu_followup.json");
  assert.strictEqual(fallbackRouteCanonical.required_successor_exactness, "profile_exact");
  assert.strictEqual(fallbackRouteCanonical.successor_materialization_status, "profile_exact");
  const fallbackProfile = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "task_profiles", "route_fallback_cpu_followup.json"), "utf8"));
  assert.strictEqual(fallbackProfile.profile_kind, "cpu_followup");
  const fallbackTaskBox = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "TASK_BOX.json"), "utf8"));
  assert.strictEqual(fallbackTaskBox.project_question, "Does the CPU follow-up reduce uncertainty about whether this route should continue?");
  assert.ok(fallbackTaskBox.tasks.some((task) => task.task_id === "route_fallback_cpu_followup"));
  const fallbackCurrentState = fs.readFileSync(path.join(projectRoot, "agent", "CURRENT_STATE.md"), "utf8");
  assert.match(fallbackCurrentState, /Project question: Does the CPU follow-up reduce uncertainty/i);
  assert.match(fallbackCurrentState, /Exact profile path: agent\/task_profiles\/route_fallback_cpu_followup\.json/);
  assert.match(fallbackCurrentState, /Required successor exactness: profile_exact/);
  assert.match(fallbackCurrentState, /Exact next object: agent\/task_profiles\/route_fallback_cpu_followup\.json/);
  const fallbackNextAction = fs.readFileSync(path.join(projectRoot, "agent", "NEXT_ACTION.md"), "utf8");
  assert.match(fallbackNextAction, /Exact profile path: agent\/task_profiles\/route_fallback_cpu_followup\.json/);
  assert.match(fallbackNextAction, /Successor materialization status: profile_exact/);
  assert.match(fallbackNextAction, /Decision relevance: A positive result keeps the route alive/i);
  assert.match(fallbackNextAction, /Claim scope: bounded_cpu_diagnostic/);
  const fallbackStateMirror = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(fallbackStateMirror.exact_next_task_id, "route_fallback_cpu_followup");
  assert.strictEqual(fallbackStateMirror.exact_profile_path, "agent/task_profiles/route_fallback_cpu_followup.json");
  assert.strictEqual(fallbackStateMirror.required_successor_exactness, "profile_exact");
  assert.strictEqual(fallbackStateMirror.successor_materialization_status, "profile_exact");
  assert.strictEqual(fallbackStateMirror.exact_next_object_path, "agent/task_profiles/route_fallback_cpu_followup.json");
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.task_id, "route_fallback_cpu_followup");
  assert.match(route.reason, /exact profile already defines budget, timeout, and expected outputs/i);
  runRender(projectRoot, {
    timestamp_utc: "2026-06-11T12:10:00Z",
    report_markdown: "# Report\n\nThe route is still blocked by the experiment decision gate, so successor materialization must stay pending.",
    overall_status: "blocked",
    report_type: "progress",
    primary_skill: "watchdog-orchestrator",
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "The experiment gate is explicit, but the next successor should not materialize beyond the gate boundary yet.",
    blocked_items: ["experiment_decision_gate_required"],
    completed_items: [],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json", "agent/TASK_BOX.json"],
    progress_changed: false,
    no_progress_cycles: 1,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "state_reconcile",
      description: "Keep the route contract explicit while waiting for the experiment decision gate to clear.",
      can_execute_automatically: true,
      reason: "The gate is defined, but successor materialization must remain blocked until the gate decision is ready."
    },
    skill_stop_condition: "Record the gate-blocked successor state and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: null,
    task_profile_draft: null,
    queue_request_draft: null,
    route_canonical_update: {
      route_id: "route-fallback",
      route_epoch: "route-fallback-003",
      owner_mode: "fully_autonomous",
      requires_review: false,
      current_allowed_step: "queue_enqueue",
      exact_next_task_id: "route_fallback_gpu_after_gate",
      successor_contract_required: true,
      experiment_decision_gate: {
        required: true,
        blocking: true
      }
    },
    task_box_update: {
      project_question: "Does the gate-clearing experiment justify queueing the next GPU follow-up?",
      decision_relevance: "Only after the gate clears should the queue successor become exact.",
      claim_scope: "gate_blocked_successor",
      diagnosis_target: "experiment gate readiness",
      experiment_decision_gate: {
        required: true,
        blocking: true
      }
    }
  });
  const gateBlockedRoute = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json"), "utf8"));
  assert.strictEqual(gateBlockedRoute.required_successor_exactness, "queue_exact");
  assert.strictEqual(gateBlockedRoute.experiment_gate_status, "blocked");
  assert.strictEqual(gateBlockedRoute.successor_materialization_status, "blocked_by_experiment_gate");
  assert.strictEqual(gateBlockedRoute.exact_profile_path, null);
  assert.strictEqual(gateBlockedRoute.exact_queue_draft_path, null);
  assert.strictEqual(gateBlockedRoute.exact_next_object_path, null);
  const gateBlockedTaskBox = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "TASK_BOX.json"), "utf8"));
  assert.strictEqual(gateBlockedTaskBox.experiment_gate_status, "blocked");
  assert.strictEqual(gateBlockedTaskBox.successor_materialization_status, "blocked_by_experiment_gate");
  assert.strictEqual(gateBlockedTaskBox.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateBlockedTaskBox.exact_profile_path, null);
  assert.strictEqual(gateBlockedTaskBox.exact_queue_draft_path, null);
  assert.strictEqual(gateBlockedTaskBox.exact_next_object_path, null);
  const gateBlockedState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(gateBlockedState.required_successor_exactness, "queue_exact");
  assert.strictEqual(gateBlockedState.successor_contract_required, true);
  assert.strictEqual(gateBlockedState.active_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateBlockedState.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateBlockedState.experiment_gate_status, "blocked");
  assert.strictEqual(gateBlockedState.successor_materialization_status, "blocked_by_experiment_gate");
  assert.strictEqual(gateBlockedState.exact_profile_path, null);
  assert.strictEqual(gateBlockedState.exact_queue_draft_path, null);
  assert.strictEqual(gateBlockedState.exact_next_object_path, null);
  const gateBlockedProgress = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "PROGRESS_STATE.json"), "utf8"));
  assert.strictEqual(gateBlockedProgress.successor_contract_required, true);
  assert.strictEqual(gateBlockedProgress.active_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateBlockedProgress.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateBlockedProgress.experiment_gate_status, "blocked");
  assert.strictEqual(gateBlockedProgress.successor_materialization_status, "blocked_by_experiment_gate");
  assert.strictEqual(gateBlockedProgress.exact_profile_path, null);
  assert.strictEqual(gateBlockedProgress.exact_queue_draft_path, null);
  assert.strictEqual(gateBlockedProgress.exact_next_object_path, null);
  const gateBlockedRunState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "RUN_STATE.json"), "utf8"));
  assert.strictEqual(gateBlockedRunState.successor_contract_required, true);
  assert.strictEqual(gateBlockedRunState.active_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateBlockedRunState.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateBlockedRunState.experiment_gate_status, "blocked");
  assert.strictEqual(gateBlockedRunState.successor_materialization_status, "blocked_by_experiment_gate");
  assert.strictEqual(gateBlockedRunState.exact_profile_path, null);
  assert.strictEqual(gateBlockedRunState.exact_queue_draft_path, null);
  assert.strictEqual(gateBlockedRunState.exact_next_object_path, null);
  const gateBlockedNextAction = fs.readFileSync(path.join(projectRoot, "agent", "NEXT_ACTION.md"), "utf8");
  assert.match(gateBlockedNextAction, /Required successor exactness: queue_exact/);
  assert.match(gateBlockedNextAction, /Successor materialization status: blocked_by_experiment_gate/);
  assert.match(gateBlockedNextAction, /Experiment gate status: blocked/);
  assert.match(gateBlockedNextAction, /Successor contract required: true/);
  assert.match(gateBlockedNextAction, /Canonical active task: route_fallback_gpu_after_gate/);
  assert.match(gateBlockedNextAction, /Route-selected task: route_fallback_gpu_after_gate/);
  assert.match(gateBlockedNextAction, /Exact profile path: none/);
  assert.match(gateBlockedNextAction, /Exact queue draft path: none/);
  assert.match(gateBlockedNextAction, /Exact object path: none/);
  const gateBlockedCurrentState = fs.readFileSync(path.join(projectRoot, "agent", "CURRENT_STATE.md"), "utf8");
  assert.match(gateBlockedCurrentState, /Successor contract required: true/);
  assert.match(gateBlockedCurrentState, /Canonical active task: route_fallback_gpu_after_gate/);
  assert.match(gateBlockedCurrentState, /Route-selected task: route_fallback_gpu_after_gate/);
  assert.match(gateBlockedCurrentState, /Exact profile path: none/);
  assert.match(gateBlockedCurrentState, /Exact queue draft path: none/);
  assert.match(gateBlockedCurrentState, /Exact next object: none/);
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.match(route.reason, /experiment decision gate is explicitly blocked/i);
  assert.doesNotMatch(route.reason, /exact queue draft already defines/i);

  runRender(projectRoot, {
    timestamp_utc: "2026-06-11T12:12:00Z",
    report_markdown: "# Report\n\nThe experiment gate is now clear enough to continue, but the exact queue successor still needs to be materialized.",
    overall_status: "active",
    report_type: "progress",
    primary_skill: "watchdog-orchestrator",
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "The gate cleared, but the queue successor contract is still not exact.",
    blocked_items: [],
    completed_items: ["Cleared the experiment decision gate blocker"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json", "agent/TASK_BOX.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "state_reconcile",
      description: "Materialize one exact queue successor now that the experiment gate is clear.",
      can_execute_automatically: true,
      reason: "The gate no longer blocks the route, but the queue successor still lacks an exact queue draft."
    },
    skill_stop_condition: "Restore exact successor contract coherence and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: null,
    task_profile_draft: null,
    queue_request_draft: null,
    route_canonical_update: {
      route_id: "route-fallback",
      route_epoch: "route-fallback-004",
      owner_mode: "fully_autonomous",
      requires_review: false,
      current_allowed_step: "queue_enqueue",
      exact_next_task_id: "route_fallback_gpu_after_gate",
      experiment_decision_gate: {
        required: true,
        blocking: false
      }
    },
    task_box_update: {
      experiment_decision_gate: {
        required: true,
        blocking: false
      }
    }
  });
  const gateReadyRoute = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "ROUTE_CANONICAL.json"), "utf8"));
  assert.strictEqual(gateReadyRoute.experiment_gate_status, "required_ready");
  assert.strictEqual(gateReadyRoute.required_successor_exactness, "queue_exact");
  assert.strictEqual(gateReadyRoute.successor_materialization_status, "queue_exact");
  assert.strictEqual(gateReadyRoute.successor_contract_required, false);
  assert.strictEqual(gateReadyRoute.exact_profile_path, "agent/task_profiles/route_fallback_gpu_after_gate.json");
  assert.strictEqual(gateReadyRoute.exact_queue_draft_path, "agent/queue/drafts/route_fallback_gpu_after_gate.json");
  assert.strictEqual(gateReadyRoute.exact_next_object_path, "agent/queue/drafts/route_fallback_gpu_after_gate.json");
  const gateReadyTaskBox = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "TASK_BOX.json"), "utf8"));
  assert.strictEqual(gateReadyTaskBox.experiment_gate_status, "required_ready");
  assert.strictEqual(gateReadyTaskBox.successor_materialization_status, "queue_exact");
  assert.strictEqual(gateReadyTaskBox.successor_contract_required, false);
  assert.strictEqual(gateReadyTaskBox.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateReadyTaskBox.exact_profile_path, "agent/task_profiles/route_fallback_gpu_after_gate.json");
  assert.strictEqual(gateReadyTaskBox.exact_queue_draft_path, "agent/queue/drafts/route_fallback_gpu_after_gate.json");
  const gateReadyState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(gateReadyState.successor_contract_required, false);
  assert.strictEqual(gateReadyState.active_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateReadyState.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateReadyState.experiment_gate_status, "required_ready");
  assert.strictEqual(gateReadyState.successor_materialization_status, "queue_exact");
  assert.strictEqual(gateReadyState.exact_profile_path, "agent/task_profiles/route_fallback_gpu_after_gate.json");
  assert.strictEqual(gateReadyState.exact_queue_draft_path, "agent/queue/drafts/route_fallback_gpu_after_gate.json");
  assert.strictEqual(gateReadyState.exact_next_object_path, "agent/queue/drafts/route_fallback_gpu_after_gate.json");
  const gateReadyProgress = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "PROGRESS_STATE.json"), "utf8"));
  assert.strictEqual(gateReadyProgress.successor_contract_required, false);
  assert.strictEqual(gateReadyProgress.active_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateReadyProgress.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateReadyProgress.experiment_gate_status, "required_ready");
  assert.strictEqual(gateReadyProgress.successor_materialization_status, "queue_exact");
  const gateReadyRunState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "RUN_STATE.json"), "utf8"));
  assert.strictEqual(gateReadyRunState.successor_contract_required, false);
  assert.strictEqual(gateReadyRunState.active_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateReadyRunState.route_task_id, "route_fallback_gpu_after_gate");
  assert.strictEqual(gateReadyRunState.experiment_gate_status, "required_ready");
  assert.strictEqual(gateReadyRunState.successor_materialization_status, "queue_exact");
  const gateReadyNextAction = fs.readFileSync(path.join(projectRoot, "agent", "NEXT_ACTION.md"), "utf8");
  assert.match(gateReadyNextAction, /Successor contract required: false/);
  assert.match(gateReadyNextAction, /Canonical active task: route_fallback_gpu_after_gate/);
  assert.match(gateReadyNextAction, /Route-selected task: route_fallback_gpu_after_gate/);
  assert.match(gateReadyNextAction, /Successor materialization status: queue_exact/);
  assert.match(gateReadyNextAction, /Experiment gate status: required_ready/);
  assert.match(gateReadyNextAction, /Exact queue draft path: agent\/queue\/drafts\/route_fallback_gpu_after_gate\.json/);
  const gateReadyCurrentState = fs.readFileSync(path.join(projectRoot, "agent", "CURRENT_STATE.md"), "utf8");
  assert.match(gateReadyCurrentState, /Successor contract required: false/);
  assert.match(gateReadyCurrentState, /Canonical active task: route_fallback_gpu_after_gate/);
  assert.match(gateReadyCurrentState, /Route-selected task: route_fallback_gpu_after_gate/);
  const gateReadyDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "NEXT_TASK_DRAFT.json"), "utf8"));
  assert.strictEqual(gateReadyDraft.task_id, "route_fallback_gpu_after_gate");
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.match(route.reason, /exact queue draft is already materialized, but autonomous enqueue is still disabled by queue policy/i);

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "canonical-only-box",
    route_id: "route-canonical-only",
    route_epoch: "route-canonical-only-001",
    project_question: "Does one exact CPU follow-up decide whether this route continues?",
    decision_relevance: "A positive result keeps the route alive; a negative one retires it.",
    claim_scope: "bounded_cpu_diagnostic",
    diagnosis_target: "canonical successor viability",
    fair_comparability: {
      same_family_or_not: "same_family",
      same_budget_or_not: "same_budget",
      same_training_contract_or_not: "same_training_contract",
      same_eval_contract_or_not: "same_eval_contract"
    },
    value_of_information: {
      expected_information_gain: "medium",
      decision_change_if_positive: "Continue the route.",
      decision_change_if_negative: "Retire the route.",
      cheaper_alternative_exists: false
    },
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: ["bounded_cpu_eval"],
    blocked_actions: [],
    forbidden_conclusions: [
      "Do not treat this exact CPU follow-up as a project-level superiority claim."
    ],
    allowed_write_paths: ["agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: []
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-canonical-only",
    route_epoch: "route-canonical-only-001",
    owner_mode: "fully_autonomous",
    requires_review: false,
    current_allowed_step: "cpu_followup",
    exact_next_task_id: "canonical_cpu_only_followup",
    exact_profile_path: "agent/task_profiles/canonical_cpu_only_followup.json",
    exact_next_object_path: "agent/task_profiles/canonical_cpu_only_followup.json",
    required_successor_exactness: "profile_exact",
    successor_materialization_status: "profile_exact",
    experiment_gate_status: "not_required"
  });
  writeJson(projectRoot, "agent/task_profiles/canonical_cpu_only_followup.json", {
    task_id: "canonical_cpu_only_followup",
    profile_kind: "cpu_followup",
    allowed_runner: "cpu",
    budget_contract: "one bounded cpu follow-up",
    max_runtime_minutes: 15,
    expected_outputs: ["runs/canonical_cpu_only_followup/metrics.json"]
  });
  writeJson(projectRoot, "agent/status/NEXT_TASK_DRAFT.json", {});
  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [],
    blocked_actions: [],
    important_paths: ["agent/ROUTE_CANONICAL.json", "agent/TASK_BOX.json"]
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-canonical-only-001"
  });
  writeJson(projectRoot, "agent/RUN_STATE.json", {
    schema_version: 1,
    blocker_type: "none",
    requires_human_review: false,
    route_epoch: "route-canonical-only-001",
    next_action: { kind: "none", description: "", reason: "" }
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.task_id, "canonical_cpu_only_followup");
  assert.match(route.reason, /exact profile already defines budget, timeout, and expected outputs/i);
  runRender(projectRoot, {
    timestamp_utc: "2026-06-13T08:00:00Z",
    report_markdown: "# Report\n\nCanonical CPU successor is already exact and should be rehydrated into an explicit runnable object.",
    overall_status: "active",
    report_type: "progress",
    primary_skill: "watchdog-orchestrator",
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "Recovered the canonical CPU exact successor into an explicit next task draft.",
    blocked_items: [],
    completed_items: ["Recovered exact CPU successor object"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json", "agent/task_profiles/canonical_cpu_only_followup.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "state_reconcile",
      description: "Keep the canonical CPU successor explicit in local derived files.",
      can_execute_automatically: true,
      reason: "The exact CPU contract already exists and should stay materialized as a runnable bounded task."
    },
    skill_stop_condition: "Rehydrate one canonical CPU successor object and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: null,
    task_profile_draft: null,
    queue_request_draft: null,
    route_canonical_update: {},
    task_box_update: {}
  });
  const canonicalCpuDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "NEXT_TASK_DRAFT.json"), "utf8"));
  assert.strictEqual(canonicalCpuDraft.task_id, "canonical_cpu_only_followup");
  assert.strictEqual(canonicalCpuDraft.kind, "bounded_cpu_eval");
  assert.strictEqual(canonicalCpuDraft.exact_contract_rehydrated, true);
  const canonicalCpuTaskBox = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "TASK_BOX.json"), "utf8"));
  assert.strictEqual(canonicalCpuTaskBox.route_task_id, "canonical_cpu_only_followup");
  assert.ok(canonicalCpuTaskBox.tasks.some((task) => task.task_id === "canonical_cpu_only_followup"));
  const canonicalCpuState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(canonicalCpuState.route_task_id, "canonical_cpu_only_followup");
  assert.ok(canonicalCpuState.tasks.some((task) => task.task_id === "canonical_cpu_only_followup"));

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "canonical-local-copy-box",
    route_id: "route-canonical-local-copy",
    route_epoch: "route-canonical-local-copy-001",
    project_question: "Does one exact local workspace copy follow-up decide whether this route continues?",
    decision_relevance: "A positive result keeps the route alive; a negative one retires it.",
    claim_scope: "local_workspace_adapter",
    diagnosis_target: "canonical local-workspace successor viability",
    fair_comparability: {
      same_family_or_not: "same_family",
      same_budget_or_not: "same_budget",
      same_training_contract_or_not: "same_training_contract",
      same_eval_contract_or_not: "same_eval_contract"
    },
    value_of_information: {
      expected_information_gain: "medium",
      decision_change_if_positive: "Continue the route.",
      decision_change_if_negative: "Retire the route.",
      cheaper_alternative_exists: false
    },
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: ["local_workspace_copy"],
    blocked_actions: [],
    forbidden_conclusions: [
      "Do not treat this local workspace copy follow-up as a project-level superiority claim."
    ],
    allowed_write_paths: ["workspace/", "runs/", "agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: []
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-canonical-local-copy",
    route_epoch: "route-canonical-local-copy-001",
    owner_mode: "fully_autonomous",
    requires_review: false,
    current_allowed_step: "local_workspace_copy",
    exact_next_task_id: "canonical_local_workspace_followup",
    exact_profile_path: "agent/task_profiles/canonical_local_workspace_followup.json",
    exact_next_object_path: "agent/task_profiles/canonical_local_workspace_followup.json",
    required_successor_exactness: "profile_exact",
    successor_materialization_status: "profile_exact",
    experiment_gate_status: "not_required"
  });
  writeJson(projectRoot, "agent/task_profiles/canonical_local_workspace_followup.json", {
    task_id: "canonical_local_workspace_followup",
    profile_kind: "local_workspace_copy",
    allowed_runner: "cpu",
    workspace_mode: "project_local_copy",
    workspace_root: "workspace/canonical_local_workspace_followup/",
    allowed_write_paths: ["workspace/canonical_local_workspace_followup/", "agent/status/", "agent/reports/"],
    budget_contract: "one bounded local workspace follow-up",
    max_runtime_minutes: 20,
    expected_outputs: [
      "workspace/canonical_local_workspace_followup/",
      "agent/reports/canonical_local_workspace_followup.md"
    ]
  });
  writeJson(projectRoot, "agent/status/NEXT_TASK_DRAFT.json", {});
  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [],
    blocked_actions: [],
    important_paths: ["agent/ROUTE_CANONICAL.json", "agent/TASK_BOX.json"]
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-canonical-local-copy-001"
  });
  writeJson(projectRoot, "agent/RUN_STATE.json", {
    schema_version: 1,
    blocker_type: "none",
    requires_human_review: false,
    route_epoch: "route-canonical-local-copy-001",
    next_action: { kind: "none", description: "", reason: "" }
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.task_id, "canonical_local_workspace_followup");
  assert.match(route.reason, /exact profile already defines workspace root, write paths, budget, timeout, and expected outputs/i);
  runRender(projectRoot, {
    timestamp_utc: "2026-06-13T08:05:00Z",
    report_markdown: "# Report\n\nCanonical local-workspace successor is already exact and should be rehydrated into an explicit runnable object.",
    overall_status: "active",
    report_type: "progress",
    primary_skill: "watchdog-orchestrator",
    supervisor_mode: "runner",
    review_scope: "none",
    review_resolver: "none",
    review_pending_state: "none",
    work_cycle_summary: "Recovered the canonical local-workspace exact successor into an explicit next task draft.",
    blocked_items: [],
    completed_items: ["Recovered exact local-workspace successor object"],
    running_items: [],
    evidence: ["agent/ROUTE_CANONICAL.json", "agent/task_profiles/canonical_local_workspace_followup.json"],
    progress_changed: true,
    no_progress_cycles: 0,
    recommend_pause: false,
    requires_human_review: false,
    human_review_reason: "",
    next_safe_action: {
      kind: "state_reconcile",
      description: "Keep the canonical local-workspace successor explicit in local derived files.",
      can_execute_automatically: true,
      reason: "The exact local-workspace contract already exists and should stay materialized as a runnable bounded task."
    },
    skill_stop_condition: "Rehydrate one canonical local-workspace successor object and stop.",
    state_update_markdown: "",
    runtime_state_markdown: "",
    morning_brief_markdown: "",
    proposal_markdown: "",
    ledger_update_markdown: "",
    successor_task_draft: null,
    task_profile_draft: null,
    queue_request_draft: null,
    route_canonical_update: {},
    task_box_update: {}
  });
  const canonicalLocalDraft = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "NEXT_TASK_DRAFT.json"), "utf8"));
  assert.strictEqual(canonicalLocalDraft.task_id, "canonical_local_workspace_followup");
  assert.strictEqual(canonicalLocalDraft.kind, "local_workspace_copy");
  assert.strictEqual(canonicalLocalDraft.exact_contract_rehydrated, true);
  const canonicalLocalTaskBox = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "TASK_BOX.json"), "utf8"));
  assert.strictEqual(canonicalLocalTaskBox.route_task_id, "canonical_local_workspace_followup");
  assert.ok(canonicalLocalTaskBox.tasks.some((task) => task.task_id === "canonical_local_workspace_followup"));
  const canonicalLocalState = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "STATE.json"), "utf8"));
  assert.strictEqual(canonicalLocalState.route_task_id, "canonical_local_workspace_followup");
  assert.ok(canonicalLocalState.tasks.some((task) => task.task_id === "canonical_local_workspace_followup"));

  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-canonical-only",
    route_epoch: "route-canonical-only-001",
    owner_mode: "fully_autonomous",
    requires_review: false,
    current_allowed_step: "cpu_followup",
    exact_next_task_id: "canonical_cpu_only_followup",
    exact_profile_path: "agent/task_profiles/canonical_cpu_only_followup.json",
    exact_next_object_path: "agent/task_profiles/canonical_cpu_only_followup.json",
    required_successor_exactness: "profile_exact",
    successor_materialization_status: "profile_exact",
    experiment_gate_status: "not_required"
  });
  writeJson(projectRoot, "agent/task_profiles/canonical_cpu_only_followup.json", {
    task_id: "canonical_cpu_only_followup",
    profile_kind: "cpu_followup",
    allowed_runner: "cpu",
    budget_contract: "one bounded cpu follow-up",
    max_runtime_minutes: 15,
    expected_outputs: ["runs/canonical_cpu_only_followup/metrics.json"]
  });
  writeJson(projectRoot, "agent/status/NEXT_TASK_DRAFT.json", {});
  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [],
    blocked_actions: [],
    important_paths: ["agent/ROUTE_CANONICAL.json", "agent/TASK_BOX.json"]
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: "route-canonical-only-001"
  });
  writeJson(projectRoot, "agent/RUN_STATE.json", {
    schema_version: 1,
    blocker_type: "none",
    requires_human_review: false,
    route_epoch: "route-canonical-only-001",
    next_action: { kind: "none", description: "", reason: "" }
  });

  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "canonical-drift-box",
    route_id: "route-canonical-only",
    route_epoch: "route-canonical-only-001",
    project_question: "Does one exact CPU follow-up decide whether this route continues?",
    decision_relevance: "A positive result keeps the route alive; a negative one retires it.",
    claim_scope: "bounded_cpu_diagnostic",
    diagnosis_target: "canonical successor viability",
    fair_comparability: {
      same_family_or_not: "same_family",
      same_budget_or_not: "same_budget",
      same_training_contract_or_not: "same_training_contract",
      same_eval_contract_or_not: "same_eval_contract"
    },
    value_of_information: {
      expected_information_gain: "medium",
      decision_change_if_positive: "Continue the route.",
      decision_change_if_negative: "Retire the route.",
      cheaper_alternative_exists: false
    },
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: ["bounded_cpu_eval"],
    blocked_actions: [],
    forbidden_conclusions: [
      "Do not treat this exact CPU follow-up as a project-level superiority claim."
    ],
    allowed_write_paths: ["agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: [
      {
        task_id: "stale_old_cpu_followup",
        status: "pending",
        allowed_runner: "cpu",
        title: "This stale task should be reconciled away."
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.task_id, "canonical_cpu_only_followup");
  assert.match(route.reason, /TASK_BOX\.json pending tasks still point at stale_old_cpu_followup/i);
  writeJson(projectRoot, "agent/TASK_BOX.json", {
    schema_version: 1,
    task_box_id: "post-fallback-cleanup-box",
    route_id: "route-clean",
    route_epoch: "route-clean-001",
    requires_review: false,
    allowed_actions: ["bounded_cpu_eval"],
    blocked_actions: [],
    allowed_write_paths: ["agent/status/", "agent/reports/", "agent/task_profiles/"],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    tasks: []
  });
  writeJson(projectRoot, "agent/status/NEXT_TASK_DRAFT.json", {
    task_id: "cleared_next_task_draft",
    status: "done",
    allowed_runner: "cpu",
    summary: "Cleared after fallback successor assertions so later tests can provide their own runnable task source."
  });
  writeJson(projectRoot, "agent/ROUTE_CANONICAL.json", {
    schema_version: 1,
    route_id: "route-clean",
    route_epoch: "route-clean-001",
    owner_mode: "fully_autonomous",
    requires_review: false
  });
  writeJson(projectRoot, "agent/PROGRESS_STATE.json", {
    no_progress_cycles: 0,
    recommend_pause: false,
    route_epoch: null,
    next_safe_action: { kind: "none", description: "", reason: "" }
  });
  writeJson(projectRoot, "agent/RUN_STATE.json", {
    schema_version: 1,
    blocker_type: "none",
    requires_human_review: false,
    next_action: { kind: "none", description: "", reason: "" }
  });
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: none",
    "- pending_send: no",
    "- requires_human_review: false",
    "- scope: none",
    "- resolver: none",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/BLOCKERS.md", [
    "# Blockers",
    "",
    "Blocker type: none",
    "- Required: false",
    ""
  ].join("\n"));

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "bounded_cpu_after_supervisor_approval",
        status: "pending",
        allowed_runner: "cpu",
        title: "Run one bounded CPU smoke after supervisor approval.",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          scope: "bounded CPU smoke"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "bounded_cpu_after_supervisor_approval");
  assert.match(route.reason, /explicit supervisor approval/);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "local_workspace_copy_after_supervisor_approval",
        status: "pending",
        allowed_runner: "cpu",
        workspace_mode: "project_local_copy",
        title: "Implement one local workspace copy adapter without touching shared source.",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          approval_class: "local_workspace_copy",
          scope: "copy source into workspace/<task_id>/ and modify only the local workspace copy"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "local_workspace_copy_after_supervisor_approval");
  assert.match(route.reason, /explicit supervisor approval/);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "bounded_gpu_after_supervisor_approval",
        status: "pending",
        allowed_runner: "gpu",
        title: "Run one bounded GPU probe after supervisor approval.",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          approval_class: "bounded_gpu_probe",
          scope: "bounded GPU probe with fixed timeout and no promotion"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, true);
  assert.strictEqual(route.task_id, "bounded_gpu_after_supervisor_approval");
  assert.doesNotMatch(route.reason, /explicit supervisor approval/);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "state_reconcile_after_supervisor_approval",
        status: "pending",
        allowed_runner: "cpu",
        title: "Run state reconcile action after supervisor approval.",
        kind: "state_reconcile",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          approval_class: "state_reconcile",
          scope: "compact state reconcile and compact report alignment"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "state_reconcile_after_supervisor_approval");
  assert.match(route.reason, /explicit supervisor approval/);

  writeJson(projectRoot, "agent/supervisor_capabilities.json", {
    schema_version: 1,
    capabilities: {
      bounded_gpu_probe: {
        enabled: true,
        max_runtime_minutes: 20,
        max_samples: 32
      }
    }
  });
  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "bounded_gpu_after_supervisor_approval_v2",
        status: "pending",
        allowed_runner: "gpu",
        title: "Run one bounded GPU probe after supervisor approval.",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          approval_class: "bounded_gpu_probe",
          scope: "bounded GPU probe with fixed timeout and no promotion"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "bounded_gpu_after_supervisor_approval_v2");
  assert.match(route.reason, /explicit supervisor approval/);
  fs.unlinkSync(path.join(projectRoot, "agent", "supervisor_capabilities.json"));

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "external_send_after_supervisor_approval",
        status: "pending",
        allowed_runner: "cpu",
        title: "Send external reviewer packet after supervisor approval.",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          approval_class: "external_send",
          scope: "external send reviewer packet"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, true);
  assert.strictEqual(route.task_id, "external_send_after_supervisor_approval");
  assert.doesNotMatch(route.reason, /explicit supervisor approval/);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "gpu_queue_enqueue_after_supervisor_approval",
        status: "pending",
        allowed_runner: "gpu",
        title: "Submit one GPU training taskbox to the controlled agent/queue/queued path.",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          approval_class: "queue_enqueue",
          scope: "enqueue bounded GPU training taskbox into controlled agent/queue/queued; queue runner executes later"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "gpu_queue_enqueue_after_supervisor_approval");
  assert.doesNotMatch(route.reason, /explicit supervisor approval/);

  writeJson(projectRoot, "agent/supervisor_capabilities.json", {
    schema_version: 1,
    capabilities: {
      queue_enqueue: {
        enabled: true,
        allowed_queues: ["gpu_queue"],
        requires_taskbox: true
      }
    }
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "gpu_queue_enqueue_after_supervisor_approval");
  assert.match(route.reason, /explicit supervisor approval/);

  writeJson(projectRoot, "agent/STATE.json", {
    schema_version: 1,
    mode: "project-local-worker",
    requires_review: false,
    tasks: [
      {
        task_id: "direct_gpu_execution_after_supervisor_approval",
        status: "pending",
        allowed_runner: "gpu",
        title: "Bypass queue and run GPU directly after supervisor approval.",
        supervisor_approved: true,
        supervisor_approval: {
          approved_by: "supervisor",
          approval_class: "queue_enqueue",
          scope: "bypass queue and execute GPU directly"
        }
      }
    ]
  });
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, true);
  assert.strictEqual(route.task_id, "direct_gpu_execution_after_supervisor_approval");
  assert.doesNotMatch(route.reason, /explicit supervisor approval/);
  fs.unlinkSync(path.join(projectRoot, "agent", "supervisor_capabilities.json"));

  const targetRunner = path.join(projectRoot, "target-runner");
  writeJson(targetRunner, "agent/PROGRESS_STATE.json", {
    requires_human_review: true,
    next_safe_action: {
      kind: "propose_review",
      description: "Prepare report-only inventory proposal for stale blocker repair.",
      reason: "This is report-only static audit bookkeeping and does not execute jobs."
    }
  });
  route = runRoute(projectRoot, {
    WATCHDOG_ROLE: "supervisor",
    WATCHDOG_SUPERVISOR_MODE: "light",
    WATCHDOG_SUPERVISOR_TARGETS: targetRunner
  });
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "supervisor-delegated-runner-blocker-approval");
  assert.match(route.reason, /Supervisor delegated runner blocker found/);

  const targetGpuRunner = path.join(projectRoot, "target-gpu-runner");
  writeJson(targetGpuRunner, "agent/PROGRESS_STATE.json", {
    requires_human_review: true,
    next_safe_action: {
      kind: "propose_review",
      description: "Prepare bounded GPU probe with fixed timeout and no promotion.",
      reason: "This is a bounded sample eval probe and does not mutate checkpoints."
    }
  });
  route = runRoute(projectRoot, {
    WATCHDOG_ROLE: "supervisor",
    WATCHDOG_SUPERVISOR_MODE: "light",
    WATCHDOG_SUPERVISOR_TARGETS: targetGpuRunner
  });
  assert.notStrictEqual(route.task_id, "supervisor-delegated-runner-blocker-approval");

  writeJson(targetGpuRunner, "agent/supervisor_capabilities.json", {
    schema_version: 1,
    capabilities: {
      bounded_gpu_probe: true
    }
  });
  route = runRoute(projectRoot, {
    WATCHDOG_ROLE: "supervisor",
    WATCHDOG_SUPERVISOR_MODE: "light",
    WATCHDOG_SUPERVISOR_TARGETS: targetGpuRunner
  });
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "supervisor-delegated-runner-blocker-approval");
  assert.match(route.reason, /capability=bounded_gpu_probe/);

  const targetQueueRunner = path.join(projectRoot, "target-queue-runner");
  writeJson(targetQueueRunner, "agent/PROGRESS_STATE.json", {
    requires_human_review: true,
    next_safe_action: {
      kind: "propose_review",
      description: "Enqueue bounded GPU training taskbox into controlled agent/queue/queued.",
      reason: "Runner will not execute GPU directly; queue runner handles allowlist, timeout, and logs."
    }
  });
  route = runRoute(projectRoot, {
    WATCHDOG_ROLE: "supervisor",
    WATCHDOG_SUPERVISOR_MODE: "light",
    WATCHDOG_SUPERVISOR_TARGETS: targetQueueRunner
  });
  assert.notStrictEqual(route.task_id, "supervisor-delegated-runner-blocker-approval");

  writeJson(targetQueueRunner, "agent/supervisor_capabilities.json", {
    schema_version: 1,
    capabilities: {
      queue_enqueue: true
    }
  });
  route = runRoute(projectRoot, {
    WATCHDOG_ROLE: "supervisor",
    WATCHDOG_SUPERVISOR_MODE: "light",
    WATCHDOG_SUPERVISOR_TARGETS: targetQueueRunner
  });
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "supervisor-delegated-runner-blocker-approval");
  assert.match(route.reason, /capability=queue_enqueue/);

  writeFile(projectRoot, "agent/bin/supervisor_reconcile_stale_state.py", [
    "#!/usr/bin/env python3",
    "import json",
    "from pathlib import Path",
    "Path('agent/status').mkdir(parents=True, exist_ok=True)",
    "Path('agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json').write_text(json.dumps({",
    "  'schema_version': 1,",
    "  'kind': 'supervisor_stale_state_reconciliation',",
    "  'updated_utc': '2026-06-02T00:00:00Z',",
    "  'changed': True,",
    "  'results': [{'stage': 'target-runner', 'changed': True, 'status_note': 'agent/status/note.md'}],",
    "  'safety_boundary': ['No code edits approved', 'No CPU/GPU execution approved']",
    "}, indent=2) + '\\n')",
    ""
  ].join("\n"));
  fs.chmodSync(path.join(projectRoot, "agent", "bin", "supervisor_reconcile_stale_state.py"), 0o755);
  writeFile(projectRoot, "agent/status/runner_run_count", "1\n");
  writeFile(projectRoot, "agent/status/runner_completed_count", "1\n");
  run("bash", [path.join(projectRoot, "agent", "bin", "run_watchdog.sh")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WATCHDOG_ROLE: "supervisor",
      CODEX_BIN: "/bin/false",
      CODEX_SANDBOX_MODE: "read-only"
    }
  });
  const reports = fs.readdirSync(path.join(projectRoot, "agent", "reports"));
  assert.ok(reports.some((name) => name.endsWith(".json")));
  assert.ok(!reports.some((name) => name.endsWith(".prompt.md")), "early-exit reconciliation should not build a Codex prompt");
  const latestReport = fs.readFileSync(path.join(projectRoot, "agent", "reports", "latest.md"), "utf8");
  assert.match(latestReport, /Supervisor Stale-State Reconciliation/);
  assert.match(latestReport, /Codex reasoning was not launched/);
  const supervisorMode = JSON.parse(fs.readFileSync(path.join(projectRoot, "agent", "status", "SUPERVISOR_MODE.json"), "utf8"));
  assert.strictEqual(supervisorMode.decision.status, "completed");
  assert.strictEqual(supervisorMode.decision.completion_reason, "supervisor_stale_state_reconciliation");

  fs.appendFileSync(path.join(projectRoot, "agent", "bin", "run_watchdog.sh"), "\n# intentional drift for generated-template test\n");
  let failed = false;
  try {
    run(path.join(projectRoot, "agent", "bin", "watchdog"), ["validate"], {
      cwd: projectRoot
    });
  } catch (error) {
    failed = true;
    const output = `${String(error.stdout || "")}\n${String(error.stderr || "")}`;
    assert.match(output, /generated file drift: agent\/bin\/run_watchdog\.sh/);
  }
  assert.ok(failed, "watchdog validate should fail after a generated file drifts");

  console.log(`generated-template test passed: ${projectRoot}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
