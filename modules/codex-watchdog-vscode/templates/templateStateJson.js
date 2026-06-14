"use strict";

const { canonicalStateJsonTemplates } = require("./templateCanonicalStateJson");
const { supportStateJsonTemplates } = require("./templateSupportStateJson");

const stateJsonTemplates = {
  ...canonicalStateJsonTemplates,
  ...supportStateJsonTemplates
};

module.exports = {
  stateJsonTemplates
};
