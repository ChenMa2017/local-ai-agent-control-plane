"use strict";

const { docTemplates } = require("./templateDocs");
const { skillTextTemplates } = require("./templateSkills");
const { stateJsonTemplates } = require("./templateStateJson");

const textTemplates = {
  ...docTemplates,
  ...skillTextTemplates,
  ...stateJsonTemplates
};
module.exports = {
  textTemplates
};
