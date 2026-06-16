"use strict";

const { pythonRouteSkillTemplates } = require("./templatePythonRouteSkill");
const { pythonValidateRuntimeTemplates } = require("./templatePythonValidateRuntime");
const { pythonRenderReportTemplates } = require("./templatePythonRenderReport");
const { pythonEvidenceToolTemplates } = require("./templatePythonEvidenceTools");

const pythonScriptTemplates = {
  ...pythonRouteSkillTemplates,
  ...pythonValidateRuntimeTemplates,
  ...pythonRenderReportTemplates,
  ...pythonEvidenceToolTemplates
};

module.exports = {
  pythonScriptTemplates
};
