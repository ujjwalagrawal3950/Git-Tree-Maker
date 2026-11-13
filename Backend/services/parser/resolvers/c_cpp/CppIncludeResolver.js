const { CppRepositoryIndex, normalizePath } = require("./candidateResolver");
const { readCppBuildMetadata } = require("./buildMetadataReader");

const RESOLVER_VERSION = "1.0.0";

/**
 * C/C++ Header Include Resolution Engine.
 * Statically resolves #include directives against repository manifest paths,
 * standard C/C++ library catalogues, and translation-unit-specific compilation databases
 * without executing preprocessors, compilers, or build scripts.
 */
class CppIncludeResolver {
  /**
   * @param {object} options
   * @param {Array<string|object>|Set<string>} [options.manifest] Known repository file paths or manifest items
   * @param {string[]} [options.includeDirectories] Custom include directories (e.g. ["include", "src"])
   * @param {object} [options.supportingFiles] Supporting configuration files (e.g. { "compile_commands.json": "..." })
   * @param {object} [options.buildMetadata] Pre-parsed build metadata
   */
  constructor(options = {}) {
    this.manifest = options.manifest || [];
    this.supportingFiles = options.supportingFiles || {};
    this.buildMetadata = options.buildMetadata || readCppBuildMetadata(this.supportingFiles);
    this.includeDirectories = options.includeDirectories || ["include", "inc", "src"];
    this.index = CppRepositoryIndex.build(this.manifest);
  }

  /**
   * Resolves a single C/C++ include directive.
   *
   * @param {string} sourceFilePath - Repository-relative path of the importing file
   * @param {string} rawSource - Clean include string (e.g. "stdio.h", "my_header.hpp", "../utils/math.h")
   * @param {object} [languageMetadata] - Metadata from syntax extraction (e.g. includeType, isConditional, condition)
   * @returns {{
   *   status: "internal_resolved"|"standard_library"|"external_package"|"ambiguous"|"unresolved"|"unsupported",
   *   resolvedPath: string|null,
   *   candidates: string[]|null,
   *   rule: string,
   *   category?: string|null
   * }}
   */
  resolveInclude(sourceFilePath, rawSource, languageMetadata = {}) {
    const includeType = languageMetadata.includeType || (rawSource.startsWith("<") ? "system" : "quoted");
    const normSourcePath = normalizePath(sourceFilePath);

    // Look up translation-unit-specific include directories if compile_commands.json exists
    const tu = this.buildMetadata && this.buildMetadata.translationUnits
      ? this.buildMetadata.translationUnits.get(normSourcePath)
      : null;

    const includeDirs = tu && tu.includeDirectories && tu.includeDirectories.length > 0
      ? tu.includeDirectories
      : this.includeDirectories;

    return this.index.resolveInclude(sourceFilePath, rawSource, {
      includeType,
      includeDirectories: includeDirs,
    });
  }

  /**
   * Resolves all include directives within a FileIR document.
   *
   * @param {object} fileIR
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

    const filePath = normalizePath(fileIR.analysis.file.path);
    const fileId = fileIR.analysis.file.fileId;
    const resolutions = [];

    if (Array.isArray(fileIR.imports)) {
      for (const imp of fileIR.imports) {
        const langMeta = imp.languageMetadata || {};
        const res = this.resolveInclude(filePath, imp.rawSource, langMeta);

        resolutions.push({
          id: imp.id,
          type: "import",
          rawSource: imp.rawSource,
          status: res.status,
          resolvedPath: res.resolvedPath,
          candidates: res.candidates || null,
          rule: res.rule,
          evidence: {
            sourceFile: filePath,
            location: imp.location,
            resolverVersion: RESOLVER_VERSION,
            includeType: langMeta.includeType || "unknown",
            isConditional: Boolean(langMeta.isConditional),
            condition: langMeta.condition || null,
            category: res.category || null,
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
   * Resolves all include directives across multiple FileIR documents in a repository.
   *
   * @param {Array<object>} fileIRs
   * @returns {{
   *   summary: {
   *     totalIncludes: number,
   *     internalResolved: number,
   *     standardLibrary: number,
   *     externalPackage: number,
   *     ambiguous: number,
   *     unresolved: number,
   *     unsupported: number
   *   },
   *   files: Array<object>
   * }}
   */
  resolveRepository(fileIRs) {
    const files = [];
    const summary = {
      totalIncludes: 0,
      internalResolved: 0,
      standardLibrary: 0,
      externalPackage: 0,
      ambiguous: 0,
      unresolved: 0,
      unsupported: 0,
    };

    if (!Array.isArray(fileIRs)) {
      return { summary, files };
    }

    for (const ir of fileIRs) {
      const fileRes = this.resolveFileIR(ir);
      files.push(fileRes);

      for (const r of fileRes.resolutions) {
        summary.totalIncludes++;
        if (r.status === "internal_resolved") summary.internalResolved++;
        else if (r.status === "standard_library") summary.standardLibrary++;
        else if (r.status === "external_package") summary.externalPackage++;
        else if (r.status === "ambiguous") summary.ambiguous++;
        else if (r.status === "unsupported") summary.unsupported++;
        else summary.unresolved++;
      }
    }

    return { summary, files };
  }
}

module.exports = {
  CppIncludeResolver,
  RESOLVER_VERSION,
};
