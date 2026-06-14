"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRuntimeClarityHelpers } = require("../runtime/runtimeClarity");

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchdog-runtime-clarity-"));
  const helpers = createRuntimeClarityHelpers({
    fs,
    path,
    readFilePrefix(file, maxBytes) {
      return fs.readFileSync(file, "utf8").slice(0, maxBytes);
    }
  });

  writeJson(projectRoot, "agent/RUN_STATE.json", { blocker_type: "stale_state" });
  writeFile(projectRoot, "agent/REVIEW_PENDING.md", [
    "# Review Pending",
    "",
    "- state: pending_send",
    "- pending_send: yes",
    "- requires_human_review: true",
    ""
  ].join("\n"));
  writeFile(projectRoot, "agent/control/PAUSE", "Paused at: 2026-06-13T00:00:00Z\nReason: test pause\n");
  writeJson(projectRoot, "agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json", {
    timestamp_utc: "2026-06-13T01:00:00Z",
    reconciliation: { changed: true }
  });
  writeJson(projectRoot, "agent/queue/running/job.json", { status: "running" });
  writeJson(projectRoot, "agent/queue/failed/old.json", { status: "failed" });

  const result = helpers.inspectProjectRuntimeClarity(projectRoot);
  assert.match(result.queueText, /queued=0, running=1, done=0, failed=1/);
  assert(result.signals.some((signal) => /PAUSE/.test(signal.text)));
  assert(result.signals.some((signal) => /blocker_type=stale_state/.test(signal.text)));
  assert(result.signals.some((signal) => /Review pending is active/.test(signal.text)));
  assert(result.signals.some((signal) => /running and failed queue records coexist/i.test(signal.text)));
  assert(result.signals.some((signal) => /reconciliation last ran/i.test(signal.text)));

  console.log("runtime-clarity test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
