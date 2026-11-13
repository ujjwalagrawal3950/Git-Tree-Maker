/**
 * Normalizes file path to forward slashes.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

/**
 * Common Java source root directory patterns across Maven, Gradle, Android, and flat layouts.
 */
const SOURCE_ROOT_PATTERNS = [
  /^(?:.*?\/)?src\/main\/java\//,
  /^(?:.*?\/)?src\/test\/java\//,
  /^(?:.*?\/)?src\/java\//,
  /^(?:.*?\/)?app\/src\/main\/java\//,
  /^(?:.*?\/)?app\/src\/test\/java\//,
  /^(?:.*?\/)?src\//,
];

/**
 * Infers package and type name from a file path using standard Java source root heuristics.
 *
 * @param {string} rawPath
 * @returns {{ packageName: string, typeName: string, fullyQualifiedName: string }}
 */
function inferFromPath(rawPath) {
  const norm = normalizePath(rawPath);
  let rel = norm;

  for (const pattern of SOURCE_ROOT_PATTERNS) {
    if (pattern.test(norm)) {
      rel = norm.replace(pattern, "");
      break;
    }
  }

  // Remove .java extension
  const withoutExt = rel.replace(/\.java$/i, "");
  const parts = withoutExt.split("/");
  const typeName = parts[parts.length - 1];
  const packageName = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
  const fullyQualifiedName = packageName ? `${packageName}.${typeName}` : typeName;

  return { packageName, typeName, fullyQualifiedName };
}

/**
 * In-memory index of Java types and packages within a repository.
 */
class JavaRepositoryIndex {
  constructor() {
    /** @type {Map<string, Array<{ filePath: string, fileId?: string, symbolId?: string }>>} */
    this.typeIndex = new Map();

    /** @type {Map<string, Set<string>>} */
    this.packageIndex = new Map();

    /** @type {Set<string>} */
    this.allFiles = new Set();
  }

  /**
   * Indexes a repository file from manifest or FileIR.
   *
   * @param {string} filePath
   * @param {object} [fileIR] Optional parsed FileIR document
   */
  addFile(filePath, fileIR = null) {
    const norm = normalizePath(filePath);
    if (!norm.endsWith(".java")) return;

    this.allFiles.add(norm);

    // Path-based convention indexing
    const pathInferred = inferFromPath(norm);
    if (pathInferred.fullyQualifiedName) {
      if (!this.typeIndex.has(pathInferred.fullyQualifiedName)) {
        this.typeIndex.set(pathInferred.fullyQualifiedName, []);
      }
      this.typeIndex.get(pathInferred.fullyQualifiedName).push({ filePath: norm });
    }
    if (pathInferred.packageName) {
      if (!this.packageIndex.has(pathInferred.packageName)) {
        this.packageIndex.set(pathInferred.packageName, new Set());
      }
      this.packageIndex.get(pathInferred.packageName).add(norm);
    }

    // Evidence-backed indexing from parsed FileIR symbols (includes top-level and nested types)
    if (fileIR && Array.isArray(fileIR.symbols) && fileIR.symbols.length > 0) {
      for (const sym of fileIR.symbols) {
        if (["class", "interface", "enum"].includes(sym.kind)) {
          const fqName = sym.qualifiedName || (pathInferred.packageName ? `${pathInferred.packageName}.${sym.name}` : sym.name);
          if (fqName) {
            if (!this.typeIndex.has(fqName)) {
              this.typeIndex.set(fqName, []);
            }
            const existing = this.typeIndex.get(fqName);
            const found = existing.find((e) => e.filePath === norm && (!e.symbolId || e.symbolId === sym.id));
            if (found) {
              found.fileId = fileIR.analysis?.file?.fileId;
              found.symbolId = sym.id;
              found.symbolName = sym.name;
              found.kind = sym.kind;
            } else {
              existing.push({
                filePath: norm,
                fileId: fileIR.analysis?.file?.fileId,
                symbolId: sym.id,
                symbolName: sym.name,
                kind: sym.kind,
              });
            }

            const pkg = fqName.includes(".") ? fqName.split(".").slice(0, -1).join(".") : "";
            if (pkg) {
              if (!this.packageIndex.has(pkg)) {
                this.packageIndex.set(pkg, new Set());
              }
              this.packageIndex.get(pkg).add(norm);
            }
          }
        }
      }
    }
  }

  /**
   * Builds an index from a collection of manifest paths and/or parsed FileIR objects.
   *
   * @param {Array<string|object>} manifestOrFiles
   * @param {Map<string, object>|Array<object>} [parsedFiles]
   * @returns {JavaRepositoryIndex}
   */
  static build(manifestOrFiles = [], parsedFiles = null) {
    const index = new JavaRepositoryIndex();

    // Map of parsed files by path if available
    const parsedMap = new Map();
    if (parsedFiles) {
      if (parsedFiles instanceof Map) {
        for (const [k, v] of parsedFiles.entries()) {
          parsedMap.set(normalizePath(k), v);
        }
      } else if (Array.isArray(parsedFiles)) {
        for (const f of parsedFiles) {
          if (f && f.analysis && f.analysis.file && f.analysis.file.path) {
            parsedMap.set(normalizePath(f.analysis.file.path), f);
          }
        }
      }
    }

    for (const item of manifestOrFiles) {
      const p = typeof item === "string" ? item : item?.path;
      if (p) {
        const norm = normalizePath(p);
        const ir = parsedMap.get(norm) || (typeof item === "object" && item.symbols ? item : null);
        index.addFile(norm, ir);
      }
    }

    return index;
  }

  /**
   * Resolves a single-type import (e.g. "com.example.service.UserService").
   *
   * @param {string} fullyQualifiedName
   * @returns {{
   *   status: "internal_resolved"|"ambiguous"|"unresolved",
   *   targetPath: string|null,
   *   candidates: string[]|null,
   *   rule: string
   * }}
   */
  resolveSingleType(fullyQualifiedName) {
    if (!fullyQualifiedName) {
      return { status: "unresolved", targetPath: null, candidates: null, rule: "empty_specifier" };
    }

    const matches = this.typeIndex.get(fullyQualifiedName);
    if (!matches || matches.length === 0) {
      return { status: "unresolved", targetPath: null, candidates: null, rule: "type_not_in_index" };
    }

    if (matches.length === 1) {
      return {
        status: "internal_resolved",
        targetPath: matches[0].filePath,
        targetSymbolId: matches[0].symbolId || null,
        targetSymbolName: matches[0].symbolName || null,
        candidates: [matches[0].filePath],
        rule: "exact_type_match",
      };
    }

    // Duplicate declarations found across different source roots
    return {
      status: "ambiguous",
      targetPath: null,
      targetSymbolId: null,
      targetSymbolName: null,
      candidates: matches.map((m) => m.filePath),
      rule: "duplicate_type_declarations",
    };
  }

  /**
   * Resolves a static single-member import (e.g. "com.example.util.Constants.MAX_RETRIES").
   *
   * @param {string} owningTypeFullyQualified
   * @param {string} memberName
   * @returns {{
   *   status: "internal_resolved"|"ambiguous"|"unresolved",
   *   targetPath: string|null,
   *   candidates: string[]|null,
   *   rule: string
   * }}
   */
  resolveStaticMember(owningTypeFullyQualified, memberName) {
    const typeRes = this.resolveSingleType(owningTypeFullyQualified);
    if (typeRes.status === "internal_resolved") {
      return {
        status: "internal_resolved",
        targetPath: typeRes.targetPath,
        candidates: typeRes.candidates,
        rule: "static_member_owning_type_match",
      };
    }
    if (typeRes.status === "ambiguous") {
      return {
        status: "ambiguous",
        targetPath: null,
        candidates: typeRes.candidates,
        rule: "duplicate_static_owning_types",
      };
    }
    return {
      status: "unresolved",
      targetPath: null,
      candidates: null,
      rule: "static_owning_type_not_found",
    };
  }

  /**
   * Resolves a wildcard on-demand package import (e.g. "com.example.models.*").
   *
   * @param {string} packageName
   * @returns {{
   *   status: "wildcard"|"unresolved",
   *   targetPath: null,
   *   candidates: string[]|null,
   *   rule: string
   * }}
   */
  resolveWildcardPackage(packageName) {
    if (!packageName) {
      return { status: "unresolved", targetPath: null, candidates: null, rule: "empty_package" };
    }

    const filesSet = this.packageIndex.get(packageName);
    if (filesSet && filesSet.size > 0) {
      const candidates = Array.from(filesSet).sort();
      return {
        status: "wildcard",
        targetPath: null,
        candidates,
        rule: "internal_package_wildcard",
      };
    }

    return {
      status: "unresolved",
      targetPath: null,
      candidates: null,
      rule: "package_not_in_repository",
    };
  }
}

module.exports = {
  JavaRepositoryIndex,
  inferFromPath,
  normalizePath,
};
