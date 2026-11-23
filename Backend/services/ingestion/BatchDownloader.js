/**
 * Cartograph Bounded Concurrent Batch Downloader.
 *
 * Progressively downloads Git blobs for prioritized files using bounded concurrency,
 * strict SHA-1 Git blob verification, UTF-8 validation, and aggregate/per-file byte budgets.
 *
 * Guarantees:
 * - Never downloads every repository file simultaneously.
 * - Bounded concurrency (configurable, default: 5).
 * - Per-file size cap (default: 1 MB) and batch aggregate byte budget (default: 8 MB).
 * - Preserves deterministic architectural file prioritization.
 * - One failed file does not fail the entire batch.
 * - Handles transient network errors with bounded retries.
 * - Respects cooperative cancellation checks.
 */

const crypto = require("node:crypto");
const github = require("../github");
const { decodeAndValidateUtf8Blob, runBoundedPool } = require("../sourceRetrieval");
const { AppError } = require("../../lib/errors");

const DEFAULT_BATCH_BUDGETS = {
  concurrency: 5,
  maxFileSizeBytes: 1000000, // 1 MB per file
  maxBatchBytes: 8000000, // 8 MB per batch
  maxRetries: 1,
};

/**
 * Verifies Git blob SHA-1: blob <size>\0<content>
 *
 * @param {Buffer} buffer - Raw decoded binary buffer
 * @param {string} expectedSha - Expected Git blob SHA
 * @returns {boolean}
 */
function verifyGitBlobSha(buffer, expectedSha) {
  if (!buffer || !expectedSha) return false;
  const hash = crypto.createHash("sha1");
  hash.update(`blob ${buffer.length}\0`);
  hash.update(buffer);
  const actualSha = hash.digest("hex");
  return actualSha.toLowerCase() === expectedSha.toLowerCase();
}

/**
 * Downloads a single Git blob with bounded transient retries.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} blobSha
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function fetchBlobWithRetry(owner, repo, blobSha, options = {}) {
  const maxRetries = typeof options.maxRetries === "number" ? options.maxRetries : DEFAULT_BATCH_BUDGETS.maxRetries;
  let attempts = 0;

  while (true) {
    try {
      attempts++;
      return await github.fetchGitBlob(owner, repo, blobSha, options);
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
 * Downloads a batch of files concurrently with strict resource bounds.
 *
 * @param {object} params
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {Array<object>} params.files - Array of { id, path, blobSha, sizeBytes, priorityRank }
 * @param {object} [params.options]
 * @param {number} [params.options.concurrency=5]
 * @param {number} [params.options.maxFileSizeBytes=1000000]
 * @param {number} [params.options.maxBatchBytes=8000000]
 * @param {Function} [params.options.isCancelled] - Cancellation check function
 * @param {Function} [params.options.onFileProgress] - Callback on individual file completion
 * @returns {Promise<{
 *   downloaded: Array<object>,
 *   failed: Array<object>,
 *   skipped: Array<object>,
 *   totalDownloadedBytes: number,
 *   isCancelled: boolean
 * }>}
 */
async function downloadBatchFiles({
  owner,
  repo,
  files = [],
  options = {},
}) {
  const concurrency = Math.max(1, Math.min(options.concurrency || DEFAULT_BATCH_BUDGETS.concurrency, 20));
  const maxFileSizeBytes = options.maxFileSizeBytes || DEFAULT_BATCH_BUDGETS.maxFileSizeBytes;
  const maxBatchBytes = options.maxBatchBytes || DEFAULT_BATCH_BUDGETS.maxBatchBytes;

  const downloaded = [];
  const failed = [];
  const skipped = [];
  let totalDownloadedBytes = 0;
  let cancelled = false;

  // Track remaining budget safely across concurrent worker tasks
  let committedBatchBytes = 0;

  // Process files concurrently with bounded worker pool
  await runBoundedPool(files, concurrency, async (file) => {
    // 1. Cooperative cancellation check
    if (cancelled || (typeof options.isCancelled === "function" && options.isCancelled())) {
      cancelled = true;
      skipped.push({
        file,
        path: file.path,
        reason: "cancelled",
      });
      return;
    }

    // 2. Individual file size pre-check
    if (typeof file.sizeBytes === "number" && file.sizeBytes > maxFileSizeBytes) {
      const record = {
        file,
        path: file.path,
        reason: "oversized",
        size: file.sizeBytes,
      };
      skipped.push(record);
      if (typeof options.onFileProgress === "function") {
        options.onFileProgress({ type: "skipped", file, reason: "oversized" });
      }
      return;
    }

    // 3. Aggregate batch budget pre-reservation
    const expectedSize = typeof file.sizeBytes === "number" ? file.sizeBytes : 0;
    if (committedBatchBytes + expectedSize > maxBatchBytes) {
      const record = {
        file,
        path: file.path,
        reason: "batch_budget_exceeded",
        size: file.sizeBytes,
      };
      skipped.push(record);
      if (typeof options.onFileProgress === "function") {
        options.onFileProgress({ type: "skipped", file, reason: "batch_budget_exceeded" });
      }
      return;
    }
    committedBatchBytes += expectedSize;

    // 4. Blob retrieval with transient retries
    try {
      const blobResponse = await fetchBlobWithRetry(owner, repo, file.blobSha, {
        headers: options.headers,
        maxRetries: options.maxRetries,
      });

      // 5. Decode Base64 & validate UTF-8
      const decoded = decodeAndValidateUtf8Blob(blobResponse.content, blobResponse.encoding);
      if (!decoded.isValid) {
        committedBatchBytes -= expectedSize; // Release reservation on failure
        const record = {
          file,
          path: file.path,
          reason: decoded.reason || "invalid_content",
          byteLength: decoded.byteLength,
        };
        skipped.push(record);
        if (typeof options.onFileProgress === "function") {
          options.onFileProgress({ type: "skipped", file, reason: record.reason });
        }
        return;
      }

      // 6. Verify Git blob SHA integrity
      const shaMatches = verifyGitBlobSha(decoded.buffer, file.blobSha);
      if (!shaMatches) {
        committedBatchBytes -= expectedSize; // Release reservation on failure
        const record = {
          file,
          path: file.path,
          errorCode: "BLOB_SHA_MISMATCH",
          errorMessage: `Git blob SHA mismatch for ${file.path}: expected ${file.blobSha}`,
        };
        failed.push(record);
        if (typeof options.onFileProgress === "function") {
          options.onFileProgress({ type: "failed", file, error: record });
        }
        return;
      }

      // 7. Check if actual decoded byte length exceeds per-file limit
      if (decoded.byteLength > maxFileSizeBytes) {
        committedBatchBytes -= expectedSize; // Release reservation on failure
        const record = {
          file,
          path: file.path,
          reason: "oversized",
          size: decoded.byteLength,
        };
        skipped.push(record);
        if (typeof options.onFileProgress === "function") {
          options.onFileProgress({ type: "skipped", file, reason: "oversized" });
        }
        return;
      }

      // 8. Record successful download (adjust reservation to actual downloaded byte length)
      committedBatchBytes += (decoded.byteLength - expectedSize);
      totalDownloadedBytes += decoded.byteLength;
      const successRecord = {
        file,
        path: file.path,
        blobSha: file.blobSha,
        content: decoded.content,
        byteLength: decoded.byteLength,
      };
      downloaded.push(successRecord);

      if (typeof options.onFileProgress === "function") {
        options.onFileProgress({ type: "downloaded", file, byteLength: decoded.byteLength });
      }
    } catch (error) {
      // One failed file does NOT fail the entire batch
      committedBatchBytes -= expectedSize; // Release reservation on error
      const record = {
        file,
        path: file.path,
        errorCode: error.code || "DOWNLOAD_ERROR",
        errorMessage: error.message || "Failed to download blob from GitHub",
      };
      failed.push(record);
      if (typeof options.onFileProgress === "function") {
        options.onFileProgress({ type: "failed", file, error: record });
      }
    }
  });

  return {
    downloaded,
    failed,
    skipped,
    totalDownloadedBytes,
    isCancelled: cancelled,
  };
}

module.exports = {
  DEFAULT_BATCH_BUDGETS,
  verifyGitBlobSha,
  fetchBlobWithRetry,
  downloadBatchFiles,
};
