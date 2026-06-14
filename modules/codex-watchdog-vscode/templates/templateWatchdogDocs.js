"use strict";

const { watchdogPlanningDocTemplates } = require("./templateWatchdogPlanningDocs");
const { watchdogProtocolDocTemplates } = require("./templateWatchdogProtocolDocs");
const { watchdogPromptDocTemplates } = require("./templateWatchdogPromptDocs");

const watchdogDocTemplates = {
  ...watchdogPlanningDocTemplates,
  ...watchdogProtocolDocTemplates,
  ...watchdogPromptDocTemplates
};

module.exports = {
  watchdogDocTemplates
};
