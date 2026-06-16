"use strict";

const { shellQuote } = require("./templateShellUtils");

const shellMakePromptTemplate = (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
cd "$PROJECT_ROOT"

cat agent/prompts/wakeup.md
echo
echo "---- BEGIN CURRENT SNAPSHOT ----"
cat agent/status/current.md
echo
echo "---- END CURRENT SNAPSHOT ----"
if [ -f research/RESEARCH_PROGRAM.json ]; then
  echo
  echo "---- BEGIN RESEARCH PROGRAM ----"
  cat research/RESEARCH_PROGRAM.json
  echo
  echo "---- END RESEARCH PROGRAM ----"
fi
`;

module.exports = {
  shellMakePromptTemplate
};
