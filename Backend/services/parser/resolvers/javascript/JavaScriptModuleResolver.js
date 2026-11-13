const { isNodeBuiltin, classifyPackageOrBuiltin } = require("./packageClassifier");
const { resolveRelativePath } = require("./candidateResolver");
const { extractPathAliases, resolvePathAlias } = require("./configReader");

const RESOLVER_VERSION = "1.0.0";

/**
 * JavaScript and TypeScript Module Resolution Engine.
 * Statically resolves module import and re-export specifiers against repository manifest paths
 * and optional configuration (tsconfig.json / jsconfig.json) without executing code.
 */
class JavaScriptModuleResolver {
  /**
   * @param {object} options
   * @param {Array<string|object>|Set<string>} options.manifest - Array of file paths, manifest objects, or Set of paths
   * @param {object} [options.supportingFiles] - Map of config filename to raw content (e.g. { "tsconfig.json": "..." })
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

    // Parse path aliases from tsconfig.json or jsconfig.json if available
    this.aliasConfig = null;
    const supporting = options.supportingFiles || {};
    const tsconfigContent = supporting["tsconfig.json"] || supporting["jsconfig.json"];
    if (tsconfigContent) {
      this.aliasConfig = extractPathAliases(tsconfigContent);
    }
  }

  /**
   * Statically resolves a single import or re-export specifier from a source file.
   *
   * @param {string} sourceFilePath - Path of the file containing the import (e.g. "src/App.tsx")
   * @param {string|null} rawSource - Specifier string (e.g. "./utils", "react", "fs")
   * @returns {{
   *   status: "internal_resolved"|"external_package"|"builtin"|"unresolved"|"ambiguous"|"dynamic",
   *   resolvedPath: string|null,
   *   candidates?: string[],
   *   rule: string,
   *   target?: string,
   *   packageName?: string
   * }}
   */
  resolveSpecifier(sourceFilePath, rawSource) {
    // 1. Dynamic / non-literal expressions (e.g. require(x) or import(x))
    if (!rawSource || typeof rawSource !== "string") {
      return {
        status: "dynamic",
        resolvedPath: null,
        rule: "dynamic_expression",
      };
    }

    const clean = rawSource.trim();

    // 2. Relative imports (e.g. "./utils", "../components/Button")
    if (clean.startsWith("./") || clean.startsWith("../") || clean.startsWith("/")) {
      const relResult = resolveRelativePath(sourceFilePath, clean, this.manifestFileSet);
      return {
        status: relResult.status,
        resolvedPath: relResult.targetPath || null,
        candidates: relResult.candidates || null,
        rule: relResult.rule || "relative_resolution",
      };
    }

    // 3. Check TypeScript path aliases (e.g. "@/components/Button")
    if (this.aliasConfig) {
      const aliasResult = resolvePathAlias(clean, this.aliasConfig, this.manifestFileSet);
      if (aliasResult && aliasResult.status === "internal_resolved") {
        return {
          status: "internal_resolved",
          resolvedPath: aliasResult.targetPath,
          rule: "tsconfig_alias",
        };
      }
      if (aliasResult && aliasResult.status === "ambiguous") {
        return {
          status: "ambiguous",
          resolvedPath: null,
          candidates: aliasResult.candidates,
          rule: "tsconfig_alias",
        };
      }
    }

    // 4. Node.js built-ins vs External packages
    const pkgResult = classifyPackageOrBuiltin(clean);
    return {
      status: pkgResult.status,
      resolvedPath: null,
      target: pkgResult.target,
      packageName: pkgResult.packageName,
      rule: pkgResult.status === "builtin" ? "node_builtin" : "external_package",
    };
  }

  /**
   * Resolves all imports and re-exports in a single FileIR document.
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

    // Resolve imports
    if (Array.isArray(fileIR.imports)) {
      for (const imp of fileIR.imports) {
        const res = this.resolveSpecifier(filePath, imp.rawSource);
        resolutions.push({
          id: imp.id,
          type: "import",
          rawSource: imp.rawSource,
          status: res.status,
          resolvedPath: res.resolvedPath,
          candidates: res.candidates || null,
          rule: res.rule,
          packageName: res.packageName || null,
          evidence: {
            sourceFile: filePath,
            location: imp.location,
            resolverVersion: RESOLVER_VERSION,
          },
        });
      }
    }

    // Resolve re-exports (exports with a source specifier)
    if (Array.isArray(fileIR.exports)) {
      for (const exp of fileIR.exports) {
        if (exp.source) {
          const res = this.resolveSpecifier(filePath, exp.source);
          resolutions.push({
            id: exp.id,
            type: "reexport",
            rawSource: exp.source,
            status: res.status,
            resolvedPath: res.resolvedPath,
            candidates: res.candidates || null,
            rule: res.rule,
            packageName: res.packageName || null,
            evidence: {
              sourceFile: filePath,
              location: exp.location,
              resolverVersion: RESOLVER_VERSION,
            },
          });
        }
      }
    }

    return {
      fileId,
      filePath,
      resolutions,
    };
  }

  /**
   * Resolves module dependencies across an entire parsed repository.
   *
   * @param {Array<object>} fileIRList - Array of parsed FileIR documents
   * @returns {{
   *   files: Array<object>,
   *   summary: {
   *     totalResolutions: number,
   *     internalResolved: number,
   *     externalPackages: number,
   *     builtins: number,
   *     unresolved: number,
   *     ambiguous: number,
   *     dynamic: number
   *   }
   * }}
   */
  resolveRepository(fileIRList = []) {
    const fileResolutions = [];
    const summary = {
      totalResolutions: 0,
      internalResolved: 0,
      externalPackages: 0,
      builtins: 0,
      unresolved: 0,
      ambiguous: 0,
      dynamic: 0,
    };

    for (const fileIR of fileIRList) {
      const fileRes = this.resolveFileIR(fileIR);
      fileResolutions.push(fileRes);

      for (const r of fileRes.resolutions) {
        summary.totalResolutions++;
        if (r.status === "internal_resolved") summary.internalResolved++;
        else if (r.status === "external_package") summary.externalPackages++;
        else if (r.status === "builtin") summary.builtins++;
        else if (r.status === "unresolved") summary.unresolved++;
        else if (r.status === "ambiguous") summary.ambiguous++;
        else if (r.status === "dynamic") summary.dynamic++;
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
  JavaScriptModuleResolver,
};

