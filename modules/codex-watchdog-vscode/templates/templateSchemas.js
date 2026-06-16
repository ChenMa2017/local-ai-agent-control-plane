"use strict";

const { bootstrapSchemaTemplates } = require("./templateBootstrapSchemas");
const { watchdogSchemaTemplates } = require("./templateWatchdogSchemas");
const { watchdogEvidenceSchemaTemplates } = require("./templateWatchdogEvidenceSchemas");

const schemaTemplates = {
  ...bootstrapSchemaTemplates,
  ...watchdogSchemaTemplates,
  ...watchdogEvidenceSchemaTemplates
};

module.exports = {
  schemaTemplates
};
