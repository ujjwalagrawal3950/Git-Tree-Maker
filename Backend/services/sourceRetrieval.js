const crypto = require("node:crypto");
const { classifyFile } = require("./languageRegistry");
const { fetchGitBlob } = require("./github");
const { AppError } = require("../lib/errors");

const DEFAULT_RETRIEVAL_BUDGETS = {
  maxRetrievalFiles: 50,
  maxTotalBytes: 2000000, // 2 MB total
  maxFileSizeBytes: 1000000, // 1 MB per file (consistent with Phase 03)
  concurrency: 5,
  maxRetries: 1,
};

// Strict UTF-8 decoder that throws on invalid byte sequences
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Validates and decodes a Base64 blob into a clean UTF-8 string.
 * Uses strict fatal UTF-8 decoding and detects binary null bytes.
 *
 * @param {string} base64Content
 * @param {string} [encoding="base64"]
 * @returns {{ isValid: boolean, content: string | null, byteLength: number, buffer?: Buffer, reason?: string }}
 */
function decodeAndValidateUtf8Blob(base64Content, encoding = "base64") {
  if (encoding !== "base64") {
    return { isValid: false, reason: "unsupported_encoding", content: null, byteLength: 0 };
  }

  const clean = (base64Content || "").replace(/\s+/g, "");

  if (clean.length > 0 && !/^[A-Za-z0-9+/=]+$/.test(clean)) {
    return { isValid: false, reason: "invalid_base64", content: null, byteLength: 0 };
  }

  try {
    const buffer = Buffer.from(clean, "base64");

    // 1. Binary check: null bytes indicate binary content
    if (buffer.includes(0)) {
      return { isValid: false, reason: "binary_content", content: null, byteLength: buffer.length };
    }

    // 2. Strict UTF-8 validation using fatal decoder
    // This allows legitimate Unicode (such as literal U+FFFD characters in code/tests),
    // but throws on genuinely corrupt or non-UTF-8 byte sequences.
    let text;
    try {
      text = strictUtf8Decoder.decode(buffer);
    } catch {
      return { isValid: false, reason: "invalid_utf8", content: null, byteLength: buffer.length };
    }

    return { isValid: true, content: text, byteLength: buffer.length, buffer };
  } catch {
    return { isValid: false, reason: "decoding_error", content: null, byteLength: 0 };
  }
}

/**
 * Runs tasks concurrently with a bounded pool limit.
 *
 * @param {Array<T>} items
 * @param {number} concurrency
 * @param {Function} workerFn
 * @returns {Promise<Array<R>>}
 */
async function runBoundedPool(items, concurrency, workerFn) {
  if (!items || items.length === 0) return [];
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await workerFn(items[currentIndex], currentIndex);
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency || 5, items.length));
  const workers = [];
  for (let i = 0; i < poolSize; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Selects eligible files from a repository manifest based on language registry,
 * supporting file allowlists, and resource budgets.
 *
 * @param {Array<object>} manifestFiles - Files from Phase 03 manifest
 * @param {object} [options]
 * @param {string[]} [options.paths] - Optional explicit path subset filter
 * @param {boolean} [options.includeDocumentation=false]
 * @param {number} [options.maxFileSizeBytes]
 * @returns {{ eligible: Array<object>, skipped: Array<object> }}
 */
function selectEligibleFiles(manifestFiles, options = {}) {
  const maxFileSize = options.maxFileSizeBytes || DEFAULT_RETRIEVAL_BUDGETS.maxFileSizeBytes;
  const pathFilter = Array.isArray(options.paths) && options.paths.length > 0
    ? new Set(options.paths.map((p) => p.trim()))
    : null;

  const eligible = [];
  const skipped = [];

  for (const file of manifestFiles || []) {
    // 1. Explicit path filter check
    if (pathFilter && !pathFilter.has(file.path)) {
      continue;
    }

    // 2. Classify according to centralized language registry
    const classification = classifyFile(file.path, {
      includeDocumentation: options.includeDocumentation,
    });

    if (!classification.isEligible) {
      skipped.push({
        path: file.path,
        blobSha: file.sha,
        reason: classification.category === "documentation"
          ? "documentation_omitted"
          : "unsupported_type",
      });
      continue;
    }

    // 3. Oversized file check
    if (typeof file.size === "number" && file.size > maxFileSize) {
      skipped.push({
        path: file.path,
        blobSha: file.sha,
        reason: "oversized",
        size: file.size,
      });
      continue;
    }

    eligible.push({
      path: file.path,
      blobSha: file.sha,
      size: typeof file.size === "number" ? file.size : null,
      mode: file.mode,
      category: classification.category,
      language: classification.language,
    });
  }

  return { eligible, skipped };
}

/**
 * Retrieves a single Git blob with bounded transient retry (up to 1 retry).
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} blobSha
 * @param {object} options
 * @returns {Promise<object>}
 */
async function fetchBlobWithRetry(owner, repo, blobSha, options = {}) {
  const maxRetries = typeof options.maxRetries === "number" ? options.maxRetries : DEFAULT_RETRIEVAL_BUDGETS.maxRetries;
  let attempts = 0;

  while (true) {
    try {
      attempts++;
      return await fetchGitBlob(owner, repo, blobSha, options);
    } catch (error) {
      const isTransient =
        error &&
        (error.status === 503 ||
          error.status === 504 ||
          error.code === "GITHUB_UNAVAILABLE" ||
          error.code === "GITHUB_TIMEOUT");

      if (isTransient && attempts <= maxRetries) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Selectively retrieves source and supporting files from a repository.
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} [params.commitSha]
 * @param {Array<object>} params.manifestFiles
 * @param {object} [params.options]
 * @returns {Promise<object>} Structured retrieval result
 */
async function retrieveSourceFiles({
  owner,
  repo,
  commitSha = null,
  manifestFiles = [],
  options = {},
}) {
  const budgets = { ...DEFAULT_RETRIEVAL_BUDGETS, ...options.budgets };
  const repository = `${owner}/${repo}`;

  if (!manifestFiles || manifestFiles.length === 0) {
    return {
      repository,
      commitSha,
      status: "empty",
      files: [],
      skipped: [],
      failed: [],
      summary: {
        requested: 0,
        retrieved: 0,
        skipped: 0,
        failed: 0,
        totalBytes: 0,
        isTruncated: false,
      },
    };
  }

  // 1. Select eligible files
  const { eligible, skipped } = selectEligibleFiles(manifestFiles, {
    ...options,
    maxFileSizeBytes: budgets.maxFileSizeBytes,
  });

  let isTruncated = false;
  let filesToRetrieve = eligible;

  // 2. Enforce maximum retrieval file count budget
  if (eligible.length > budgets.maxRetrievalFiles) {
    isTruncated = true;
    filesToRetrieve = eligible.slice(0, budgets.maxRetrievalFiles);
    for (let i = budgets.maxRetrievalFiles; i < eligible.length; i++) {
      skipped.push({
        path: eligible[i].path,
        blobSha: eligible[i].blobSha,
        reason: "budget_exceeded",
      });
    }
  }

  // 3. Fetch blobs using bounded concurrency with aggregate budget pre-reservation
  // This ensures concurrent in-flight requests never collectively exceed maxTotalBytes.
  let reservedBytes = 0;

  const fetchedResults = await runBoundedPool(
    filesToRetrieve,
    budgets.concurrency,
    async (item) => {
      const estimatedSize = typeof item.size === "number" ? item.size : 0;

      // Safe concurrency check: do not initiate download if estimated size exceeds remaining budget
      if (reservedBytes + estimatedSize > budgets.maxTotalBytes) {
        return {
          success: false,
          item,
          skippedDueToBudget: true,
          reason: "total_bytes_limit_exceeded",
        };
      }

      reservedBytes += estimatedSize;

      try {
        const blobData = await fetchBlobWithRetry(owner, repo, item.blobSha, options);

        // Blob integrity validation against manifest
        if (blobData.sha && item.blobSha && blobData.sha !== item.blobSha) {
          return {
            success: false,
            item,
            reason: "blob_sha_mismatch",
          };
        }

        const decoded = decodeAndValidateUtf8Blob(blobData.content, blobData.encoding);
        if (!decoded.isValid) {
          return {
            success: false,
            item,
            reason: decoded.reason,
          };
        }

        // Adjust reserved bytes with actual byte length
        const diff = decoded.byteLength - estimatedSize;
        if (reservedBytes + diff > budgets.maxTotalBytes) {
          return {
            success: false,
            item,
            skippedDueToBudget: true,
            reason: "total_bytes_limit_exceeded",
          };
        }
        reservedBytes += diff;

        return {
          success: true,
          item,
          content: decoded.content,
          byteLength: decoded.byteLength,
        };
      } catch (error) {
        if (error instanceof AppError && error.status === 429) {
          throw error; // Re-throw rate limits to caller
        }
        return {
          success: false,
          item,
          reason: error.code || (error.status === 404 ? "not_found" : "fetch_error"),
        };
      }
    }
  );

  // 4. Assemble final file list
  const retrievedFiles = [];
  const failedFiles = [];
  let totalBytes = 0;

  for (const res of fetchedResults) {
    if (!res.success) {
      if (res.skippedDueToBudget) {
        isTruncated = true;
        skipped.push({
          path: res.item.path,
          blobSha: res.item.blobSha,
          reason: res.reason,
        });
      } else {
        failedFiles.push({
          path: res.item.path,
          blobSha: res.item.blobSha,
          reason: res.reason,
        });
      }
      continue;
    }

    totalBytes += res.byteLength;
    retrievedFiles.push({
      path: res.item.path,
      blobSha: res.item.blobSha,
      category: res.item.category,
      language: res.item.language,
      size: res.byteLength,
      content: res.content,
      status: "retrieved",
    });
  }

  const status = isTruncated
    ? "partial"
    : failedFiles.length > 0 && retrievedFiles.length === 0
    ? "failed"
    : "complete";

  return {
    repository,
    commitSha,
    status,
    files: retrievedFiles,
    skipped,
    failed: failedFiles,
    summary: {
      requested: filesToRetrieve.length,
      retrieved: retrievedFiles.length,
      skipped: skipped.length,
      failed: failedFiles.length,
      totalBytes,
      isTruncated,
    },
  };
}

module.exports = {
  DEFAULT_RETRIEVAL_BUDGETS,
  decodeAndValidateUtf8Blob,
  runBoundedPool,
  selectEligibleFiles,
  retrieveSourceFiles,
};
