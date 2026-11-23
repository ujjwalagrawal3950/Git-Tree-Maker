/**
 * Cartograph Progressive Batch Parser & FileIR Persistence Service (Gate 11D).
 *
 * Implements:
 * - Bounded concurrent parsing over downloaded file blobs (default concurrency: 4).
 * - Direct in-memory buffer passing into language AST adapters (zero disk writes, zero eval).
 * - Canonical reuse of ParserScheduler (scheduleRepositoryParse) for all parsing, diagnostics, and timeout handling.
 * - FileIR v1.0.0 schema validation and diagnostic error preservation.
 * - Operational telemetry: actual runtime durationMs preserved in canonical FileIR.
 * - Semantic AST content-addressing decoupled from ephemeral CPU duration.
 * - Individual parser failure isolation (one failed parse does NOT abort the batch).
 * - Content-addressed immutable persistence to Supabase Storage bucket 'fileir-artifacts'.
 * - Safe orphan artifact cleanup: zero synchronous deletion during batch failures/rejections;
 *   reused artifacts and active successor workers are strictly protected.
 */

const crypto = require("node:crypto");
const { defaultRegistry } = require("../parser/ParserRegistry");
const { scheduleRepositoryParse, runBoundedPool } = require("../parser/ParserScheduler");
const { AppError } = require("../../lib/errors");

const DEFAULT_PARSER_CONFIG = {
  concurrency: 4, // Bounded parser concurrency: max 4 concurrent tasks (Gate 11D requirement)
  fileTimeoutMs: 5000, // 5,000 ms cooperative timeout deadline
  bucket: "fileir-artifacts",
};

/**
 * In-memory storage client for isolated, reproducible testing and offline execution.
 * Mirrors the exact Supabase Storage API:
 *   storage.from(bucket).upload(path, data, options)
 *   storage.from(bucket).download(path)
 *   storage.from(bucket).remove([path1, path2])
 */
class InMemoryStorageClient {
  constructor() {
    // bucket -> Map(path -> { buffer, contentType, fullSha256, createdAt })
    this.buckets = new Map();
  }

  from(bucketName) {
    if (!this.buckets.has(bucketName)) {
      this.buckets.set(bucketName, new Map());
    }
    const store = this.buckets.get(bucketName);

    return {
      upload: async (path, body, options = {}) => {
        const upsert = Boolean(options.upsert);
        if (store.has(path) && !upsert) {
          const err = new Error("The resource already exists");
          err.statusCode = 409;
          err.code = "RESOURCE_ALREADY_EXISTS";
          return { data: null, error: err };
        }

        const buffer = Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");

        const fullSha256 = crypto.createHash("sha256").update(buffer).digest("hex");

        store.set(path, {
          buffer,
          contentType: options.contentType || "application/octet-stream",
          fullSha256,
          createdAt: new Date().toISOString(),
        });

        return { data: { path, id: path, fullPath: `${bucketName}/${path}` }, error: null };
      },

      download: async (path) => {
        const item = store.get(path);
        if (!item) {
          const err = new Error("Object not found");
          err.statusCode = 404;
          return { data: null, error: err };
        }
        return { data: item.buffer, error: null };
      },

      remove: async (paths) => {
        const removed = [];
        for (const p of paths) {
          if (store.delete(p)) {
            removed.push({ name: p });
          }
        }
        return { data: removed, error: null };
      },

      list: async (prefix = "") => {
        const items = [];
        for (const [key, val] of store.entries()) {
          if (!prefix || key.startsWith(prefix)) {
            items.push({ name: key, metadata: { size: val.buffer.length } });
          }
        }
        return { data: items, error: null };
      },
    };
  }

  clear() {
    this.buckets.clear();
  }
}

/**
 * Computes a deterministic parser fingerprint for an adapter.
 * Encodes adapter identity, adapter version, AST engine, and engine version.
 *
 * @param {import('../parser/adapters/BaseAdapter')} adapter
 * @returns {string}
 */
function computeParserFingerprint(adapter) {
  if (!adapter) return "unknown@1.0.0:generic@1.0.0";
  const id = adapter.adapterId || "unknown-adapter";
  const ver = adapter.adapterVersion || "1.0.0";
  const eng = adapter.engine || "generic";
  const engVer = adapter.engineVersion || "1.0.0";
  return `${id}@${ver}:${eng}@${engVer}`;
}

/**
 * Computes a deterministic content SHA-256 for a FileIR document.
 * Decouples runtime execution latency (durationMs) from the semantic AST content hash,
 * ensuring that identical AST outputs produce identical content addresses across workers and retries,
 * while preserving actual measured durationMs inside the stored FileIR document and telemetry.
 *
 * @param {object} fileIR
 * @returns {string} 64-character lowercase hex SHA-256
 */
function computeFileIrContentSha256(fileIR) {
  const canonical = {
    ...fileIR,
    parser: {
      ...fileIR.parser,
      durationMs: 0, // Normalized strictly for content-address hashing identity
    },
  };
  return crypto.createHash("sha256").update(Buffer.from(JSON.stringify(canonical), "utf8")).digest("hex");
}

/**
 * Constructs the canonical, immutable, content-addressed storage path for a FileIR artifact.
 *
 * Pattern:
 * `${organizationId}/${repositoryId}/${commitSha}/fileir/${filePath}_${blobSha}_fp_${fingerprintSlug}_${fullSha256}.fileir.json`
 *
 * Incorporates:
 * - Organization ID
 * - Repository ID
 * - Commit SHA
 * - Case-sensitive normalized file path
 * - Git blob SHA
 * - Parser fingerprint slug
 * - Full 64-character SHA-256 of the FileIR JSON document
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.repositoryId
 * @param {string} params.commitSha
 * @param {string} params.filePath
 * @param {string} params.blobSha
 * @param {string} params.parserFingerprint
 * @param {string} params.fullSha256 - 64-character hex hash
 * @returns {string}
 */
function buildFileIrStoragePath({
  organizationId,
  repositoryId,
  commitSha,
  filePath,
  blobSha,
  parserFingerprint = "default",
  fullSha256,
}) {
  if (!organizationId || !repositoryId || !commitSha || !filePath || !blobSha || !fullSha256) {
    throw new AppError(
      400,
      "INVALID_ARTIFACT_IDENTITY",
      "organizationId, repositoryId, commitSha, filePath, blobSha, and fullSha256 are required."
    );
  }

  const cleanRepo = repositoryId.replace(/^\/+|\/+$/g, "");
  const cleanPath = filePath.replace(/^\/+/, "");
  const fpSlug = (parserFingerprint || "default").replace(/[^a-zA-Z0-9._-]/g, "_");

  return `${organizationId}/${cleanRepo}/${commitSha}/fileir/${cleanPath}_${blobSha}_fp_${fpSlug}_${fullSha256}.fileir.json`;
}

/**
 * Uploads a serialized FileIR buffer to Supabase Storage with immutable semantics (upsert: false).
 * Enforces:
 * - Content-addressed immutability.
 * - Idempotent retries (if an identical artifact with matching hash already exists, treats as success).
 *
 * @param {object} params
 * @param {object} params.storageClient - Supabase Storage client
 * @param {string} params.storagePath - Canonical object key
 * @param {Buffer} params.buffer - UTF-8 JSON buffer
 * @param {string} params.fullSha256 - 64-character hex hash
 * @param {string} [params.bucket="fileir-artifacts"]
 * @returns {Promise<{ storagePath: string, fullSha256: string, bytes: number, alreadyExisted: boolean }>}
 */
async function uploadFileIrArtifact({
  storageClient,
  storagePath,
  buffer,
  fullSha256,
  bucket = DEFAULT_PARSER_CONFIG.bucket,
}) {
  const { error } = await storageClient.from(bucket).upload(storagePath, buffer, {
    contentType: "application/json",
    upsert: false,
  });

  if (error) {
    // Idempotency: If object already exists, check whether it is identical
    const isConflict =
      error.statusCode === 409 ||
      error.code === "RESOURCE_ALREADY_EXISTS" ||
      (error.message && (error.message.includes("already exists") || error.message.includes("Duplicate")));

    if (isConflict) {
      // Content-addressed path contains the SHA-256; duplicate key implies identical content
      return {
        storagePath,
        fullSha256,
        bytes: buffer.byteLength,
        alreadyExisted: true,
      };
    }

    throw new AppError(
      500,
      "STORAGE_UPLOAD_FAILED",
      `Failed to upload FileIR artifact to ${bucket}/${storagePath}: ${error.message}`
    );
  }

  return {
    storagePath,
    fullSha256,
    bytes: buffer.byteLength,
    alreadyExisted: false,
  };
}

/**
 * Parses a single downloaded file using the established ParserScheduler pipeline.
 *
 * @param {object} params
 * @param {object} params.downloadedItem - { path, blobSha, content, byteLength, file }
 * @param {object} params.repository - { owner, name, fullName, commitSha }
 * @param {import('../parser/ParserRegistry').ParserRegistry} params.registry
 * @param {number} params.fileTimeoutMs
 * @returns {Promise<{ fileIR: object, parserFingerprint: string, isPartial: boolean, isFailed: boolean }>}
 */
async function parseSingleFile({
  downloadedItem,
  repository,
  registry = defaultRegistry,
  fileTimeoutMs = DEFAULT_PARSER_CONFIG.fileTimeoutMs,
}) {
  const language = (downloadedItem.file && downloadedItem.file.language) || downloadedItem.language || "unknown";
  const adapter = registry.getAdapter(language);
  const parserFingerprint = computeParserFingerprint(adapter);

  const parseResult = await scheduleRepositoryParse({
    repository,
    files: [
      {
        path: downloadedItem.path,
        blobSha: downloadedItem.blobSha || (downloadedItem.file && downloadedItem.file.blobSha),
        language,
        category: (downloadedItem.file && downloadedItem.file.category) || "source",
        size: downloadedItem.byteLength || (downloadedItem.content ? Buffer.byteLength(downloadedItem.content, "utf8") : 0),
        content: downloadedItem.content,
      },
    ],
    options: {
      registry,
      concurrency: 1,
      fileTimeoutMs,
    },
  });

  const fileIR = parseResult.files[0];
  const isPartial = fileIR.parser && fileIR.parser.status === "partial";
  const isFailed = fileIR.parser && fileIR.parser.status === "failed";

  return { fileIR, parserFingerprint, isPartial, isFailed };
}

/**
 * Parses a downloaded batch of files using the established ParserScheduler pipeline,
 * validates FileIR documents, and persists them immutably to Supabase Storage.
 *
 * Guarantees:
 * - Direct reuse of scheduleRepositoryParse: no second parser execution pathway.
 * - Bounded concurrency (default 4 concurrent tasks).
 * - Individual parser failure isolation.
 * - Content-addressed immutability: zero synchronous deletion on failure/rejection.
 * - Reused artifacts and active successor workers are strictly protected.
 * - Preserves partial parsing diagnostics according to existing FileIR behavior.
 * - Preserves actual durationMs operational telemetry inside canonical FileIR.
 * - Respects cooperative cancellation checks.
 *
 * @param {object} params
 * @param {object} params.repository - { owner, name, fullName, commitSha }
 * @param {string} params.organizationId
 * @param {string} params.jobId
 * @param {Array<object>} params.downloadedFiles - Array of successfully downloaded items from BatchDownloader
 * @param {Array<object>} [params.failedFiles=[]] - Files that failed downloading
 * @param {Array<object>} [params.skippedFiles=[]] - Files skipped during downloading
 * @param {object} [params.options]
 * @param {import('../parser/ParserRegistry').ParserRegistry} [params.options.registry]
 * @param {number} [params.options.concurrency=4]
 * @param {number} [params.options.fileTimeoutMs=5000]
 * @param {object} [params.options.storageClient]
 * @param {object} [params.options.jobManager] - IngestionJobManager instance
 * @param {string} [params.options.bucket="fileir-artifacts"]
 * @param {Function} [params.options.isCancelled]
 * @returns {Promise<{
 *   outcomes: Array<{
 *     path: string,
 *     status: 'parsed'|'failed'|'skipped',
 *     storagePath: string|null,
 *     sha256: string|null,
 *     bytes: number|null,
 *     parserFingerprint: string|null,
 *     errorCode: string|null,
 *     errorMessage: string|null,
 *   }>,
 *   stagedArtifacts: Array<{ path: string, storagePath: string, sha256: string, bytes: number, alreadyExisted: boolean }>,
 *   summary: {
 *     total: number,
 *     parsed: number,
 *     partial: number,
 *     failed: number,
 *     skipped: number,
 *     totalBytes: number,
 *   },
 *   isCancelled: boolean
 * }>}
 */
async function parseAndPersistBatch({
  repository,
  organizationId,
  jobId,
  downloadedFiles = [],
  failedFiles = [],
  skippedFiles = [],
  options = {},
}) {
  const registry = options.registry || defaultRegistry;
  const concurrency = Math.max(1, Math.min(4, options.concurrency || DEFAULT_PARSER_CONFIG.concurrency));
  const fileTimeoutMs = options.fileTimeoutMs || DEFAULT_PARSER_CONFIG.fileTimeoutMs;
  const storageClient = options.storageClient || new InMemoryStorageClient();
  const bucket = options.bucket || DEFAULT_PARSER_CONFIG.bucket;
  const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;

  const repoId = repository.fullName || `${repository.owner}/${repository.name}`;
  const commitSha = repository.commitSha;

  const stagedArtifacts = [];
  const fileOutcomes = [];

  // 1. Process files that already failed during download
  for (const item of failedFiles) {
    fileOutcomes.push({
      path: item.path,
      status: "failed",
      storagePath: null,
      sha256: null,
      bytes: null,
      parserFingerprint: null,
      errorCode: item.errorCode || "DOWNLOAD_FAILED",
      errorMessage: item.errorMessage || "Blob download failed",
    });
  }

  // 2. Process files that were skipped during download (binary, oversized, etc.)
  for (const item of skippedFiles) {
    fileOutcomes.push({
      path: item.path,
      status: "skipped",
      storagePath: null,
      sha256: null,
      bytes: null,
      parserFingerprint: null,
      errorCode: item.reason || "SKIPPED",
      errorMessage: `Skipped file: ${item.reason || "unsupported"}`,
    });
  }

  // 3. Parse downloaded source files via the canonical ParserScheduler pipeline
  if (isCancelled()) {
    return {
      outcomes: [],
      stagedArtifacts: [],
      summary: { total: 0, parsed: 0, partial: 0, failed: 0, skipped: 0, totalBytes: 0 },
      isCancelled: true,
    };
  }

  try {
    // Map downloaded items to files array for scheduleRepositoryParse
    const filesToParse = downloadedFiles.map((item) => ({
      path: item.path,
      blobSha: item.blobSha || (item.file && item.file.blobSha),
      language: (item.file && item.file.language) || item.language || "unknown",
      category: (item.file && item.file.category) || item.category || "source",
      size: item.byteLength || (item.content ? Buffer.byteLength(item.content, "utf8") : 0),
      content: item.content,
      _rawItem: item,
    }));

    const parseOutput = await scheduleRepositoryParse({
      repository,
      files: filesToParse,
      options: {
        registry,
        concurrency,
        fileTimeoutMs,
      },
    });

    // Check cancellation after parse
    if (isCancelled()) {
      return {
        outcomes: [],
        stagedArtifacts: [],
        summary: { total: 0, parsed: 0, partial: 0, failed: 0, skipped: 0, totalBytes: 0 },
        isCancelled: true,
      };
    }

    // 4. Concurrently serialize, hash, and upload FileIR artifacts
    const uploadResults = await runBoundedPool(parseOutput.files, concurrency, async (fileIR) => {
      if (isCancelled()) {
        return { cancelled: true };
      }

      const filePath = fileIR.analysis.file.path;
      const blobSha = fileIR.analysis.file.blobSha;
      const language = fileIR.analysis.file.language;
      const adapter = registry.getAdapter(language);
      const parserFingerprint = computeParserFingerprint(adapter);

      // Keep actual runtime timing in fileIR as operational telemetry (never fabricate 0 in canonical FileIR)
      // Compute deterministic fullSha256 by canonicalizing durationMs only for hash calculation
      const fullSha256 = computeFileIrContentSha256(fileIR);

      // Serialize FileIR containing actual measured runtime telemetry to UTF-8 Buffer
      const jsonStr = JSON.stringify(fileIR);
      const buffer = Buffer.from(jsonStr, "utf8");

      // Build canonical immutable storage path
      const storagePath = buildFileIrStoragePath({
        organizationId,
        repositoryId: repoId,
        commitSha,
        filePath,
        blobSha,
        parserFingerprint,
        fullSha256,
      });

      // Upload to Supabase Storage with immutable semantics (upsert: false)
      const uploadRes = await uploadFileIrArtifact({
        storageClient,
        storagePath,
        buffer,
        fullSha256,
        bucket,
      });

      stagedArtifacts.push({
        path: filePath,
        storagePath,
        sha256: fullSha256,
        bytes: buffer.byteLength,
        parserFingerprint,
        alreadyExisted: uploadRes.alreadyExisted,
      });

      const isFailed = fileIR.parser && fileIR.parser.status === "failed";
      const isPartial = fileIR.parser && fileIR.parser.status === "partial";

      return {
        cancelled: false,
        path: filePath,
        status: isFailed ? "failed" : "parsed",
        storagePath,
        sha256: fullSha256,
        bytes: buffer.byteLength,
        parserFingerprint,
        isPartial,
        isFailed,
        diagnostics: fileIR.diagnostics || [],
      };
    });

    // Check cancellation
    if (uploadResults.some((r) => r.cancelled) || isCancelled()) {
      return {
        outcomes: [],
        stagedArtifacts: [],
        summary: { total: 0, parsed: 0, partial: 0, failed: 0, skipped: 0, totalBytes: 0 },
        isCancelled: true,
      };
    }

    // Assemble file outcomes
    let parsedCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    let totalBytes = 0;

    for (const res of uploadResults) {
      if (res.status === "parsed") parsedCount++;
      if (res.isPartial) partialCount++;
      if (res.status === "failed") failedCount++;
      totalBytes += res.bytes || 0;

      fileOutcomes.push({
        path: res.path,
        status: res.status,
        storagePath: res.storagePath,
        sha256: res.sha256,
        bytes: res.bytes,
        parserFingerprint: res.parserFingerprint,
        errorCode: res.isFailed ? (res.diagnostics[0]?.code || "PARSE_FAILURE") : null,
        errorMessage: res.isFailed ? (res.diagnostics[0]?.message || "Parse failed") : null,
      });
    }

    return {
      outcomes: fileOutcomes,
      stagedArtifacts,
      summary: {
        total: fileOutcomes.length,
        parsed: parsedCount,
        partial: partialCount,
        failed: failedCount + failedFiles.length,
        skipped: skippedFiles.length,
        totalBytes,
      },
      isCancelled: false,
    };
  } catch (error) {
    // IMPORTANT CONCURRENCY RULE:
    // Do NOT synchronously delete content-addressed immutable artifacts merely because
    // an upload attempt failed, a lease expired, or a worker was cancelled.
    // Immutable content-addressed artifacts remain available for idempotent retries
    // by this worker or concurrent successor workers.
    throw error;
  }
}

/**
 * Safely sweeps and purges candidate orphan artifacts for a completed or non-active job.
 *
 * Safety requirements enforced:
 * 1. Checks that the job is NOT actively claimed with a valid lease (prevents racing with active workers).
 * 2. Queries all committed storage paths from ingestion_job_files (via jobManager.getCommittedStoragePaths).
 * 3. Identifies candidate storage artifacts.
 * 4. Filters out any artifact path that is referenced by a committed database record.
 * 5. Deletes only unreferenced orphan artifacts.
 * 6. Completely idempotent.
 *
 * @param {object} params
 * @param {object} params.storageClient
 * @param {import('./IngestionJobManager').IngestionJobManager} params.jobManager
 * @param {string} params.jobId
 * @param {string} [params.bucket="fileir-artifacts"]
 * @returns {Promise<{ deletedCount: number, preservedCount: number, skippedDueToActiveJob: boolean }>}
 */
async function safeOrphanCleanup({
  storageClient,
  jobManager,
  jobId,
  bucket = DEFAULT_PARSER_CONFIG.bucket,
}) {
  if (!jobManager || !jobId) {
    return { deletedCount: 0, preservedCount: 0, skippedDueToActiveJob: false };
  }

  // 1. Concurrency safety: check if job is actively running with a valid lease
  let job;
  if (jobManager.useMemoryStore) {
    job = jobManager.memoryJobs.get(jobId);
  } else {
    const { data } = await supabaseAdmin.from("ingestion_jobs").select("*").eq("id", jobId).single();
    job = data;
  }

  if (!job) {
    return { deletedCount: 0, preservedCount: 0, skippedDueToActiveJob: false };
  }

  // If a worker actively holds a valid lease on this job, NEVER run cleanup (Worker B may be about to commit!)
  const now = Date.now();
  const hasActiveLease =
    job.claimed_by &&
    job.lease_expires_at &&
    new Date(job.lease_expires_at).getTime() > now &&
    !["completed", "completed_with_errors", "completed_partial", "failed", "cancelled"].includes(job.status);

  if (hasActiveLease) {
    return { deletedCount: 0, preservedCount: 0, skippedDueToActiveJob: true };
  }

  // 2. Fetch all durable committed storage paths for this job
  const committedPaths = await jobManager.getCommittedStoragePaths(jobId);

  // 3. List candidate artifacts in storage for this repository/commit
  const cleanRepo = job.repository_id.replace(/^\/+|\/+$/g, "");
  const prefix = `${job.organization_id}/${cleanRepo}/${job.commit_sha}/fileir/`;
  const { data: listed } = await storageClient.from(bucket).list(prefix);
  if (!listed || listed.length === 0) {
    return { deletedCount: 0, preservedCount: 0, skippedDueToActiveJob: false };
  }

  const unreferenced = [];
  let preservedCount = 0;

  for (const item of listed) {
    const fullPath = item.name.startsWith(prefix) ? item.name : `${prefix}${item.name}`;
    if (committedPaths.has(fullPath)) {
      preservedCount++;
    } else {
      unreferenced.push(fullPath);
    }
  }

  // 4. Safely delete only unreferenced orphans
  if (unreferenced.length > 0) {
    await storageClient.from(bucket).remove(unreferenced);
  }

  return {
    deletedCount: unreferenced.length,
    preservedCount,
    skippedDueToActiveJob: false,
  };
}

module.exports = {
  DEFAULT_PARSER_CONFIG,
  InMemoryStorageClient,
  computeParserFingerprint,
  computeFileIrContentSha256,
  buildFileIrStoragePath,
  uploadFileIrArtifact,
  parseSingleFile,
  parseAndPersistBatch,
  safeOrphanCleanup,
};
