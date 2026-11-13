/**
 * Node.js core built-in module names.
 */
const NODE_BUILTIN_MODULES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/**
 * Checks if an import specifier refers to a Node.js built-in module.
 * Matches both standard names (e.g. "fs", "path") and "node:" prefixed names (e.g. "node:fs").
 *
 * @param {string} specifier
 * @returns {boolean}
 */
function isNodeBuiltin(specifier) {
  if (!specifier || typeof specifier !== "string") return false;

  const clean = specifier.trim();
  if (clean.startsWith("node:")) {
    const bare = clean.slice(5);
    return NODE_BUILTIN_MODULES.has(bare);
  }

  // Handle subpath builtins like "fs/promises", "stream/web"
  const base = clean.split("/")[0];
  return NODE_BUILTIN_MODULES.has(base);
}

/**
 * Extracts the base package name from an external specifier.
 * Handles scoped packages (e.g. "@clerk/backend" -> "@clerk/backend")
 * and standard packages (e.g. "lodash/get" -> "lodash").
 *
 * @param {string} specifier
 * @returns {string}
 */
function extractPackageName(specifier) {
  if (!specifier || typeof specifier !== "string") return "unknown";

  const clean = specifier.trim();
  if (clean.startsWith("@")) {
    const parts = clean.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : clean;
  }
  return clean.split("/")[0];
}

/**
 * Classifies an import specifier that is not relative or absolute.
 *
 * @param {string} specifier
 * @returns {{
 *   status: "builtin"|"external_package",
 *   target: string,
 *   packageName?: string
 * }}
 */
function classifyPackageOrBuiltin(specifier) {
  if (isNodeBuiltin(specifier)) {
    return {
      status: "builtin",
      target: specifier,
    };
  }

  return {
    status: "external_package",
    target: specifier,
    packageName: extractPackageName(specifier),
  };
}

module.exports = {
  NODE_BUILTIN_MODULES,
  isNodeBuiltin,
  extractPackageName,
  classifyPackageOrBuiltin,
};

