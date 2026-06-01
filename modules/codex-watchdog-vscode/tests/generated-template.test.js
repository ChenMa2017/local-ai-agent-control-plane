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

  fs.appendFileSync(path.join(projectRoot, "agent", "bin", "run_watchdog.sh"), "\n# intentional drift for generated-template test\n");
  let failed = false;
  try {
    run(path.join(projectRoot, "agent", "bin", "watchdog"), ["validate"], {
      cwd: projectRoot
    });
  } catch (error) {
    failed = true;
    const stderr = String(error.stderr || "");
    assert.match(stderr, /generated file drift: agent\/bin\/run_watchdog\.sh/);
  }
  assert.ok(failed, "watchdog validate should fail after a generated file drifts");

  console.log(`generated-template test passed: ${projectRoot}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
