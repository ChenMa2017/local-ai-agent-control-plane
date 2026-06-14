"use strict";

const { bootstrapGuideDocTemplates } = require("./templateBootstrapGuideDocs");
const { bootstrapProjectDocTemplates } = require("./templateBootstrapProjectDocs");

const bootstrapDocTemplates = {
  ...bootstrapGuideDocTemplates,
  ...bootstrapProjectDocTemplates
};

module.exports = {
  bootstrapDocTemplates
};
