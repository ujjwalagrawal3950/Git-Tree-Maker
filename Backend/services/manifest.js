const path = require("node:path").posix;

const DEFAULT_BUDGETS = {
  maxTreeEntries: 10000,
  maxIncludedFiles: 5000,
  maxFileSizeBytes: 1000000, // 1 MB
  maxTraversalRequests: 10,
};

// Directory segments that identify dependency, vendor, cache, or build artifacts
const EXCLUDED_DIR_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".git",
  ".github",
  ".next",
  ".nuxt",
  "out",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".cache",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "bower_components",
  "Pods",
]);

/**
 * Normalizes a raw tree path to be strictly relative to repository root.
 *
 * @param {string} rawPath
 * @returns {string} Normalized POSIX relative path
 */
function normalizeRepoPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return "";
  let clean = rawPath.replace(/\\/g, "/").trim();
  // Strip leading slashes
  clean = clean.replace(/^\/+/, "");
  // Normalize segments
  return path.normalize(clean);
}

/**
 * Determines whether a file path falls within an excluded directory.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isExcludedDirectoryPath(filePath) {
  const segments = filePath.split("/");
  // Check directory segments (all except the last if it's a file)
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i].toLowerCase();
    if (EXCLUDED_DIR_SEGMENTS.has(seg)) {
      return true;
    }
  }
  return false;
}

/**
 * Generates a normalized repository manifest from raw Git tree entries.
 *
 * @param {object} params
 * @param {string} params.repository - e.g. "octocat/hello-world"
 * @param {string} params.commitSha - Resolved immutable commit SHA
 * @param {string} params.rootTreeSha - Root Git tree SHA
 * @param {Array<object>} params.treeEntries - Raw tree entries from GitHub Git Tree API
 * @param {boolean} [params.truncated=false] - Whether the tree response was truncated
 * @param {string} [params.status="complete"] - "complete" | "partial" | "empty"
 * @param {object} [params.budgets] - Budget overrides
 * @returns {object} Normalized repository manifest
 */
function generateManifest({
  repository,
  commitSha,
  rootTreeSha,
  treeEntries = [],
  truncated = false,
  status = "complete",
  budgets = {},
}) {
  const effectiveBudgets = { ...DEFAULT_BUDGETS, ...budgets };

  if (!treeEntries || treeEntries.length === 0) {
    return {
      repository,
      commitSha,
      rootTreeSha,
      status: "empty",
      truncated: false,
      files: [],
      excluded: [],
      summary: {
        totalEntries: 0,
        totalFiles: 0,
        totalDirectories: 0,
        totalSkipped: 0,
        totalBytes: 0,
        isTruncated: false,
      },
    };
  }

  const files = [];
  const excluded = [];
  let totalDirectories = 0;
  let totalBytes = 0;
  let rawEntryCount = 0;

  for (const entry of treeEntries) {
    rawEntryCount++;

    if (rawEntryCount > effectiveBudgets.maxTreeEntries) {
      truncated = true;
      status = "partial";
      excluded.push({
        path: normalizeRepoPath(entry.path),
        name: path.basename(entry.path || ""),
        reason: "max_entries_exceeded",
        type: entry.type || "unknown",
        mode: entry.mode || null,
        size: typeof entry.size === "number" ? entry.size : null,
      });
      continue;
    }

    const cleanPath = normalizeRepoPath(entry.path);
    if (!cleanPath || cleanPath === "." || cleanPath.startsWith("../")) {
      continue;
    }

    const entryType = entry.type;
    const mode = entry.mode;
    const size = typeof entry.size === "number" ? entry.size : null;
    const name = path.basename(cleanPath);
    const ext = path.extname(cleanPath).toLowerCase();

    // 1. Directory entry (tree)
    if (entryType === "tree" || mode === "040000") {
      totalDirectories++;
      continue;
    }

    // 2. Submodule entry (commit / 160000)
    if (entryType === "commit" || mode === "160000") {
      excluded.push({
        path: cleanPath,
        name,
        reason: "submodule",
        type: "commit",
        sha: entry.sha || null,
        mode: mode || "160000",
        size: null,
      });
      continue;
    }

    // 3. Symlink entry (blob / 120000)
    if (mode === "120000") {
      excluded.push({
        path: cleanPath,
        name,
        reason: "symlink",
        type: "blob",
        sha: entry.sha || null,
        mode: "120000",
        size,
      });
      continue;
    }

    // 4. Excluded vendor / build / cache paths
    if (isExcludedDirectoryPath(cleanPath)) {
      excluded.push({
        path: cleanPath,
        name,
        reason: "vendor_or_build",
        type: entryType || "blob",
        sha: entry.sha || null,
        mode: mode || "100644",
        size,
      });
      continue;
    }

    // 5. Oversized files
    if (size !== null && size > effectiveBudgets.maxFileSizeBytes) {
      excluded.push({
        path: cleanPath,
        name,
        reason: "oversized",
        type: entryType || "blob",
        sha: entry.sha || null,
        mode: mode || "100644",
        size,
      });
      continue;
    }

    // 6. Maximum included files budget
    if (files.length >= effectiveBudgets.maxIncludedFiles) {
      truncated = true;
      status = "partial";
      excluded.push({
        path: cleanPath,
        name,
        reason: "budget_exceeded",
        type: entryType || "blob",
        sha: entry.sha || null,
        mode: mode || "100644",
        size,
      });
      continue;
    }

    // 7. Regular source file (blob)
    files.push({
      path: cleanPath,
      name,
      extension: ext,
      type: "blob",
      sha: entry.sha || null,
      size,
      mode: mode || "100644",
    });

    if (size !== null) {
      totalBytes += size;
    }
  }

  const finalStatus = truncated ? "partial" : status;

  return {
    repository,
    commitSha,
    rootTreeSha,
    status: finalStatus,
    truncated: Boolean(truncated),
    files,
    excluded,
    summary: {
      totalEntries: rawEntryCount,
      totalFiles: files.length,
      totalDirectories,
      totalSkipped: excluded.length,
      totalBytes,
      isTruncated: Boolean(truncated),
    },
  };
}

module.exports = {
  DEFAULT_BUDGETS,
  EXCLUDED_DIR_SEGMENTS,
  normalizeRepoPath,
  isExcludedDirectoryPath,
  generateManifest,
};

