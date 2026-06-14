"use strict";

const { shellScriptTemplates } = require("./templateShellScripts");
const { pythonScriptTemplates } = require("./templatePythonScripts");

const scriptTemplates = {
  ...shellScriptTemplates,
  ...pythonScriptTemplates
};
module.exports = {
  scriptTemplates
};
