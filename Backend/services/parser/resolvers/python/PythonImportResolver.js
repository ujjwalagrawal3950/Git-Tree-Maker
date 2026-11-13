const { isPythonStdlib } = require("./stdlibModules");
const {
  resolveRelativePythonImport,
  resolveAbsolutePythonImport,
} = require("./candidateResolver");
const {
  parseRequirementsTxt,
  parseRequiresPython,
  classifyPythonModule,
} = require("./packageClassifier");

const RESOLVER_VERSION = "1.0.0";

/**
 * Python Module and Import Resolution Engine.
 * Statically resolves Python import forms (import, from ... import, relative imports)
 * against repository manifest paths, standard library catalogs, and dependency metadata
 * without executing Python code.
 *
 * Implements Phase 07 user corrections:
 * 1. Schema integrity: Does not mutate FileIR.imports syntax objects; produces separate resolution records.
 * 2. Typing stub separation: Prioritizes .py runtime modules and surfaces .pyi stubs distinctly.
 */
class PythonImportResolver {
  /**
   * @param {object} options
   * @param {Array<string|object>|Set<string>} options.manifest - Known repository file paths or objects
   * @param {object} [options.supportingFiles] - Map of configuration filename to content (e.g. { "requirements.txt": "...", "pyproject.toml": "..." })
   */
  constructor(options = {}) {
    this.manifestFileSet = new Set();

    if (options.manifest) {
      if (options.manifest instanceof Set) {
        this.manifestFileSet = options.manifest;
      } else if (Array.isArray(options.manifest)) {
        for (const item of options.manifest) {
          if (typeof item === "string") {
            this.manifestFileSet.add(item);
          } else if (item && typeof item.path === "string") {
            this.manifestFileSet.add(item.path);
          }
        }
      }
    }

    const supporting = options.supportingFiles || {};

    // Parse declared dependencies from requirements.txt if present
    this.declaredPackages = new Set();
    const reqContent =
      supporting["requirements.txt"] ||
      supporting["requirements-dev.txt"] ||
      supporting["requirements/base.txt"];

    if (reqContent) {
      this.declaredPackages = parseRequirementsTxt(reqContent);
    }

    // Safely extract target Python version from pyproject.toml requires-python
    this.targetPythonVersion = null;
    const pyprojectContent = supporting["pyproject.toml"];
    if (pyprojectContent) {
      this.targetPythonVersion = parseRequiresPython(pyprojectContent);
    }
  }

  /**
   * Statically resolves a single Python import declaration.
   *
   * @param {string} sourceFilePath - Path of the file containing the import (e.g. "pkg/services/auth.py")
   * @param {string|null} rawSource - Module specifier string (e.g. ".utils", "myapp.models", "os", "requests")
   * @param {object} [meta] - Context metadata from syntax extraction
   * @param {number} [meta.relativeLevel=0] - Number of leading dots for relative imports
   * @param {boolean} [meta.isRelative=false] - Whether the import is relative
   * @param {boolean} [meta.isDynamic=false] - Whether the import is dynamic (e.g. __import__)
   * @param {Array<string>} [meta.importedNames=[]] - List of imported names
   * @returns {{
   *   status: "internal_resolved"|"standard_library"|"external_package"|"unresolved"|"ambiguous"|"dynamic",
   *   resolvedPath: string|null,
   *   stubPath: string|null,
   *   candidates: string[]|null,
   *   rule: string,
   *   packageName: string|null
   * }}
   */
  resolveImport(sourceFilePath, rawSource, meta = {}) {
    const isDynamic = Boolean(meta.isDynamic);
    const isRelative = Boolean(meta.isRelative);
    const relativeLevel = Number(meta.relativeLevel || 0);
    const importedNames = Array.isArray(meta.importedNames) ? meta.importedNames : [];

    // 1. Dynamic / runtime import calls (e.g. __import__(name) or importlib.import_module(name))
    if (isDynamic || !rawSource || typeof rawSource !== "string") {
      return {
        status: "dynamic",
        resolvedPath: null,
        stubPath: null,
        candidates: null,
        rule: "dynamic_expression",
        packageName: null,
      };
    }

    const clean = rawSource.trim();

    // 2. Relative imports (e.g. from . import utils, from ..common.types import User)
    if (isRelative || relativeLevel > 0 || clean.startsWith(".")) {
      const level = relativeLevel > 0 ? relativeLevel : (clean.match(/^\.+/)?.[0].length || 1);
      const subpath = clean.replace(/^\.+/, "");

      const relResult = resolveRelativePythonImport(
        sourceFilePath,
        level,
        subpath,
        this.manifestFileSet,
        importedNames
      );

      return {
        status: relResult.status,
        resolvedPath: relResult.targetPath || null,
        stubPath: relResult.stubPath || null,
        candidates: relResult.candidates || null,
        rule: relResult.rule || "relative_resolution",
        packageName: null,
      };
    }

    // 3. Absolute imports: first probe internal repository modules/packages
    const absResult = resolveAbsolutePythonImport(
      clean,
      this.manifestFileSet,
      importedNames
    );

    if (absResult.status === "internal_resolved") {
      return {
        status: "internal_resolved",
        resolvedPath: absResult.targetPath || null,
        stubPath: absResult.stubPath || null,
        candidates: absResult.candidates || null,
        rule: absResult.rule || "internal_module_probe",
        packageName: null,
      };
    }

    // 4. Standard Library check & External Package classification (version-aware)
    const pkgClass = classifyPythonModule(
      clean,
      this.declaredPackages,
      this.targetPythonVersion
    );

    return {
      status: pkgClass.status,
      resolvedPath: null,
      stubPath: null,
      candidates: null,
      rule: pkgClass.rule || (pkgClass.status === "standard_library" ? "python_stdlib" : "external_package"),
      packageName: pkgClass.packageName,
      versionCertainty: pkgClass.versionCertainty || "confirmed",
    };
  }

  /**
   * Resolves all imports in a single FileIR document.
   *
   * @param {object} fileIR - A valid FileIR document
   * @returns {{
   *   fileId: string,
   *   filePath: string,
   *   resolutions: Array<object>
   * }}
   */
  resolveFileIR(fileIR) {
    if (!fileIR || !fileIR.analysis || !fileIR.analysis.file) {
      return { fileId: "unknown", filePath: "unknown", resolutions: [] };
    }

    const filePath = fileIR.analysis.file.path;
    const fileId = fileIR.analysis.file.fileId;
    const resolutions = [];

    if (Array.isArray(fileIR.imports)) {
      for (const imp of fileIR.imports) {
        const langMeta = imp.languageMetadata || {};
        const importedNames = (imp.specifiers || []).map((s) => s.importedName).filter(Boolean);

        const res = this.resolveImport(filePath, imp.rawSource, {
          relativeLevel: langMeta.relativeLevel || 0,
          isRelative: Boolean(langMeta.isRelative),
          isDynamic: Boolean(langMeta.isDynamic) || imp.kind === "dynamic_import",
          importedNames,
        });

        resolutions.push({
          id: imp.id,
          type: "import",
          rawSource: imp.rawSource,
          status: res.status,
          resolvedPath: res.resolvedPath,
          stubPath: res.stubPath,
          candidates: res.candidates || null,
          rule: res.rule,
          packageName: res.packageName || null,
          evidence: {
            sourceFile: filePath,
            location: imp.location,
            resolverVersion: RESOLVER_VERSION,
            relativeLevel: langMeta.relativeLevel || 0,
            isRelative: Boolean(langMeta.isRelative),
            versionCertainty: res.versionCertainty || "confirmed",
          },
        });
      }
    }

    return {
      fileId,
      filePath,
      resolutions,
    };
  }

  /**
   * Resolves Python imports across an entire repository.
   *
   * @param {Array<object>} fileIRList - Array of parsed FileIR documents
   * @returns {{
   *   files: Array<object>,
   *   summary: {
   *     totalResolutions: number,
   *     internalResolved: number,
   *     standardLibrary: number,
   *     externalPackages: number,
   *     unresolved: number,
   *     ambiguous: number,
   *     dynamic: number,
   *     stubCount: number
   *   }
   * }}
   */
  resolveRepository(fileIRList = []) {
    const fileResolutions = [];
    const summary = {
      totalResolutions: 0,
      internalResolved: 0,
      standardLibrary: 0,
      externalPackages: 0,
      unresolved: 0,
      ambiguous: 0,
      dynamic: 0,
      stubCount: 0,
    };

    for (const fileIR of fileIRList) {
      const fileRes = this.resolveFileIR(fileIR);
      fileResolutions.push(fileRes);

      for (const r of fileRes.resolutions) {
        summary.totalResolutions++;
        if (r.status === "internal_resolved") summary.internalResolved++;
        else if (r.status === "standard_library") summary.standardLibrary++;
        else if (r.status === "external_package") summary.externalPackages++;
        else if (r.status === "unresolved") summary.unresolved++;
        else if (r.status === "ambiguous") summary.ambiguous++;
        else if (r.status === "dynamic") summary.dynamic++;

        if (r.stubPath) summary.stubCount++;
      }
    }

    return {
      files: fileResolutions,
      summary,
    };
  }
}

module.exports = {
  RESOLVER_VERSION,
  PythonImportResolver,
};
