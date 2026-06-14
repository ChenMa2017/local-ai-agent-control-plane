"use strict";

function createHostPathUtils({
  fs,
  path,
  os
}) {
  function expandHome(value) {
    if (!value) {
      return value;
    }
    if (value === "~") {
      return os.homedir();
    }
    if (value.startsWith("~/")) {
      return path.join(os.homedir(), value.slice(2));
    }
    return value;
  }

  function isExistingDirectory(value) {
    try {
      return fs.existsSync(value) && fs.statSync(value).isDirectory();
    } catch (_error) {
      return false;
    }
  }

  function validateProjectRootPath(value) {
    if (!path.isAbsolute(value)) {
      throw new Error(`Project root must be an absolute Linux path: ${value}`);
    }
    if (/[\x00-\x1F\x7F%]/.test(value)) {
      throw new Error(`Project root contains characters unsafe for generated systemd units: ${value}`);
    }
  }

  function isSafeProjectRootPath(value) {
    try {
      validateProjectRootPath(value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function requireExistingDirectory(value, label) {
    const expanded = expandHome(String(value || ""));
    validateProjectRootPath(expanded);
    if (!fs.existsSync(expanded)) {
      throw new Error(`${label} does not exist: ${expanded}`);
    }
    if (!fs.statSync(expanded).isDirectory()) {
      throw new Error(`${label} is not a directory: ${expanded}`);
    }
    return expanded;
  }

  return {
    expandHome,
    isExistingDirectory,
    validateProjectRootPath,
    isSafeProjectRootPath,
    requireExistingDirectory
  };
}

module.exports = {
  createHostPathUtils
};
