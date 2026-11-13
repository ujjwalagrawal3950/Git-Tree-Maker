const { defaultRegistry } = require("./ParserRegistry");
const { validateFileIR } = require("./irValidator");
const { buildFileIR, createFileId } = require("./irBuilder");

const DEFAULT_SCHEDULER_CONFIG = {
  concurrency: 5,
  fileTimeoutMs: 5000,
};

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
 * Wraps a promise with a timeout deadline.
 *
 * NOTE ON TIMEOUT GUARANTEES:
 * A Promise timeout using Promise.race() is cooperative and stops waiting for the promise deadline.
 * It does not terminate synchronous, CPU-bound JavaScript execution if an AST parser blocks the event loop.
 * For true hard CPU preemption in future phases, parsers can be executed inside worker threads.
 *
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} errorMessage
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, errorMessage) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(errorMessage);
      err.code = "PARSER_TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Coordinates concurrent parsing across a set of retrieved repository files.
 *
 * @param {object} params
 * @param {object} params.repository - { owner, name, fullName, commitSha }
 * @param {Array<object>} params.files - Retrieved source files from Phase 04
 * @param {object} [params.options]
 * @param {import('./ParserRegistry').ParserRegistry} [params.options.registry]
 * @param {number} [params.options.concurrency]
 * @param {number} [params.options.fileTimeoutMs]
 * @returns {Promise<object>} Consolidated parse result
 */
async function scheduleRepositoryParse({
  repository,
  files = [],
  options = {},
}) {
  const startTime = Date.now();
  const registry = options.registry || defaultRegistry;
  const concurrency = options.concurrency || DEFAULT_SCHEDULER_CONFIG.concurrency;
  const fileTimeoutMs = options.fileTimeoutMs || DEFAULT_SCHEDULER_CONFIG.fileTimeoutMs;

  const repoFullName = repository.fullName || `${repository.owner}/${repository.name}`;

  if (!files || files.length === 0) {
    return {
      repository: repoFullName,
      commitSha: repository.commitSha || null,
      status: "empty",
      files: [],
      summary: {
        totalFiles: 0,
        parsedComplete: 0,
        parsedPartial: 0,
        unsupported: 0,
        failed: 0,
        totalSymbols: 0,
        totalImports: 0,
        totalExports: 0,
        durationMs: 0,
      },
    };
  }

  const parseResults = await runBoundedPool(files, concurrency, async (file) => {
    const fileId = file.fileId || createFileId(repoFullName, file.path);
    const adapter = registry.getAdapter(file.language);

    try {
      // Execute adapter with per-file timeout protection
      const fileIR = await withTimeout(
        adapter.parseFile({ ...file, repository }, options),
        fileTimeoutMs,
        `Parsing for ${file.path} exceeded ${fileTimeoutMs}ms timeout.`
      );

      // Validate against Cartograph IR Schema
      const validation = validateFileIR(fileIR);
      if (!validation.isValid) {
        fileIR.diagnostics.push({
          code: "SCHEMA_VALIDATION_WARNING",
          severity: "warning",
          message: `IR validation issues: ${validation.errors.join("; ")}`,
          location: null,
        });
      }

      return fileIR;
    } catch (error) {
      // Zero-abort: Convert unhandled parse error or timeout into valid fallback IR
      return buildFileIR({
        repository,
        file: {
          fileId,
          path: file.path,
          blobSha: file.blobSha,
          language: file.language || "unknown",
          category: file.category || "source",
          sizeBytes: typeof file.size === "number" ? file.size : 0,
          content: file.content,
        },
        parser: {
          adapterId: adapter.adapterId || "unknown",
          adapterVersion: adapter.adapterVersion || "1.0.0",
          engine: adapter.engine || "unknown",
          engineVersion: adapter.engineVersion || "0.0.0",
          grammarVersion: null,
          status: "failed",
          capabilities: [],
          durationMs: 0,
        },
        symbols: [],
        imports: [],
        exports: [],
        diagnostics: [
          {
            code: error.code || "PARSE_FAILURE",
            severity: "error",
            message: error.message || "Failed to parse file.",
            location: null,
          },
        ],
      });
    }
  });

  // Aggregate summary metrics
  let parsedComplete = 0;
  let parsedPartial = 0;
  let unsupported = 0;
  let failed = 0;
  let totalSymbols = 0;
  let totalImports = 0;
  let totalExports = 0;

  for (const ir of parseResults) {
    const status = ir.parser && ir.parser.status;
    if (status === "complete") parsedComplete++;
    else if (status === "partial") parsedPartial++;
    else if (status === "unsupported") unsupported++;
    else if (status === "failed") failed++;

    if (ir.stats) {
      totalSymbols += ir.stats.symbols || 0;
      totalImports += ir.stats.imports || 0;
      totalExports += ir.stats.exports || 0;
    }
  }

  const overallStatus =
    failed === parseResults.length
      ? "failed"
      : parsedPartial > 0 || failed > 0 || unsupported > 0
      ? "partial"
      : "complete";

  const totalDurationMs = Date.now() - startTime;

  return {
    repository: repoFullName,
    commitSha: repository.commitSha || null,
    status: overallStatus,
    files: parseResults,
    summary: {
      totalFiles: parseResults.length,
      parsedComplete,
      parsedPartial,
      unsupported,
      failed,
      totalSymbols,
      totalImports,
      totalExports,
      durationMs: totalDurationMs,
    },
  };
}

module.exports = {
  DEFAULT_SCHEDULER_CONFIG,
  runBoundedPool,
  withTimeout,
  scheduleRepositoryParse,
};

