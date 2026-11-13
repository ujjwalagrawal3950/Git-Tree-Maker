const { classifyJavaPackage, checkJdkPackage } = require("./jdkPackages");
const { JavaRepositoryIndex, normalizePath } = require("./candidateResolver");
const { readBuildMetadata } = require("./buildMetadataReader");

const RESOLVER_VERSION = "1.0.0";

/**
 * Maps categorized platform package classifications to resolution status and rules.
 *
 * @param {string} category
 * @param {string} matchedPackage
 * @returns {object|null}
 */
function mapPlatformClassification(category, matchedPackage) {
  if (category === "java_se") {
    return {
      status: "standard_library",
      resolvedPath: null,
      candidates: null,
      rule: "java_se_platform_package",
      packageName: matchedPackage,
    };
  }
  if (category === "jdk_internal") {
    return {
      status: "standard_library",
      resolvedPath: null,
      candidates: null,
      rule: "jdk_internal_api",
      packageName: matchedPackage,
    };
  }
  if (category === "jdk_tool") {
    return {
      status: "standard_library",
      resolvedPath: null,
      candidates: null,
      rule: "jdk_tool_api",
      packageName: matchedPackage,
    };
  }
  if (category === "java_ee") {
    return {
      status: "external_package",
      resolvedPath: null,
      candidates: null,
      rule: "java_ee_specification",
      packageName: matchedPackage,
    };
  }
  return null;
}

/**
 * Common well-known external third-party namespace prefixes.
 * Used when a package is not declared in minimal build metadata but belongs to standard third-party ecosystems.
 */
const COMMON_EXTERNAL_PREFIXES = [
  "org.springframework.",
  "org.apache.",
  "org.junit.",
  "org.mockito.",
  "org.slf4j.",
  "org.hibernate.",
  "com.google.common.",
  "com.fasterxml.jackson.",
  "io.netty.",
  "okhttp3.",
  "retrofit2.",
  "ch.qos.logback.",
];

/**
 * Java Import and Type Resolution Engine.
 * Statically resolves Java import declarations against repository type indices,
 * standard JDK catalogs, and Maven/Gradle build metadata without executing Java code.
 */
class JavaImportResolver {
  /**
   * @param {object} options
   * @param {Array<string|object>|Set<string>} [options.manifest] Known repository file paths or manifest items
   * @param {Map<string, object>|Array<object>} [options.parsedFiles] Pre-parsed FileIR documents
   * @param {object} [options.supportingFiles] Map of build filenames to text content (e.g. { "pom.xml": "...", "build.gradle": "..." })
   */
  constructor(options = {}) {
    this.manifest = options.manifest || [];
    this.parsedFiles = options.parsedFiles || null;
    this.supportingFiles = options.supportingFiles || {};

    // 1. Build in-memory type and package index
    this.index = JavaRepositoryIndex.build(this.manifest, this.parsedFiles);

    // 2. Parse build metadata from pom.xml / build.gradle safely
    this.buildMetadata = readBuildMetadata(this.supportingFiles);
  }

  /**
   * Resolves a single Java import declaration.
   *
   * @param {string} sourceFilePath File path of the importing class
   * @param {string} rawSource Full import string (e.g. "com.example.service.UserService", "java.util.*", "java.lang.Math.PI")
   * @param {object} [meta] Metadata from syntax extraction
   * @param {boolean} [meta.isStatic=false]
   * @param {boolean} [meta.isWildcard=false]
   * @param {string} [meta.packageName=""]
   * @param {string} [meta.className]
   * @param {string} [meta.memberName]
   * @param {string} [meta.importedType]
   * @returns {{
   *   status: "internal_resolved"|"standard_library"|"external_package"|"wildcard"|"ambiguous"|"unresolved",
   *   resolvedPath: string|null,
   *   candidates: string[]|null,
   *   rule: string,
   *   packageName: string|null
   * }}
   */
  resolveImport(sourceFilePath, rawSource, meta = {}) {
    if (!rawSource || typeof rawSource !== "string") {
      return {
        status: "unresolved",
        resolvedPath: null,
        candidates: null,
        rule: "empty_import",
        packageName: null,
      };
    }

    const clean = rawSource.trim();
    const isStatic = Boolean(meta.isStatic);
    const isWildcard = Boolean(meta.isWildcard) || clean.endsWith(".*");

    // 1. Wildcard package or static on-demand import
    if (isWildcard) {
      const targetPackage = clean.replace(/\.\*$/, "").trim();

      // Check if internal repository package
      const internalWildcard = this.index.resolveWildcardPackage(targetPackage);
      if (internalWildcard.status === "wildcard") {
        return {
          status: "wildcard",
          resolvedPath: null,
          candidates: internalWildcard.candidates,
          rule: "internal_package_wildcard",
          packageName: targetPackage,
        };
      }

      // Check platform package (Java SE, Java EE, JDK internal, JDK tool)
      const platformClass = classifyJavaPackage(targetPackage);
      const platformRes = mapPlatformClassification(platformClass.category, platformClass.matchedPackage);
      if (platformRes) {
        return platformRes;
      }

      // Check external build dependencies
      if (this.isDeclaredExternal(targetPackage)) {
        return {
          status: "external_package",
          resolvedPath: null,
          candidates: null,
          rule: "declared_build_dependency",
          packageName: targetPackage,
        };
      }

      // Check known external prefix
      if (COMMON_EXTERNAL_PREFIXES.some((p) => targetPackage.startsWith(p))) {
        return {
          status: "external_package",
          resolvedPath: null,
          candidates: null,
          rule: "external_namespace_heuristic",
          packageName: targetPackage,
        };
      }

      return {
        status: "unresolved",
        resolvedPath: null,
        candidates: null,
        rule: "unresolved_wildcard_target",
        packageName: targetPackage,
      };
    }

    // 2. Static single-member import (e.g. import static com.example.Constants.TIMEOUT;)
    if (isStatic) {
      const parts = clean.split(".");
      const memberName = parts[parts.length - 1];
      const owningType = parts.slice(0, -1).join(".");

      // Try internal owning type match
      const staticRes = this.index.resolveStaticMember(owningType, memberName);
      if (staticRes.status === "internal_resolved") {
        return {
          status: "internal_resolved",
          resolvedPath: staticRes.targetPath,
          candidates: staticRes.candidates,
          rule: "static_member_owning_type_match",
          packageName: owningType,
        };
      }
      if (staticRes.status === "ambiguous") {
        return {
          status: "ambiguous",
          resolvedPath: null,
          candidates: staticRes.candidates,
          rule: "duplicate_static_owning_types",
          packageName: owningType,
        };
      }

      // Try platform static member (e.g. java.lang.Math.PI, sun.misc.Unsafe)
      const platformClass = classifyJavaPackage(owningType);
      const platformRes = mapPlatformClassification(platformClass.category, platformClass.matchedPackage);
      if (platformRes) {
        return platformRes;
      }

      // External package check
      if (this.isDeclaredExternal(owningType)) {
        return {
          status: "external_package",
          resolvedPath: null,
          candidates: null,
          rule: "declared_build_dependency",
          packageName: owningType,
        };
      }

      return {
        status: "unresolved",
        resolvedPath: null,
        candidates: null,
        rule: "unresolved_static_target",
        packageName: owningType,
      };
    }

    // 3. Normal single-type import (e.g. import com.example.service.UserService; or Outer.Inner)
    const internalRes = this.index.resolveSingleType(clean);
    if (internalRes.status === "internal_resolved") {
      return {
        status: "internal_resolved",
        resolvedPath: internalRes.targetPath,
        resolvedSymbolId: internalRes.targetSymbolId || null,
        resolvedSymbolName: internalRes.targetSymbolName || null,
        candidates: internalRes.candidates,
        rule: "exact_type_match",
        packageName: clean.split(".").slice(0, -1).join("."),
      };
    }
    if (internalRes.status === "ambiguous") {
      return {
        status: "ambiguous",
        resolvedPath: null,
        resolvedSymbolId: null,
        resolvedSymbolName: null,
        candidates: internalRes.candidates,
        rule: "duplicate_type_declarations",
        packageName: clean.split(".").slice(0, -1).join("."),
      };
    }

    // 4. Check platform types (Java SE, Java EE, JDK internal, JDK tool)
    const platformClass = classifyJavaPackage(clean);
    const platformRes = mapPlatformClassification(platformClass.category, platformClass.matchedPackage);
    if (platformRes) {
      return platformRes;
    }

    // 5. Check declared build dependencies (pom.xml / build.gradle)
    if (this.isDeclaredExternal(clean)) {
      return {
        status: "external_package",
        resolvedPath: null,
        candidates: null,
        rule: "declared_build_dependency",
        packageName: clean.split(".").slice(0, -1).join("."),
      };
    }

    // 6. Check common external prefixes heuristic
    if (COMMON_EXTERNAL_PREFIXES.some((p) => clean.startsWith(p))) {
      return {
        status: "external_package",
        resolvedPath: null,
        candidates: null,
        rule: "external_namespace_heuristic",
        packageName: clean.split(".").slice(0, -1).join("."),
      };
    }

    // 7. Unresolved
    return {
      status: "unresolved",
      resolvedPath: null,
      candidates: null,
      rule: "no_matching_evidence",
      packageName: null,
    };
  }

  /**
   * Checks whether a package or type prefix matches declared build dependencies.
   *
   * @param {string} target
   * @returns {boolean}
   */
  isDeclaredExternal(target) {
    if (!target) return false;
    for (const pkg of this.buildMetadata.declaredPackages) {
      if (target.startsWith(pkg) || pkg.startsWith(target)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves all imports within a FileIR document.
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
        const res = this.resolveImport(filePath, imp.rawSource, langMeta);

        resolutions.push({
          id: imp.id,
          type: "import",
          rawSource: imp.rawSource,
          status: res.status,
          resolvedPath: res.resolvedPath,
          resolvedSymbolId: res.resolvedSymbolId || null,
          resolvedSymbolName: res.resolvedSymbolName || null,
          candidates: res.candidates || null,
          rule: res.rule,
          packageName: res.packageName || null,
          evidence: {
            sourceFile: filePath,
            location: imp.location,
            resolverVersion: RESOLVER_VERSION,
            isStatic: Boolean(langMeta.isStatic),
            isWildcard: Boolean(langMeta.isWildcard),
            fullyQualifiedName: langMeta.fullyQualifiedName || imp.rawSource,
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
   * Resolves all imports across multiple FileIR documents in a repository.
   *
   * @param {Array<object>} fileIRs
   * @returns {{
   *   summary: {
   *     totalImports: number,
   *     internalResolved: number,
   *     standardLibrary: number,
   *     externalPackage: number,
   *     wildcard: number,
   *     ambiguous: number,
   *     unresolved: number
   *   },
   *   fileResolutions: Array<object>
   * }}
   */
  resolveRepository(fileIRs = []) {
    const fileResolutions = [];
    const summary = {
      totalImports: 0,
      internalResolved: 0,
      standardLibrary: 0,
      externalPackage: 0,
      wildcard: 0,
      ambiguous: 0,
      unresolved: 0,
    };

    for (const ir of fileIRs) {
      const fileRes = this.resolveFileIR(ir);
      fileResolutions.push(fileRes);

      for (const r of fileRes.resolutions) {
        summary.totalImports++;
        if (r.status === "internal_resolved") summary.internalResolved++;
        else if (r.status === "standard_library") summary.standardLibrary++;
        else if (r.status === "external_package") summary.externalPackage++;
        else if (r.status === "wildcard") summary.wildcard++;
        else if (r.status === "ambiguous") summary.ambiguous++;
        else summary.unresolved++;
      }
    }

    return { summary, fileResolutions };
  }
}

module.exports = {
  JavaImportResolver,
  RESOLVER_VERSION,
};

