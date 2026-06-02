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
module.exports.__test__ = { ensureGeneratedDirs, refreshGeneratedWatcherFiles };`, sandbox, {
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
  let route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "report_only_inventory");
  assert.match(route.reason, /report-only task can proceed/);

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
  assert.match(route.reason, /continue with one report-only step/);

  writeFile(projectRoot, "agent/TODO.md", "# TODO\n\n- none\n");
  route = runRoute(projectRoot, { WATCHDOG_COMPACTION_DUE: "1" });
  assert.strictEqual(route.primary_skill, "watchdog-report-curator");
  assert.match(route.reason, /compaction cycle is due/i);

  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-handoff-writer");
  assert.match(route.reason, /REVIEW_PENDING\.md state=pending_send/);

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
  assert.strictEqual(route.primary_skill, "watchdog-handoff-writer");
  assert.doesNotMatch(route.reason, /explicit supervisor approval/);

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
  route = runRoute(projectRoot);
  assert.strictEqual(route.primary_skill, "watchdog-orchestrator");
  assert.strictEqual(route.permission_guardian_required, false);
  assert.strictEqual(route.task_id, "bounded_gpu_after_supervisor_approval");
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
  assert.strictEqual(route.primary_skill, "watchdog-handoff-writer");
  assert.doesNotMatch(route.reason, /explicit supervisor approval/);

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
