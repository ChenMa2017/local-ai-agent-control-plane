"use strict";

const fsp = require("fs").promises;

function buildBootstrapExecArgs({ root, schemaPath, resultFile }) {
  return [
    "--ask-for-approval", "never",
    "exec",
    "--cd", root,
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--output-schema", schemaPath,
    "--output-last-message", resultFile,
    "-"
  ];
}

async function runBootstrapCodexJsonCall({
  root,
  codexBin,
  codexHome,
  schemaPath,
  resultFile,
  prompt,
  runLoggedWithInput,
  watchdogCommandTimeoutMs
}) {
  const args = buildBootstrapExecArgs({
    root,
    schemaPath,
    resultFile
  });

  await runLoggedWithInput(codexBin, args, prompt, {
    cwd: root,
    env: {
      CODEX_HOME: codexHome,
      CUDA_VISIBLE_DEVICES: ""
    },
    timeout: watchdogCommandTimeoutMs(root)
  });

  return JSON.parse(await fsp.readFile(resultFile, "utf8"));
}

module.exports = {
  buildBootstrapExecArgs,
  runBootstrapCodexJsonCall
};
