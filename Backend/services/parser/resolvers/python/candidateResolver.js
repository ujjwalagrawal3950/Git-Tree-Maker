const path = require("node:path").posix;

/**
 * Checks a candidate path against the manifest file set for runtime Python modules (.py, __init__.py)
 * and typing stubs (.pyi, __init__.pyi).
 *
 * Implements User Correction #2:
 * "Stub files should not be treated as ordinary runtime Python modules.
 * The blueprint now separates runtime module resolution from typing-stub information."
 *
 * Priority order:
 * 1. Runtime module: `base.py`
 * 2. Runtime package: `base/__init__.py`
 * 3. Stub module: `base.pyi`
 * 4. Stub package: `base/__init__.pyi`
 *
 * @param {string} basePath - Normalized repository-relative path without extension
 * @param {Set<string>} manifestFileSet - Set of known repository files
 * @returns {{
 *   runtimePath: string|null,
 *   stubPath: string|null,
 *   allCandidates: string[]
 * }}
 */
function probePythonCandidate(basePath, manifestFileSet) {
  const norm = path.normalize(basePath).replace(/^\/+/, "");
  const candidates = [];

  const pyInit = path.join(norm, "__init__.py");
  const pyFile = `${norm}.py`;
  const pyiInit = path.join(norm, "__init__.pyi");
  const pyiFile = `${norm}.pyi`;

  let runtimePath = null;
  let stubPath = null;
  let hasInitPrecedence = false;

  // Python importlib machinery precedence: a package directory containing __init__.py
  // takes deterministic precedence over a standalone module file with .py extension.
  if (manifestFileSet.has(pyInit)) {
    runtimePath = pyInit;
    candidates.push(pyInit);
  }
  if (manifestFileSet.has(pyFile)) {
    if (!runtimePath) {
      runtimePath = pyFile;
    } else {
      hasInitPrecedence = true;
    }
    candidates.push(pyFile);
  }

  if (manifestFileSet.has(pyiInit)) {
    stubPath = pyiInit;
    candidates.push(pyiInit);
  }
  if (manifestFileSet.has(pyiFile)) {
    if (!stubPath) {
      stubPath = pyiFile;
    }
    candidates.push(pyiFile);
  }

  return {
    runtimePath,
    stubPath,
    allCandidates: candidates,
    hasInitPrecedence,
  };
}

/**
 * Resolves a Python relative import against the repository manifest.
 *
 * @param {string} sourceFilePath - Path of the importing file (e.g. "pkg/services/auth.py")
 * @param {number} relativeLevel - Number of leading dots (e.g. 1 for ".", 2 for "..")
 * @param {string} [subpath] - Relative subpath after dots (e.g. "utils" or "helpers.crypto")
 * @param {Set<string>} manifestFileSet - Known repository files
 * @returns {{
 *   status: "internal_resolved"|"ambiguous"|"unresolved",
 *   targetPath?: string,
 *   stubPath?: string|null,
 *   candidates?: string[],
 *   rule?: string
 * }}
 */
function resolveRelativePythonImport(sourceFilePath, relativeLevel, subpath, manifestFileSet, importedNames = []) {
  if (!sourceFilePath || typeof relativeLevel !== "number" || relativeLevel < 1 || !manifestFileSet) {
    return { status: "unresolved", rule: "invalid_relative_import" };
  }

  // In Python, relative imports are relative to the package directory containing the source file
  let currentDir = path.dirname(sourceFilePath);

  // Level 1 (.) is currentDir
  // Level 2 (..) is parent of currentDir
  for (let i = 1; i < relativeLevel; i++) {
    const parent = path.dirname(currentDir);
    if (parent === currentDir || currentDir === "." || currentDir === "") {
      return {
        status: "unresolved",
        rule: "escapes_repository_root",
      };
    }
    currentDir = parent;
  }

  const cleanSubpath = subpath ? subpath.trim().replace(/\./g, "/") : "";
  const targetBase = cleanSubpath ? path.join(currentDir, cleanSubpath) : currentDir;

  const probe = probePythonCandidate(targetBase, manifestFileSet);

  // If the target is a package (__init__.py), check if importedNames matches a submodule file
  if (probe.runtimePath && probe.runtimePath.endsWith("__init__.py") && Array.isArray(importedNames)) {
    for (const name of importedNames) {
      if (name && name !== "*") {
        const subBase = path.join(targetBase, name);
        const subProbe = probePythonCandidate(subBase, manifestFileSet);
        if (subProbe.runtimePath) {
          return {
            status: "internal_resolved",
            targetPath: subProbe.runtimePath,
            stubPath: subProbe.stubPath,
            candidates: subProbe.allCandidates,
            rule: "relative_submodule_probe",
          };
        }
        if (subProbe.stubPath) {
          return {
            status: "internal_resolved",
            targetPath: subProbe.stubPath,
            stubPath: subProbe.stubPath,
            candidates: subProbe.allCandidates,
            rule: "relative_stub_probe",
          };
        }
      }
    }
  }

  if (probe.runtimePath) {
    return {
      status: "internal_resolved",
      targetPath: probe.runtimePath,
      stubPath: probe.stubPath,
      candidates: probe.allCandidates,
      rule: probe.hasInitPrecedence ? "package_init_precedence" : "relative_module_probe",
    };
  }

  if (probe.stubPath) {
    return {
      status: "internal_resolved",
      targetPath: probe.stubPath,
      stubPath: probe.stubPath,
      candidates: probe.allCandidates,
      rule: "relative_stub_probe",
    };
  }

  return {
    status: "unresolved",
    candidates: probe.allCandidates,
    rule: "relative_not_found",
  };
}

/**
 * Resolves an absolute Python import against repository manifest paths.
 * E.g. `import myapp.services.auth` or `from myapp.models import User`.
 *
 * @param {string} moduleSpecifier - Dotted module path (e.g. "myapp.services.auth")
 * @param {Set<string>} manifestFileSet - Known repository files
 * @param {Array<string>} [importedNames] - Optional list of names imported from the module
 * @returns {{
 *   status: "internal_resolved"|"ambiguous"|"unresolved",
 *   targetPath?: string,
 *   stubPath?: string|null,
 *   candidates?: string[],
 *   rule?: string
 * }}
 */
function resolveAbsolutePythonImport(moduleSpecifier, manifestFileSet, importedNames = []) {
  if (!moduleSpecifier || typeof moduleSpecifier !== "string" || !manifestFileSet) {
    return { status: "unresolved", rule: "invalid_specifier" };
  }

  const slashPath = moduleSpecifier.trim().replace(/\./g, "/");

  // 1. Direct module probe: myapp/services/auth -> myapp/services/auth.py or myapp/services/auth/__init__.py
  const directProbe = probePythonCandidate(slashPath, manifestFileSet);

  // If the target is a package (__init__.py), check if importedNames matches a submodule file
  if (directProbe.runtimePath && directProbe.runtimePath.endsWith("__init__.py") && Array.isArray(importedNames)) {
    for (const name of importedNames) {
      if (name && name !== "*") {
        const subCandidate = path.join(slashPath, name);
        const subProbe = probePythonCandidate(subCandidate, manifestFileSet);
        if (subProbe.runtimePath) {
          return {
            status: "internal_resolved",
            targetPath: subProbe.runtimePath,
            stubPath: subProbe.stubPath,
            candidates: subProbe.allCandidates,
            rule: "imported_submodule_probe",
          };
        }
        if (subProbe.stubPath) {
          return {
            status: "internal_resolved",
            targetPath: subProbe.stubPath,
            stubPath: subProbe.stubPath,
            candidates: subProbe.allCandidates,
            rule: "imported_stub_probe",
          };
        }
      }
    }
  }

  if (directProbe.runtimePath) {
    return {
      status: "internal_resolved",
      targetPath: directProbe.runtimePath,
      stubPath: directProbe.stubPath,
      candidates: directProbe.allCandidates,
      rule: directProbe.hasInitPrecedence ? "package_init_precedence" : "absolute_module_probe",
    };
  }
  if (directProbe.stubPath) {
    return {
      status: "internal_resolved",
      targetPath: directProbe.stubPath,
      stubPath: directProbe.stubPath,
      candidates: directProbe.allCandidates,
      rule: "absolute_stub_probe",
    };
  }

  // 2. Sub-module probe:
  // If `from myapp.services import auth`, `myapp.services` might be a module or package,
  // or `auth` might be a submodule (myapp/services/auth.py)
  if (Array.isArray(importedNames)) {
    for (const name of importedNames) {
      if (name && name !== "*") {
        const subCandidate = path.join(slashPath, name);
        const subProbe = probePythonCandidate(subCandidate, manifestFileSet);
        if (subProbe.runtimePath) {
          return {
            status: "internal_resolved",
            targetPath: subProbe.runtimePath,
            stubPath: subProbe.stubPath,
            candidates: subProbe.allCandidates,
            rule: "imported_submodule_probe",
          };
        }
        if (subProbe.stubPath) {
          return {
            status: "internal_resolved",
            targetPath: subProbe.stubPath,
            stubPath: subProbe.stubPath,
            candidates: subProbe.allCandidates,
            rule: "imported_stub_probe",
          };
        }
      }
    }
  }

  // 3. Parent-segment fallback:
  // If `import myapp.services.auth.User`, `myapp/services/auth.py` might exist (User is a symbol inside it)
  const segments = slashPath.split("/");
  for (let i = segments.length - 1; i >= 1; i--) {
    const parentPath = segments.slice(0, i).join("/");
    const parentProbe = probePythonCandidate(parentPath, manifestFileSet);
    if (parentProbe.runtimePath) {
      return {
        status: "internal_resolved",
        targetPath: parentProbe.runtimePath,
        stubPath: parentProbe.stubPath,
        candidates: parentProbe.allCandidates,
        rule: "parent_module_probe",
      };
    }
    if (parentProbe.stubPath) {
      return {
        status: "internal_resolved",
        targetPath: parentProbe.stubPath,
        stubPath: parentProbe.stubPath,
        candidates: parentProbe.allCandidates,
        rule: "parent_stub_probe",
      };
    }
  }

  return {
    status: "unresolved",
    rule: "unresolved_absolute",
  };
}

module.exports = {
  probePythonCandidate,
  resolveRelativePythonImport,
  resolveAbsolutePythonImport,
};
