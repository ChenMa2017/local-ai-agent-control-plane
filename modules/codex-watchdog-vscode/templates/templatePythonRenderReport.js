"use strict";

const { renderReportPrelude } = require("./templatePythonRenderReportPrelude");
const { renderReportSuccessor } = require("./templatePythonRenderReportSuccessor");
const { renderReportFinalize } = require("./templatePythonRenderReportFinalize");

const pythonRenderReportTemplates = {
  renderReport: () => [renderReportPrelude, renderReportSuccessor, renderReportFinalize].join("")
};

module.exports = {
  pythonRenderReportTemplates
};
