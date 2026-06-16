"use strict";

const { docTemplates } = require("./templateDocs");
const { skillTextTemplates } = require("./templateSkills");
const { stateJsonTemplates } = require("./templateStateJson");
const { watchdogEvidenceTextTemplates } = require("./templateWatchdogEvidenceText");

const textTemplates = {
  ...docTemplates,
  ...skillTextTemplates,
  ...stateJsonTemplates,
  ...watchdogEvidenceTextTemplates
};
module.exports = {
  textTemplates
};
