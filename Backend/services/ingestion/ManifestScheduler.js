/**
 * Cartograph Manifest Classification & Priority Scheduler (Gate 11C).
 *
 * Implements:
 * - Deterministic manifest classification (source, documentation, config/manifest, binary, unsupported).
 * - Architectural priority ranking (P0..P4) preserving full relative paths.
 * - Mode selection (small, medium, large) and batch partitioning.
 * - Recovery without unnecessary Git Tree rediscovery.
 * - Idempotent file scheduling in PostgreSQL ingestion job tables.
 * - Bounded concurrent downloading integration via BatchDownloader.
 */

const path = require("node:path").posix;
const github = require("../github");
const { generateManifest, isExcludedDirectoryPath, normalizeRepoPath } = require("../manifest");
const { classifyFile, IGNORED_ASSET_EXTENSIONS } = require("../languageRegistry");
const { AppError } = require("../../lib/errors");
const { parseAndPersistBatch } = require("./BatchParser");

const DEFAULT_SCHEDULER_CONFIG = {
  batch1MaxFiles: 100,
  subsequentBatchMaxFiles: 100,
  maxBatchBytes: 8000000, // 8 MB
  maxFileSizeBytes: 1000000, // 1 MB
  modeThresholds: {
    smallMaxFiles: 200,
    smallMaxBytes: 150 * 1024 * 1024, // 150 MB
    largeMinFiles: 500,
    largeMinBytes: 300 * 1024 * 1024, // 300 MB
  },
};

// Known binary and media extensions to exclude from source analysis
const BINARY_AND_MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp", ".tiff",
  ".mp4", ".mp3", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".bz2",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".class", ".pyc", ".pyo", ".o", ".obj",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
]);

/**
 * Computes deterministic architectural priority rank (0 to 4) for a file.
 *
 * Order:
 * 0: Documentation / Project Context (README*, readme*, etc.)
 * 1: Build Configuration & Project Manifests (package.json, tsconfig.json, pom.xml, CMakeLists.txt, Makefile, etc.)
 * 2: Application Entry Points & Bootstrap (index.*, main.*, app.*, server.*)
 * 3: Core Domain Modules & Services (*controller*, *route*, *api*, *service*, *model*, *entity*, *schema*)
 * 4: Remaining Eligible Source Files
 *
 * @param {string} normalizedPath - Full repository-relative POSIX path
 * @param {string} category - Classification category
 * @returns {number} Priority rank (0 to 4)
 */
function computePriorityRank(normalizedPath, category) {
  const lowerPath = normalizedPath.toLowerCase();
  const basename = path.basename(lowerPath);
  const nameWithoutExt = basename.split(".")[0];

  // Priority 0: Important repository documentation
  if (
    category === "documentation" ||
    basename.startsWith("readme") ||
    lowerPath === "readme.md" ||
    lowerPath.endsWith("/readme.md") ||
    lowerPath.endsWith("/readme")
  ) {
    return 0;
  }

  // Priority 1: Package / Build Configuration and Manifests
  if (
    category === "dependency_manifest" ||
    category === "build" ||
    category === "configuration" ||
    basename === "package.json" ||
    basename.startsWith("tsconfig") ||
    basename === "pyproject.toml" ||
    basename === "pom.xml" ||
    basename === "cmakelists.txt" ||
    basename === "makefile" ||
    basename === "gnumakefile" ||
    basename === "cargo.toml" ||
    basename === "go.mod" ||
    basename === "build.gradle" ||
    basename === "gemfile" ||
    basename === "composer.json" ||
    basename === "requirements.txt"
  ) {
    return 1;
  }

  // Priority 2: Application Entry Points & Server Bootstrap
  if (
    nameWithoutExt === "index" ||
    nameWithoutExt === "main" ||
    nameWithoutExt === "app" ||
    nameWithoutExt === "server" ||
    nameWithoutExt === "application" ||
    basename === "manage.py" ||
    lowerPath.endsWith("/index.js") ||
    lowerPath.endsWith("/index.ts") ||
    lowerPath.endsWith("/main.py") ||
    lowerPath.endsWith("/main.go") ||
    lowerPath.endsWith("/main.rs")
  ) {
    return 2;
  }

  // Priority 3: Routing, APIs, Controllers, Services, Models, Entities
  const architecturalPatterns = [
    "controller", "route", "router", "api", "service", "client",
    "model", "entity", "schema", "type", "domain", "store",
    "repository", "handler", "endpoint"
  ];

  if (architecturalPatterns.some((pattern) => lowerPath.includes(pattern))) {
    return 3;
  }

  // Priority 4: All remaining eligible files
  return 4;
}

/**
 * Classifies an individual file entry according to Cartograph policies.
 *
 * @param {object} file - { path, sha, size, type, mode }
 * @param {object} [options]
 * @returns {object} Classified file object with category, language, priorityRank, and eligibility
 */
function classifyManifestFile(file, options = {}) {
  const cleanPath = normalizeRepoPath(file.path || "");
  const size = typeof file.size === "number" ? file.size : (file.sizeBytes || null);
  const ext = path.extname(cleanPath).toLowerCase();
  const maxFileSizeBytes = options.maxFileSizeBytes || DEFAULT_SCHEDULER_CONFIG.maxFileSizeBytes;

  // 1. Policy exclusion check: vendor, build, dependencies, git metadata
  if (isExcludedDirectoryPath(cleanPath)) {
    return {
      path: cleanPath,
      blobSha: file.sha || file.blobSha || null,
      sizeBytes: size,
      category: "vendor_or_build",
      language: null,
      tier: "vendor_or_build",
      priorityRank: 4,
      isEligible: false,
      exclusionReason: "vendor_or_build",
    };
  }

  // 2. Binary / Media Asset check
  if (IGNORED_ASSET_EXTENSIONS.has(ext) || BINARY_AND_MEDIA_EXTENSIONS.has(ext)) {
    return {
      path: cleanPath,
      blobSha: file.sha || file.blobSha || null,
      sizeBytes: size,
      category: "binary_or_media",
      language: null,
      tier: "ignored_asset",
      priorityRank: 4,
      isEligible: false,
      exclusionReason: "binary_or_media",
    };
  }

  // 3. Oversized check
  if (size !== null && size > maxFileSizeBytes) {
    return {
      path: cleanPath,
      blobSha: file.sha || file.blobSha || null,
      sizeBytes: size,
      category: "oversized",
      language: null,
      tier: "oversized",
      priorityRank: 4,
      isEligible: false,
      exclusionReason: "oversized",
    };
  }

  // 4. Centralized language classification
  const langClass = classifyFile(cleanPath, {
    includeDocumentation: true, // We classify documentation details for priority calculation
  });

  const category = langClass.category;
  const language = langClass.language;
  const tier = langClass.tier;
  const isSource = Boolean(langClass.isSource);
  const isDoc = category === "documentation";
  const isConfig = category === "dependency_manifest" || category === "build" || category === "configuration";

  const includeDoc = options.includeDocumentation !== undefined
    ? Boolean(options.includeDocumentation)
    : (options.codeAnalysis === true ? false : true);

  const isEligible = isSource || (isDoc && includeDoc) || isConfig;
  let exclusionReason = null;
  if (!isEligible) {
    if (isDoc && !includeDoc) {
      exclusionReason = "documentation_omitted";
    } else {
      exclusionReason = "unsupported_type";
    }
  }

  const priorityRank = computePriorityRank(cleanPath, category);

  return {
    path: cleanPath,
    blobSha: file.sha || file.blobSha || null,
    sizeBytes: size,
    category,
    language,
    tier,
    priorityRank,
    isEligible,
    exclusionReason,
  };
}

/**
 * Classifies an entire list of Git tree entries, removing duplicates deterministically.
 *
 * @param {Array<object>} treeEntries - Raw tree entries from Git Tree API
 * @param {object} [options]
 * @returns {{ eligible: Array<object>, excluded: Array<object>, summary: object }}
 */
function classifyRepositoryManifest(treeEntries = [], options = {}) {
  const seenPaths = new Set();
  const eligible = [];
  const excluded = [];
  let totalEligibleBytes = 0;

  for (const entry of treeEntries) {
    const rawPath = entry.path;
    if (!rawPath) continue;

    const cleanPath = normalizeRepoPath(rawPath);
    if (!cleanPath || cleanPath === "." || cleanPath.startsWith("../")) continue;

    // Filter directory nodes (trees) and submodules
    if (entry.type === "tree" || entry.mode === "040000" || entry.type === "commit" || entry.mode === "160000") {
      continue;
    }

    // Deterministic deduplication: keep first occurrence
    if (seenPaths.has(cleanPath)) {
      continue;
    }
    seenPaths.add(cleanPath);

    const classified = classifyManifestFile(entry, options);

    if (classified.isEligible) {
      eligible.push(classified);
      totalEligibleBytes += classified.sizeBytes || 0;
    } else {
      excluded.push(classified);
    }
  }

  // Deterministic sorting: (priorityRank ASC, path ASC)
  eligible.sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    return a.path.localeCompare(b.path);
  });

  return {
    eligible,
    excluded,
    summary: {
      totalEntries: seenPaths.size,
      eligibleFiles: eligible.length,
      excludedFiles: excluded.length,
      eligibleBytes: totalEligibleBytes,
    },
  };
}

/**
 * Selects repository ingestion mode and processing strategy.
 *
 * Threshold rules:
 * - large: eligibleFiles >= 500 OR eligibleBytes >= 300 MB -> large, adaptive_progressive
 * - medium: eligibleFiles > 200 OR eligibleBytes > 150 MB -> medium, continuous_progressive
 * - small: otherwise -> small, single_pass
 *
 * @param {Array<object>} eligibleFiles
 * @returns {{ mode: string, strategy: string, eligibleCount: number, eligibleBytes: number }}
 */
function selectIngestionMode(eligibleFiles = []) {
  const eligibleCount = eligibleFiles.length;
  let eligibleBytes = 0;
  for (const file of eligibleFiles) {
    eligibleBytes += file.sizeBytes || 0;
  }

  const { smallMaxFiles, smallMaxBytes, largeMinFiles, largeMinBytes } = DEFAULT_SCHEDULER_CONFIG.modeThresholds;

  if (eligibleCount >= largeMinFiles || eligibleBytes >= largeMinBytes) {
    return {
      mode: "large",
      strategy: "adaptive_progressive",
      eligibleCount,
      eligibleBytes,
    };
  }

  if (eligibleCount > smallMaxFiles || eligibleBytes > smallMaxBytes) {
    return {
      mode: "medium",
      strategy: "continuous_progressive",
      eligibleCount,
      eligibleBytes,
    };
  }

  return {
    mode: "small",
    strategy: "single_pass",
    eligibleCount,
    eligibleBytes,
  };
}

/**
 * Partitions classified eligible files into deterministic, resource-bounded batches.
 *
 * @param {Array<object>} eligibleFiles - Already sorted by (priorityRank ASC, path ASC)
 * @param {object} [options]
 * @returns {Array<{ batchNumber: number, files: Array<object>, totalBytes: number }>}
 */
function partitionIntoBatches(eligibleFiles = [], options = {}) {
  if (eligibleFiles.length === 0) return [];

  const batch1MaxFiles = options.batch1MaxFiles || DEFAULT_SCHEDULER_CONFIG.batch1MaxFiles;
  const subsequentBatchMaxFiles = options.subsequentBatchMaxFiles || DEFAULT_SCHEDULER_CONFIG.subsequentBatchMaxFiles;
  const maxBatchBytes = options.maxBatchBytes || DEFAULT_SCHEDULER_CONFIG.maxBatchBytes;

  const batches = [];
  let currentBatchNumber = 1;
  let currentBatchFiles = [];
  let currentBatchBytes = 0;

  for (const file of eligibleFiles) {
    const maxFilesForCurrentBatch = currentBatchNumber === 1 ? batch1MaxFiles : subsequentBatchMaxFiles;
    const fileSize = file.sizeBytes || 0;

    // Check if adding file would exceed batch limits
    const exceedsFileCount = currentBatchFiles.length >= maxFilesForCurrentBatch;
    const exceedsByteCap = currentBatchBytes + fileSize > maxBatchBytes && currentBatchFiles.length > 0;

    if (exceedsFileCount || exceedsByteCap) {
      batches.push({
        batchNumber: currentBatchNumber,
        files: currentBatchFiles,
        totalBytes: currentBatchBytes,
      });

      currentBatchNumber++;
      currentBatchFiles = [];
      currentBatchBytes = 0;
    }

    currentBatchFiles.push(file);
    currentBatchBytes += fileSize;
  }

  if (currentBatchFiles.length > 0) {
    batches.push({
      batchNumber: currentBatchNumber,
      files: currentBatchFiles,
      totalBytes: currentBatchBytes,
    });
  }

  return batches;
}

class ManifestScheduler {
  /**
   * @param {object} [options]
   * @param {import("./IngestionJobManager").IngestionJobManager} [options.jobManager]
   */
  constructor(options = {}) {
    this.jobManager = options.jobManager;
  }

  /**
   * Discovers and classifies repository manifest, persisting files into PostgreSQL ingestion_job_files.
   * If the job already has durable phase === 'downloading_batch', Git Tree rediscovery is skipped.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} params.workerId
   * @param {number} params.fencingToken
   * @param {string} params.owner
   * @param {string} params.repo
   * @param {string} [params.ref="HEAD"]
   * @param {Array<object>} [params.treeEntries] - Optional pre-loaded tree entries (e.g. for testing)
   * @param {object} [params.options]
   * @returns {Promise<{
   *   isRediscoverySkipped: boolean,
   *   totalFiles: number,
   *   mode: string,
   *   strategy: string,
   *   batches: Array<object>
   * }>}
   */
  async scheduleJob({
    jobId,
    workerId,
    fencingToken,
    owner,
    repo,
    ref = "HEAD",
    treeEntries = null,
    options = {},
  }) {
    if (!this.jobManager) {
      throw new AppError(500, "JOB_MANAGER_REQUIRED", "ManifestScheduler requires an IngestionJobManager instance.");
    }

    // 1. Inspect existing job record to verify recovery state
    const job = this.jobManager.memoryJobs
      ? this.jobManager.memoryJobs.get(jobId)
      : null;

    if (job) {
      if (Number(job.fencing_token) !== Number(fencingToken)) {
        throw new AppError(409, "STALE_FENCING_TOKEN", `Fencing token ${fencingToken} is stale.`);
      }
      if (job.claimed_by && job.claimed_by !== workerId) {
        throw new AppError(403, "WORKER_MISMATCH", `Job is claimed by ${job.claimed_by}, not ${workerId}.`);
      }

      // Check if durable manifest already exists
      if (job.phase === "downloading_batch" && job.total_files > 0) {
        // Rediscovery is strictly skipped!
        const existingFiles = await this.jobManager.getNextPendingBatch(jobId, 10000);
        return {
          isRediscoverySkipped: true,
          totalFiles: job.total_files,
          mode: job.mode,
          strategy: job.ingestion_strategy,
          batches: partitionIntoBatches(existingFiles),
        };
      }
    }

    // 2. Discover Git tree entries (reuse treeEntries if provided, or call GitHub API)
    let rawTree = treeEntries;
    let resolvedCommitSha = job ? job.commit_sha : null;
    let resolvedRootTreeSha = null;

    if (!rawTree) {
      const resolved = await github.resolveCommitAndRootTree(owner, repo, ref, options);
      if (!resolved || !resolved.commitSha || !resolved.rootTreeSha) {
        throw new AppError(502, "GITHUB_RESOLVE_FAILED", "Failed to resolve repository commit and root tree SHA.");
      }
      resolvedCommitSha = resolved.commitSha;
      resolvedRootTreeSha = resolved.rootTreeSha;

      const treeResult = await github.fetchGitTree(owner, repo, resolvedRootTreeSha, {
        recursive: true,
        ...options,
      });
      rawTree = treeResult.tree;
    }

    // 3. Classify manifest files & select mode
    const classification = classifyRepositoryManifest(rawTree, options);
    const modeConfig = selectIngestionMode(classification.eligible);
    const batches = partitionIntoBatches(classification.eligible, options);

    // 4. Update job mode and root tree SHA
    if (job) {
      job.mode = modeConfig.mode;
      job.ingestion_strategy = modeConfig.strategy;
      job.root_tree_sha = resolvedRootTreeSha;
      job.total_batches = batches.length;
    }

    // 5. Persist classified files into ingestion_job_files
    await this.jobManager.populateJobFiles(jobId, classification.eligible);

    return {
      isRediscoverySkipped: false,
      totalFiles: classification.eligible.length,
      mode: modeConfig.mode,
      strategy: modeConfig.strategy,
      batches,
    };
  }

  /**
   * Fetches and downloads the next prioritized batch of files for a job.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} params.workerId
   * @param {number} params.fencingToken
   * @param {number} [params.batchSize=100]
   * @param {object} [params.options]
   * @returns {Promise<object>} Download outcome summary
   */
  async processNextBatch({
    jobId,
    workerId,
    fencingToken,
    batchSize = 100,
    options = {},
  }) {
    // 1. Fetch next pending files ordered deterministically by (priority_rank ASC, path ASC)
    const pendingBatch = await this.jobManager.getNextPendingBatch(jobId, batchSize);

    if (pendingBatch.length === 0) {
      return {
        batchProcessed: false,
        remainingFiles: 0,
        downloadResults: null,
      };
    }

    // 2. Download batch files concurrently using BatchDownloader
    const downloadResults = await this.jobManager.downloadBatch({
      jobId,
      workerId,
      fencingToken,
      batchFiles: pendingBatch,
      options,
    });

    let parseResults = null;
    let commitResults = null;

    if (options.parseAndCommit === true) {
      const job = this.jobManager.useMemoryStore
        ? this.jobManager.memoryJobs.get(jobId)
        : null;

      const repository = {
        fullName: job ? job.repository_id : (options.repositoryId || "owner/repo"),
        owner: ((job ? job.repository_id : options.repositoryId) || "owner/repo").split("/")[0],
        name: ((job ? job.repository_id : options.repositoryId) || "owner/repo").split("/")[1],
        commitSha: job ? job.commit_sha : (options.commitSha || "main"),
      };

      const organizationId = job ? job.organization_id : (options.organizationId || "org_default");
      const currentBatchNumber = (job ? job.last_committed_batch : 0) + 1;

      parseResults = await parseAndPersistBatch({
        repository,
        organizationId,
        jobId,
        downloadedFiles: downloadResults.downloaded,
        failedFiles: downloadResults.failed,
        skippedFiles: downloadResults.skipped,
        options: {
          concurrency: options.parserConcurrency || 4,
          fileTimeoutMs: options.fileTimeoutMs || 5000,
          storageClient: options.storageClient,
          registry: options.registry,
          jobManager: this.jobManager,
          isCancelled: () => this.jobManager.isJobCancelled(jobId),
        },
      });

      if (!parseResults.isCancelled) {
        commitResults = await this.jobManager.commitBatch({
          jobId,
          workerId,
          fencingToken,
          batchNumber: currentBatchNumber,
          fileOutcomes: parseResults.outcomes,
          options,
        });
      }
    }

    return {
      batchProcessed: true,
      batchSize: pendingBatch.length,
      downloadResults,
      parseResults,
      commitResults,
    };
  }
}

module.exports = {
  DEFAULT_SCHEDULER_CONFIG,
  BINARY_AND_MEDIA_EXTENSIONS,
  computePriorityRank,
  classifyManifestFile,
  classifyRepositoryManifest,
  selectIngestionMode,
  partitionIntoBatches,
  ManifestScheduler,
};

