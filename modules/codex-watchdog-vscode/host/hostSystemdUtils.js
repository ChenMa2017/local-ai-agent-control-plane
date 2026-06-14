"use strict";

function createHostSystemdUtils({
  path,
  crypto,
  getRuntimeConfigHelpers
}) {
  function projectSlug(root) {
    return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  }

  function unitNames(root) {
    const runtimeConfig = getRuntimeConfigHelpers();
    const prefix = runtimeConfig.servicePrefixSetting(root);
    const slug = projectSlug(root);
    const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
    const units = {
      service: `${prefix}-${slug}-${hash}.service`,
      timer: `${prefix}-${slug}-${hash}.timer`
    };
    runtimeConfig.validateUnitName(units.service, ".service");
    runtimeConfig.validateUnitName(units.timer, ".timer");
    return units;
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function systemdQuote(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  }

  function systemdPathValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\s/g, "\\x20");
  }

  function systemdEnvValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\s/g, "\\x20");
  }

  return {
    unitNames,
    shellQuote,
    systemdQuote,
    systemdPathValue,
    systemdEnvValue
  };
}

module.exports = {
  createHostSystemdUtils
};
