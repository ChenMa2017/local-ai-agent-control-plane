"use strict";

const { routeSkillPrelude } = require("./templatePythonRouteSkillPrelude");
const { routeSkillPolicy } = require("./templatePythonRouteSkillPolicy");
const { routeSkillRouting } = require("./templatePythonRouteSkillRouting");

const pythonRouteSkillTemplates = {
  routeSkill: () => [routeSkillPrelude, routeSkillPolicy, routeSkillRouting].join("")
};

module.exports = {
  pythonRouteSkillTemplates
};
