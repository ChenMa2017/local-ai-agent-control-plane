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
`;

module.exports = {
  shellMakePromptTemplate
};
