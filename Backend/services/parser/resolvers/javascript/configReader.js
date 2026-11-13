const path = require("node:path").posix;
const { resolveRelativePath } = require("./candidateResolver");

/**
 * Safely strips comments and trailing commas from JSON/JSONC configuration content.
 * Never executes code.
 *
 * @param {string} content
 * @returns {object|null}
 */
function parseJsonc(content) {
  if (!content || typeof content !== "string") return null;

  try {
    // Strip block comments /* ... */
    let clean = content.replace(/\/\*[\s\S]*?\*\//g, "");
    // Strip line comments // ...
    clean = clean.replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Strip trailing commas before closing braces/brackets
    clean = clean.replace(/,\s*([}\]])/g, "$1");

    return JSON.parse(clean);
  } catch {
    return null;
  }
}

/**
 * Extracts compilerOptions.paths and baseUrl from tsconfig.json / jsconfig.json content.
 *
 * @param {string} configContent
 * @returns {{ baseUrl: string, paths: Record<string, string[]> }|null}
 */
function extractPathAliases(configContent) {
  const parsed = parseJsonc(configContent);
  if (!parsed || !parsed.compilerOptions) return null;

  const baseUrl = parsed.compilerOptions.baseUrl || ".";
  const paths = parsed.compilerOptions.paths || {};

  return {
    baseUrl,
    paths,
  };
}

/**
 * Resolves a module specifier against TypeScript path aliases (e.g. "@/components/Button" -> "src/components/Button").
 *
 * @param {string} specifier - The import specifier
 * @param {{ baseUrl: string, paths: Record<string, string[]> }} aliasConfig
 * @param {Set<string>} manifestFileSet - Set of all known repository paths
 * @returns {{
 *   status: "internal_resolved"|"ambiguous"|"unresolved",
 *   targetPath?: string,
 *   rule?: "tsconfig_alias"
 * }|null}
 */
function resolvePathAlias(specifier, aliasConfig, manifestFileSet) {
  if (!aliasConfig || !aliasConfig.paths || !specifier) return null;

  const { baseUrl, paths } = aliasConfig;

  for (const [pattern, targetPatterns] of Object.entries(paths)) {
    if (!Array.isArray(targetPatterns) || targetPatterns.length === 0) continue;

    // Wildcard alias: e.g. "@/*" -> ["src/*"]
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // e.g. "@/"
      if (specifier.startsWith(prefix)) {
        const remainder = specifier.slice(prefix.length); // e.g. "components/Button"

        for (const targetPattern of targetPatterns) {
          const targetPrefix = targetPattern.endsWith("/*")
            ? targetPattern.slice(0, -1)
            : targetPattern;
          const candidateBasePath = path.normalize(path.join(baseUrl, targetPrefix, remainder));

          // Probe relative path from repository root
          const resolution = resolveRelativePath(".", `./${candidateBasePath}`, manifestFileSet);
          if (resolution.status === "internal_resolved") {
            return {
              status: "internal_resolved",
              targetPath: resolution.targetPath,
              rule: "tsconfig_alias",
            };
          }
          if (resolution.status === "ambiguous") {
            return {
              status: "ambiguous",
              candidates: resolution.candidates,
              rule: "tsconfig_alias",
            };
          }
        }
      }
    }
    // Exact alias: e.g. "utils" -> ["src/utils/index.ts"]
    else if (pattern === specifier) {
      for (const targetPattern of targetPatterns) {
        const candidateBasePath = path.normalize(path.join(baseUrl, targetPattern));
        const resolution = resolveRelativePath(".", `./${candidateBasePath}`, manifestFileSet);
        if (resolution.status === "internal_resolved") {
          return {
            status: "internal_resolved",
            targetPath: resolution.targetPath,
            rule: "tsconfig_alias",
          };
        }
      }
    }
  }

  return null;
}

module.exports = {
  parseJsonc,
  extractPathAliases,
  resolvePathAlias,
};

