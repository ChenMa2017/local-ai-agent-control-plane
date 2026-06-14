"use strict";

const { shellWatchdogGuardTemplate } = require("./templateShellWatchdogGuard");
const { shellWatchdogCliTemplate } = require("./templateShellWatchdogCli");
const { shellWatchdogTimerTemplate } = require("./templateShellWatchdogTimer");

const shellControlScriptTemplates = {
  watchdogGuard: shellWatchdogGuardTemplate,
  watchdogCli: shellWatchdogCliTemplate,
  watchdogTimer: shellWatchdogTimerTemplate
};

module.exports = {
  shellControlScriptTemplates
};
