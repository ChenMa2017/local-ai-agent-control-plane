"use strict";
const { demoDocTemplates } = require("./templateDemoDocs");
const { demoStateTemplates } = require("./templateDemoState");

const demoTemplates = {
  ...demoDocTemplates,
  ...demoStateTemplates
};

module.exports = {
  demoTemplates
};
