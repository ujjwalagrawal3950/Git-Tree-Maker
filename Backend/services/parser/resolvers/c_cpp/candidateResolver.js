const path = require("node:path").posix;
const { classifyStandardHeader } = require("./standardHeaders");

/**
 * Normalizes a path to POSIX style (forward slashes).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

/**
 * Checks whether a candidate path escapes the repository root.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isPathEscapingRoot(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  const normalized = path.normalize(normalizePath(candidate));
  return (
    normalized.startsWith("..") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized)
  );
}

/**
 * Resolves a local relative include from the directory of the including file.
 *
 * @param {string} sourceFilePath
 * @param {string} includePath
 * @returns {{ escapes: boolean, candidate: string|null }}
 */
function resolveLocalRelative(sourceFilePath, includePath) {
  const sourceDir = path.dirname(normalizePath(sourceFilePath));
  const candidate = path.normalize(path.join(sourceDir, normalizePath(includePath)));

  if (isPathEscapingRoot(candidate)) {
    return { escapes: true, candidate: null };
  }
  return { escapes: false, candidate };
}

/**
 * Repository index for C/C++ includes.
 */
class CppRepositoryIndex {
  /**
   * @param {Set<string>} manifestFiles Set of normalized repository file paths
   */
  constructor(manifestFiles = new Set()) {
    this.manifestFiles = manifestFiles;
    this.basenameMap = new Map();

    for (const filePath of this.manifestFiles) {
      const basename = path.basename(filePath);
      if (!this.basenameMap.has(basename)) {
        this.basenameMap.set(basename, []);
      }
      this.basenameMap.get(basename).push(filePath);
    }
  }

  /**
   * Builds an index from manifest array or set.
   *
   * @param {Array<string|object>|Set<string>} manifest
   * @returns {CppRepositoryIndex}
   */
  static build(manifest) {
    const fileSet = new Set();
    if (manifest instanceof Set) {
      for (const p of manifest) fileSet.add(normalizePath(p));
    } else if (Array.isArray(manifest)) {
      for (const item of manifest) {
        if (typeof item === "string") {
          fileSet.add(normalizePath(item));
        } else if (item && typeof item.path === "string") {
          fileSet.add(normalizePath(item.path));
        }
      }
    }
    return new CppRepositoryIndex(fileSet);
  }

  /**
   * Resolves an include path against the repository manifest.
   *
   * @param {string} sourceFilePath - Path of the file containing the include
   * @param {string} rawInclude - Clean include text (e.g. "my_header.h", "../utils/math.h", "stdio.h")
   * @param {object} [options]
   * @param {"quoted"|"system"|"computed_macro"|"unknown"} [options.includeType="quoted"]
   * @param {string[]} [options.includeDirectories=[]]
   * @returns {{
   *   status: "internal_resolved"|"standard_library"|"external_package"|"ambiguous"|"unresolved"|"unsupported",
   *   resolvedPath: string|null,
   *   candidates: string[]|null,
   *   rule: string,
   *   category?: string|null
   * }}
   */
  resolveInclude(sourceFilePath, rawInclude, options = {}) {
    if (!rawInclude || typeof rawInclude !== "string") {
      return {
        status: "unresolved",
        resolvedPath: null,
        candidates: null,
        rule: "empty_include",
      };
    }

    const includeType = options.includeType || "quoted";
    const cleanInclude = rawInclude.trim();

    // 0. Macro-computed include (#include HEADER_MACRO)
    if (includeType === "computed_macro") {
      return {
        status: "unsupported",
        resolvedPath: null,
        candidates: null,
        rule: "computed_macro_include",
      };
    }

    // 1. Quoted include: source directory priority
    if (includeType === "quoted") {
      const { escapes, candidate } = resolveLocalRelative(sourceFilePath, cleanInclude);
      if (escapes) {
        return {
          status: "unresolved",
          resolvedPath: null,
          candidates: null,
          rule: "path_traversal_escapes_repository",
        };
      }
      if (candidate && this.manifestFiles.has(candidate)) {
        return {
          status: "internal_resolved",
          resolvedPath: candidate,
          candidates: [candidate],
          rule: "source_relative_directory",
        };
      }
    }

    // 2. Direct exact repository-relative path match (e.g. "include/project/foo.h")
    const exactPath = normalizePath(cleanInclude);
    if (!isPathEscapingRoot(exactPath) && this.manifestFiles.has(exactPath)) {
      return {
        status: "internal_resolved",
        resolvedPath: exactPath,
        candidates: [exactPath],
        rule: "exact_repository_path",
      };
    }

    // 3. Configured / Project Include Directories (e.g. ["include", "inc", "src"])
    const includeDirs = options.includeDirectories || ["include", "inc", "src"];
    const matchedFromDirs = [];

    for (const dir of includeDirs) {
      const candidate = path.normalize(path.join(normalizePath(dir), exactPath));
      if (!isPathEscapingRoot(candidate) && this.manifestFiles.has(candidate)) {
        matchedFromDirs.push(candidate);
      }
    }

    if (matchedFromDirs.length === 1) {
      return {
        status: "internal_resolved",
        resolvedPath: matchedFromDirs[0],
        candidates: matchedFromDirs,
        rule: "configured_include_directory",
      };
    }
    if (matchedFromDirs.length > 1) {
      return {
        status: "ambiguous",
        resolvedPath: null,
        candidates: matchedFromDirs,
        rule: "multiple_include_directory_matches",
      };
    }

    // 4. Standard Library & Platform API catalogue
    const stdClass = classifyStandardHeader(cleanInclude);
    if (stdClass.isStandard) {
      return {
        status: "standard_library",
        resolvedPath: null,
        candidates: null,
        rule: "standard_header_catalogue",
        category: stdClass.category,
      };
    }

    // 5. Basename check for detecting duplicate/ambiguous candidates across the repository
    // Note: Per blueprint constraints, we do NOT create an internal edge from basename matching alone.
    if (!cleanInclude.includes("/")) {
      const basenameCandidates = this.basenameMap.get(cleanInclude) || [];
      if (basenameCandidates.length > 1) {
        return {
          status: "ambiguous",
          resolvedPath: null,
          candidates: basenameCandidates,
          rule: "duplicate_repository_candidates",
        };
      }
    }

    // 6. Angle-bracket external third-party package assumption or unresolved
    if (includeType === "system") {
      return {
        status: "external_package",
        resolvedPath: null,
        candidates: null,
        rule: "system_angle_bracket_external",
      };
    }

    // 7. Unresolved
    return {
      status: "unresolved",
      resolvedPath: null,
      candidates: null,
      rule: "no_matching_evidence",
    };
  }
}

module.exports = {
  normalizePath,
  isPathEscapingRoot,
  resolveLocalRelative,
  CppRepositoryIndex,
};

