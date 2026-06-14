"use strict";

const { bootstrapSchemaTemplates } = require("./templateBootstrapSchemas");
const { watchdogSchemaTemplates } = require("./templateWatchdogSchemas");

const schemaTemplates = {
  ...bootstrapSchemaTemplates,
  ...watchdogSchemaTemplates
};

module.exports = {
  schemaTemplates
};
