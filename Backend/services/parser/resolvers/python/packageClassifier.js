const { classifyStdlibModule, isPythonStdlib } = require("./stdlibModules");

/**
 * Safely parses package names from a requirements.txt file content.
 * Pure text processing; does not execute code or run package managers.
 *
 * @param {string} content
 * @returns {Set<string>} Set of normalized declared package names
 */
function parseRequirementsTxt(content) {
  const declared = new Set();
  if (typeof content !== "string") return declared;

  const lines = content.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;

    const hashIdx = line.indexOf("#");
    if (hashIdx !== -1) {
      line = line.substring(0, hashIdx).trim();
    }

    const semiIdx = line.indexOf(";");
    if (semiIdx !== -1) {
      line = line.substring(0, semiIdx).trim();
    }

    const versionMatch = line.match(/^([a-zA-Z0-9_.\-]+)/);
    if (versionMatch) {
      let pkgName = versionMatch[1].trim();
      pkgName = pkgName.replace(/\[.*\]$/, "");
      if (pkgName) {
        declared.add(pkgName.toLowerCase().replace(/[-_.]/g, ""));
      }
    }
  }

  return declared;
}

/**
 * Safely extracts the target Python minor version from pyproject.toml requires-python field.
 * Pure regex data parsing; does not execute pyproject or external TOML libraries.
 *
 * Examples:
 * - `requires-python = ">=3.11"` -> 3.11
 * - `requires-python = ">=3.10, <3.13"` -> 3.10
 *
 * @param {string} content
 * @returns {number|null} Minor version number e.g. 3.11, or null if unknown
 */
function parseRequiresPython(content) {
  if (typeof content !== "string") return null;

  const match = content.match(/requires-python\s*=\s*["']([^"']+)["']/i);
  if (!match) return null;

  const spec = match[1].trim();
  const verMatch = spec.match(/3\.(\d+)/);
  if (verMatch) {
    return parseFloat(`3.${verMatch[1]}`);
  }
  return null;
}

/**
 * Classifies an unresolved Python module specifier as standard library, external package, or unknown,
 * accounting for target Python version certainty.
 *
 * @param {string} specifier - Module import path (e.g. "requests", "os.path", "tomllib")
 * @param {Set<string>} [declaredPackages] - Optional set of declared packages from requirements/pyproject
 * @param {number|null} [targetVersion=null] - Optional detected target Python minor version (e.g. 3.11)
 * @returns {{
 *   status: "standard_library"|"external_package"|"unresolved",
 *   target: string,
 *   packageName: string|null,
 *   versionCertainty?: "confirmed"|"uncertain",
 *   rule?: string
 * }}
 */
function classifyPythonModule(specifier, declaredPackages = new Set(), targetVersion = null) {
  if (!specifier || typeof specifier !== "string") {
    return {
      status: "unresolved",
      target: "unknown",
      packageName: null,
      versionCertainty: "confirmed",
      rule: "invalid_specifier",
    };
  }

  const clean = specifier.trim();
  const topLevel = clean.split(".")[0];

  // 1. Version-aware Standard Library Check
  const stdlibCheck = classifyStdlibModule(topLevel, targetVersion);
  if (stdlibCheck.isStdlib) {
    return {
      status: "standard_library",
      target: topLevel,
      packageName: null,
      versionCertainty: stdlibCheck.versionCertainty,
      rule: stdlibCheck.rule,
    };
  }

  // 2. Declared Package Check
  const normTopLevel = topLevel.toLowerCase().replace(/[-_.]/g, "");
  if (declaredPackages && declaredPackages.has(normTopLevel)) {
    return {
      status: "external_package",
      target: topLevel,
      packageName: topLevel,
      versionCertainty: "confirmed",
      rule: "external_package",
    };
  }

  // 3. Fallback: non-relative top-level module not found locally or in stdlib
  return {
    status: "external_package",
    target: topLevel,
    packageName: topLevel,
    versionCertainty: "confirmed",
    rule: "external_package",
  };
}

module.exports = {
  parseRequirementsTxt,
  parseRequiresPython,
  classifyPythonModule,
};
