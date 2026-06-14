"use strict";

const { pythonRouteSkillTemplates } = require("./templatePythonRouteSkill");
const { pythonValidateRuntimeTemplates } = require("./templatePythonValidateRuntime");
const { pythonRenderReportTemplates } = require("./templatePythonRenderReport");

const pythonScriptTemplates = {
  ...pythonRouteSkillTemplates,
  ...pythonValidateRuntimeTemplates,
  ...pythonRenderReportTemplates
};

module.exports = {
  pythonScriptTemplates
};
