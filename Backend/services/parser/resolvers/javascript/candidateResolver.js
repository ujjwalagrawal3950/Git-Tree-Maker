const path = require("node:path").posix;

/**
 * Standard source and configuration extensions probed in deterministic priority order.
 */
const PROBE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
];

/**
 * Resolves a repository-relative import specifier against a set of known repository files.
 *
 * Evaluation sequence:
 * 1. Exact match (e.g. "./styles.css" -> "src/styles.css")
 * 2. Extension probing (e.g. "./utils" -> "src/utils.ts")
 * 3. Directory index resolution (e.g. "./components" -> "src/components/index.tsx")
 *
 * @param {string} sourceFilePath - Repository-relative path of the importing file (e.g. "src/app.tsx")
 * @param {string} specifier - The import specifier (e.g. "./utils" or "../components/Button")
 * @param {Set<string>} manifestFileSet - Set of all known repository-relative paths
 * @returns {{
 *   status: "internal_resolved"|"ambiguous"|"unresolved",
 *   targetPath?: string,
 *   candidates?: string[],
 *   rule?: "exact_match"|"extension_probing"|"index_resolution"|"unresolved"
 * }}
 */
function resolveRelativePath(sourceFilePath, specifier, manifestFileSet) {
  if (!specifier || typeof specifier !== "string" || !manifestFileSet) {
    return { status: "unresolved", rule: "unresolved" };
  }

  const sourceDir = path.dirname(sourceFilePath || ".");
  // Normalize POSIX path (e.g. "src/components/../utils" -> "src/utils")
  const basePath = path.normalize(path.join(sourceDir, specifier));

  // 1. Exact match
  if (manifestFileSet.has(basePath)) {
    return {
      status: "internal_resolved",
      targetPath: basePath,
      rule: "exact_match",
    };
  }

  // 2. Extension probing
  const extCandidates = [];
  for (const ext of PROBE_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (manifestFileSet.has(candidate)) {
      extCandidates.push(candidate);
    }
  }

  if (extCandidates.length === 1) {
    return {
      status: "internal_resolved",
      targetPath: extCandidates[0],
      rule: "extension_probing",
    };
  }
  if (extCandidates.length > 1) {
    return {
      status: "ambiguous",
      candidates: extCandidates,
      rule: "extension_probing",
    };
  }

  // 3. Directory / Index resolution
  const indexCandidates = [];
  for (const ext of PROBE_EXTENSIONS) {
    const candidate = path.join(basePath, `index${ext}`);
    if (manifestFileSet.has(candidate)) {
      indexCandidates.push(candidate);
    }
  }

  if (indexCandidates.length === 1) {
    return {
      status: "internal_resolved",
      targetPath: indexCandidates[0],
      rule: "index_resolution",
    };
  }
  if (indexCandidates.length > 1) {
    return {
      status: "ambiguous",
      candidates: indexCandidates,
      rule: "index_resolution",
    };
  }

  // Target does not exist in repository manifest
  return {
    status: "unresolved",
    rule: "unresolved",
  };
}

module.exports = {
  PROBE_EXTENSIONS,
  resolveRelativePath,
};

