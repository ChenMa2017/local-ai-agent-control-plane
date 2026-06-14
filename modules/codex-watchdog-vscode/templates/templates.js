"use strict";

const { textTemplates } = require("./templateText");
const { schemaTemplates } = require("./templateSchemas");
const { scriptTemplates } = require("./templateScripts");
const { demoTemplates } = require("./templateDemo");

const templates = {
  ...textTemplates,
  ...schemaTemplates,
  ...scriptTemplates,
  ...demoTemplates
};

module.exports = {
  templates
};
