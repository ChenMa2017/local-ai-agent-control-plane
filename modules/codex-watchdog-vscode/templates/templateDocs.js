"use strict";

const { bootstrapDocTemplates } = require("./templateBootstrapDocs");
const { watchdogDocTemplates } = require("./templateWatchdogDocs");

const docTemplates = {
  ...bootstrapDocTemplates,
  ...watchdogDocTemplates
};

module.exports = {
  docTemplates
};
