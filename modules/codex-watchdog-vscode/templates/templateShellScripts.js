"use strict";

const { shellRuntimeScriptTemplates } = require("./templateShellRuntimeScripts");
const { shellControlScriptTemplates } = require("./templateShellControlScripts");

const shellScriptTemplates = {
  ...shellRuntimeScriptTemplates,
  ...shellControlScriptTemplates
};

module.exports = {
  shellScriptTemplates
};
