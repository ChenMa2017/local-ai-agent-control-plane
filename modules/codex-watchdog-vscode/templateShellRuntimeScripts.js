"use strict";

const { shellCollectStatusTemplate } = require("./templateShellCollectStatus");
const { shellMakePromptTemplate } = require("./templateShellMakePrompt");
const { shellRunWatchdogTemplate } = require("./templateShellRunWatchdog");

const shellRuntimeScriptTemplates = {
  collectStatus: shellCollectStatusTemplate,
  makePrompt: shellMakePromptTemplate,
  runWatchdog: shellRunWatchdogTemplate
};

module.exports = {
  shellRuntimeScriptTemplates
};
