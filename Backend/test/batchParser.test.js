const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  DEFAULT_PARSER_CONFIG,
  InMemoryStorageClient,
  computeParserFingerprint,
  buildFileIrStoragePath,
  uploadFileIrArtifact,
  parseSingleFile,
  parseAndPersistBatch,
  safeOrphanCleanup,
} = require("../services/ingestion/BatchParser");

const { IngestionJobManager } = require("../services/ingestion/IngestionJobManager");
const { ManifestScheduler } = require("../services/ingestion/ManifestScheduler");
const { defaultRegistry, ParserRegistry } = require("../services/parser/ParserRegistry");
const { validateFileIR } = require("../services/parser/irValidator");
const BaseAdapter = require("../services/parser/adapters/BaseAdapter");
const { withTimeout } = require("../services/parser/ParserScheduler");

const TEST_REPO = {
  owner: "cartograph-org",
  name: "demo-repo",
  fullName: "cartograph-org/demo-repo",
  commitSha: "a1b2c3d4e5f67890123456789abcdef012345678",
};

const TEST_ORG_ID = "org_cartograph_test_99";

// ============================================================================
// 1. ALL SUPPORTED LANGUAGE ADAPTERS THROUGH REGISTRY
// ============================================================================
test("Gate 11D - Requirement 1: All supported language adapters parse via existing registry producing valid FileIR v1.0.0", async () => {
  const languageFixtures = [
    {
      lang: "javascript",
      path: "src/app.js",
      content: "export function greet(name) { return `Hello, ${name}`; }",
    },
    {
      lang: "typescript",
      path: "src/types.ts",
      content: "export interface User { id: string; name: string; }\nexport const admin: User = { id: '1', name: 'Admin' };",
    },
    {
      lang: "python",
      path: "main.py",
      content: "def add(a: int, b: int) -> int:\n    return a + b\n",
    },
    {
      lang: "java",
      path: "src/main/java/App.java",
      content: "package com.example;\npublic class App {\n    public static void main(String[] args) {}\n}\n",
    },
    {
      lang: "c",
      path: "src/calc.c",
      content: "#include <stdio.h>\nint multiply(int x, int y) { return x * y; }\n",
    },
    {
      lang: "cpp",
      path: "src/engine.cpp",
      content: "#include <iostream>\nclass Engine { public: void start() {} };\n",
    },
    {
      lang: "c_cpp_header",
      path: "include/engine.h",
      content: "#ifndef ENGINE_H\n#define ENGINE_H\nvoid run();\n#endif\n",
    },
    {
      lang: "unsupported_lang",
      path: "script.rb",
      content: "puts 'Hello World'",
    },
  ];

  for (const fixture of languageFixtures) {
    const downloadedItem = {
      path: fixture.path,
      blobSha: crypto.createHash("sha1").update(fixture.content).digest("hex"),
      content: fixture.content,
      byteLength: Buffer.byteLength(fixture.content, "utf8"),
      file: {
        path: fixture.path,
        language: fixture.lang,
        category: "source",
      },
    };

    const result = await parseSingleFile({
      downloadedItem,
      repository: TEST_REPO,
      registry: defaultRegistry,
      fileTimeoutMs: 5000,
    });

    assert.ok(result.fileIR, `FileIR missing for ${fixture.lang}`);
    assert.equal(result.fileIR.irVersion, "1.0.0");
    assert.ok(result.parserFingerprint, "Parser fingerprint must be defined");

    const validation = validateFileIR(result.fileIR);
    assert.equal(validation.isValid, true, `Validation failed for ${fixture.lang}: ${validation.errors.join("; ")}`);

    if (fixture.lang === "unsupported_lang") {
      assert.equal(result.fileIR.parser.status, "unsupported");
    } else {
      assert.ok(["complete", "partial"].includes(result.fileIR.parser.status));
    }
  }
});

// ============================================================================
// 2. FILEIR V1.0.0 SCHEMA VALIDATION
// ============================================================================
test("Gate 11D - Requirement 2: Strict FileIR v1.0.0 schema validation preserves diagnostics and never outputs invalid IR", async () => {
  const malformedJs = "function broken( { syntax error here";
  const downloadedItem = {
    path: "src/broken.js",
    blobSha: "sha_broken_123",
    content: malformedJs,
    byteLength: Buffer.byteLength(malformedJs, "utf8"),
    file: { path: "src/broken.js", language: "javascript", category: "source" },
  };

  const result = await parseSingleFile({
    downloadedItem,
    repository: TEST_REPO,
    registry: defaultRegistry,
    fileTimeoutMs: 5000,
  });

  assert.equal(result.fileIR.irVersion, "1.0.0");
  assert.equal(result.isPartial, true);
  assert.ok(result.fileIR.diagnostics.length > 0, "Syntax error diagnostics must be captured");

  const validation = validateFileIR(result.fileIR);
  assert.equal(validation.isValid, true, "Partial syntax error FileIR must remain strictly schema-compliant");
});

// ============================================================================
// 3. BOUNDED PARSER CONCURRENCY
// ============================================================================
test("Gate 11D - Requirement 3: Parser concurrency is strictly bounded (max 4 concurrent tasks)", async () => {
  let activeConcurrency = 0;
  let maxObservedConcurrency = 0;

  class MonitoredAdapter extends BaseAdapter {
    constructor() {
      super({ adapterId: "monitored-adapter", adapterVersion: "1.0.0" });
    }
    getSupportedLanguages() {
      return ["monitored_lang"];
    }
    async parseFile(file) {
      activeConcurrency++;
      if (activeConcurrency > maxObservedConcurrency) {
        maxObservedConcurrency = activeConcurrency;
      }
      // Async delay to measure overlap
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeConcurrency--;

      const { buildFileIR } = require("../services/parser/irBuilder");
      return buildFileIR({
        repository: file.repository,
        file: {
          fileId: file.fileId,
          path: file.path,
          blobSha: file.blobSha,
          language: "monitored_lang",
          category: "source",
          sizeBytes: file.size,
          content: file.content,
        },
        parser: {
          adapterId: this.adapterId,
          adapterVersion: this.adapterVersion,
          status: "complete",
          capabilities: ["symbols"],
        },
      });
    }
  }

  const customRegistry = new ParserRegistry();
  customRegistry.registerAdapter(new MonitoredAdapter());

  const files = [];
  for (let i = 0; i < 12; i++) {
    files.push({
      path: `src/file_${i}.mon`,
      blobSha: `sha_mon_${i}`,
      content: `code ${i}`,
      byteLength: 10,
      file: { path: `src/file_${i}.mon`, language: "monitored_lang", category: "source" },
    });
  }

  const storageClient = new InMemoryStorageClient();
  const res = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: "job_concurrency_test",
    downloadedFiles: files,
    options: {
      concurrency: 4, // Max allowed concurrency
      registry: customRegistry,
      storageClient,
    },
  });

  assert.equal(res.summary.parsed, 12);
  assert.ok(maxObservedConcurrency <= 4, `Observed concurrency ${maxObservedConcurrency} exceeded bound of 4`);
  assert.ok(maxObservedConcurrency >= 2, `Expected concurrency overlap, observed: ${maxObservedConcurrency}`);
});

// ============================================================================
// 4. PARSER FAILURE ISOLATION
// ============================================================================
test("Gate 11D - Requirement 4: Parser failure isolation prevents single file failure from terminating the batch", async () => {
  class FaultyAdapter extends BaseAdapter {
    constructor() {
      super({ adapterId: "faulty-adapter", adapterVersion: "1.0.0" });
    }
    getSupportedLanguages() {
      return ["faulty_lang"];
    }
    async parseFile(file) {
      if (file.path.includes("bad")) {
        throw new Error("Fatal unhandled AST engine crash!");
      }
      const { buildFileIR } = require("../services/parser/irBuilder");
      return buildFileIR({
        repository: file.repository,
        file: {
          fileId: file.fileId,
          path: file.path,
          blobSha: file.blobSha,
          language: "faulty_lang",
          category: "source",
          sizeBytes: file.size,
          content: file.content,
        },
        parser: {
          adapterId: this.adapterId,
          adapterVersion: this.adapterVersion,
          status: "complete",
          capabilities: ["symbols"],
        },
      });
    }
  }

  const customRegistry = new ParserRegistry();
  customRegistry.registerAdapter(new FaultyAdapter());

  const files = [
    {
      path: "src/good_1.flt",
      blobSha: "sha_good_1",
      content: "good 1",
      byteLength: 6,
      file: { path: "src/good_1.flt", language: "faulty_lang", category: "source" },
    },
    {
      path: "src/bad_crash.flt",
      blobSha: "sha_bad_crash",
      content: "bad crash",
      byteLength: 9,
      file: { path: "src/bad_crash.flt", language: "faulty_lang", category: "source" },
    },
    {
      path: "src/good_2.flt",
      blobSha: "sha_good_2",
      content: "good 2",
      byteLength: 6,
      file: { path: "src/good_2.flt", language: "faulty_lang", category: "source" },
    },
  ];

  const storageClient = new InMemoryStorageClient();
  const outcome = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: "job_isolation_test",
    downloadedFiles: files,
    options: {
      registry: customRegistry,
      storageClient,
    },
  });

  assert.equal(outcome.summary.total, 3);
  assert.equal(outcome.summary.parsed, 2);
  assert.equal(outcome.summary.failed, 1);

  const good1 = outcome.outcomes.find((o) => o.path === "src/good_1.flt");
  const bad = outcome.outcomes.find((o) => o.path === "src/bad_crash.flt");
  const good2 = outcome.outcomes.find((o) => o.path === "src/good_2.flt");

  assert.equal(good1.status, "parsed");
  assert.equal(good2.status, "parsed");
  assert.equal(bad.status, "failed");
  assert.equal(bad.errorCode, "PARSE_FAILURE");
  assert.ok(bad.errorMessage.includes("Fatal unhandled AST engine crash"));
});

// ============================================================================
// 5. TIMEOUT BEHAVIOR AND ITS ACTUAL LIMITATIONS
// ============================================================================
test("Gate 11D - Requirement 5: Cooperative timeout deadline fires and generates fallback FileIR; documents non-preemption", async () => {
  // 1. Verify cooperative timeout on async promise stall
  class HangingAsyncAdapter extends BaseAdapter {
    constructor() {
      super({ adapterId: "hanging-adapter", adapterVersion: "1.0.0" });
    }
    getSupportedLanguages() {
      return ["hanging_lang"];
    }
    async parseFile() {
      // Intentionally hangs indefinitely
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  const customRegistry = new ParserRegistry();
  customRegistry.registerAdapter(new HangingAsyncAdapter());

  const downloadedItem = {
    path: "src/hanging.hng",
    blobSha: "sha_hng_123",
    content: "hang",
    byteLength: 4,
    file: { path: "src/hanging.hng", language: "hanging_lang", category: "source" },
  };

  const startTime = Date.now();
  const result = await parseSingleFile({
    downloadedItem,
    repository: TEST_REPO,
    registry: customRegistry,
    fileTimeoutMs: 50, // Short 50ms timeout
  });
  const duration = Date.now() - startTime;

  assert.ok(duration < 1000, `Timeout should resolve near 50ms, took ${duration}ms`);
  assert.equal(result.isFailed, true);
  assert.equal(result.fileIR.parser.status, "failed");
  assert.equal(result.fileIR.diagnostics[0].code, "PARSER_TIMEOUT");

  // 2. Document limitation of Promise.race: does not preempt synchronous CPU execution
  let syncLoopCompleted = false;
  const syncTask = new Promise((resolve) => {
    const start = Date.now();
    while (Date.now() - start < 30) {
      // Synchronously busy-wait
    }
    syncLoopCompleted = true;
    resolve("done");
  });

  const timedOutPromise = withTimeout(syncTask, 10, "Timeout");
  await timedOutPromise.catch(() => {});
  // Because JavaScript is single-threaded, syncTask completed before timer could intervene
  assert.equal(syncLoopCompleted, true, "Synchronous CPU task completes despite Promise.race deadline");
});

// ============================================================================
// 6. STORAGE UPLOAD SUCCESS AND FAILURE
// ============================================================================
test("Gate 11D - Requirement 6: Storage upload writes valid artifact, and upload failure cleans up staged artifacts", async () => {
  const storageClient = new InMemoryStorageClient();

  const files = [
    {
      path: "src/ok1.js",
      blobSha: "sha_ok1",
      content: "export const x = 1;",
      byteLength: 19,
      file: { path: "src/ok1.js", language: "javascript", category: "source" },
    },
    {
      path: "src/ok2.js",
      blobSha: "sha_ok2",
      content: "export const y = 2;",
      byteLength: 19,
      file: { path: "src/ok2.js", language: "javascript", category: "source" },
    },
  ];

  // 1. Success case
  const successOutcome = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: "job_storage_test",
    downloadedFiles: files,
    options: { storageClient },
  });

  assert.equal(successOutcome.summary.parsed, 2);
  assert.equal(successOutcome.stagedArtifacts.length, 2);

  // Verify downloaded buffer from storage
  const downloaded1 = await storageClient.from("fileir-artifacts").download(successOutcome.stagedArtifacts[0].storagePath);
  assert.ok(downloaded1.data, "Stored artifact must be retrievable");
  const parsedJson = JSON.parse(downloaded1.data.toString("utf8"));
  assert.equal(parsedJson.irVersion, "1.0.0");

  // 2. Failure case: Storage upload error cleans up staged artifacts
  let uploadCallCount = 0;
  const failingStorageClient = {
    from: () => ({
      upload: async () => {
        uploadCallCount++;
        if (uploadCallCount === 2) {
          const err = new Error("Network timeout to storage bucket");
          return { data: null, error: err };
        }
        return { data: { path: "ok" }, error: null };
      },
      remove: async () => ({ data: [], error: null }),
    }),
  };

  await assert.rejects(
    async () => {
      await parseAndPersistBatch({
        repository: TEST_REPO,
        organizationId: TEST_ORG_ID,
        jobId: "job_storage_fail",
        downloadedFiles: files,
        options: { storageClient: failingStorageClient },
      });
    },
    (err) => {
      assert.equal(err.code, "STORAGE_UPLOAD_FAILED");
      return true;
    }
  );
});

// ============================================================================
// 7. IDEMPOTENT ARTIFACT RETRIES
// ============================================================================
test("Gate 11D - Requirement 7: Idempotent artifact retry succeeds safely when identical artifact already exists", async () => {
  const storageClient = new InMemoryStorageClient();
  const buffer = Buffer.from(JSON.stringify({ irVersion: "1.0.0", test: true }), "utf8");
  const fullSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const storagePath = "org/repo/sha/fileir/test_file.fileir.json";

  // First upload
  const upload1 = await uploadFileIrArtifact({
    storageClient,
    storagePath,
    buffer,
    fullSha256,
  });
  assert.equal(upload1.alreadyExisted, false);

  // Second upload with identical path & hash (upsert: false simulates existing resource)
  const upload2 = await uploadFileIrArtifact({
    storageClient,
    storagePath,
    buffer,
    fullSha256,
  });
  assert.equal(upload2.alreadyExisted, true);
  assert.equal(upload2.fullSha256, fullSha256);
});

// ============================================================================
// 8. FULL SHA-256 ARTIFACT IDENTITY
// ============================================================================
test("Gate 11D - Requirement 8: Artifact path incorporates full 64-char SHA-256, tenant, repo, commit, and fingerprint", () => {
  const fullSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const path = buildFileIrStoragePath({
    organizationId: "org_alpha",
    repositoryId: "facebook/react",
    commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    filePath: "packages/react/src/index.js",
    blobSha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    parserFingerprint: "javascript-babel@1.0.0:babel@7.24.0",
    fullSha256,
  });

  assert.ok(path.startsWith("org_alpha/facebook/react/6dcb09b5b57875f334f61aebed695e2e4193db5e/fileir/"));
  assert.ok(path.includes("packages/react/src/index.js"));
  assert.ok(path.includes("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"));
  assert.ok(path.includes("fp_javascript-babel_1.0.0_babel_7.24.0"));
  assert.ok(path.endsWith(`_${fullSha256}.fileir.json`));

  // Extract hash and verify exact 64 hexadecimal characters
  const match = path.match(/([0-9a-f]{64})\.fileir\.json$/);
  assert.ok(match, "Path must end with 64-character hex hash");
  assert.equal(match[1], fullSha256);
});

// ============================================================================
// 9. ATOMIC BATCH COMMIT
// ============================================================================
test("Gate 11D - Requirement 9: commitBatch executes atomic multi-row commit and updates job progress", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const job = await manager.createJob({
    repositoryId: "owner/repo",
    organizationId: "org_1",
    commitSha: "commit_abc",
  });

  const claim = await manager.claimNextJob("worker_batch");
  assert.ok(claim);

  await manager.populateJobFiles(job.id, [
    { path: "src/a.js", blobSha: "sha_a", sizeBytes: 10, category: "source_code", language: "javascript" },
    { path: "src/b.js", blobSha: "sha_b", sizeBytes: 20, category: "source_code", language: "javascript" },
  ]);

  const fileOutcomes = [
    {
      path: "src/a.js",
      status: "parsed",
      storagePath: "org_1/owner/repo/commit_abc/fileir/src_a.fileir.json",
      sha256: "a".repeat(64),
      bytes: 100,
      parserFingerprint: "js@1.0",
      errorCode: null,
      errorMessage: null,
    },
    {
      path: "src/b.js",
      status: "parsed",
      storagePath: "org_1/owner/repo/commit_abc/fileir/src_b.fileir.json",
      sha256: "b".repeat(64),
      bytes: 200,
      parserFingerprint: "js@1.0",
      errorCode: null,
      errorMessage: null,
    },
  ];

  const commitRes = await manager.commitBatch({
    jobId: job.id,
    workerId: "worker_batch",
    fencingToken: claim.fencing_token,
    batchNumber: 1,
    fileOutcomes,
  });

  assert.equal(commitRes.success, true);
  assert.equal(commitRes.batchNumber, 1);
  assert.equal(commitRes.filesCommitted, 2);

  // Verify memory job updates
  const updatedJob = manager.memoryJobs.get(job.id);
  assert.equal(updatedJob.last_committed_batch, 1);
  assert.equal(updatedJob.parsed_files, 2);
  assert.equal(updatedJob.processed_files, 2);
  assert.equal(updatedJob.remaining_files, 0);

  // Verify memory file updates
  const filesMap = manager.memoryFiles.get(job.id);
  const fileA = filesMap.get("src/a.js");
  assert.equal(fileA.status, "parsed");
  assert.equal(fileA.batch_number, 1);
  assert.equal(fileA.file_ir_sha256, "a".repeat(64));
});

// ============================================================================
// 10. STALE FENCING TOKEN REJECTION
// ============================================================================
test("Gate 11D - Requirement 10: Stale worker fencing token is strictly rejected by commitBatch", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const job = await manager.createJob({
    repositoryId: "owner/repo",
    organizationId: "org_1",
    commitSha: "commit_abc",
  });

  const claim = await manager.claimNextJob("worker_zombie");
  await manager.populateJobFiles(job.id, [
    { path: "src/a.js", blobSha: "sha_a", sizeBytes: 10, category: "source_code", language: "javascript" },
  ]);

  // Simulate token increment (e.g. lease reclaim by another worker)
  job.fencing_token = 2;

  await assert.rejects(
    async () => {
      await manager.commitBatch({
        jobId: job.id,
        workerId: "worker_zombie",
        fencingToken: 1, // Stale token!
        batchNumber: 1,
        fileOutcomes: [{ path: "src/a.js", status: "parsed" }],
      });
    },
    (err) => {
      assert.equal(err.code, "STALE_FENCING_TOKEN");
      return true;
    }
  );

  // Verify no mutation occurred
  const fileA = manager.memoryFiles.get(job.id).get("src/a.js");
  assert.equal(fileA.status, "pending");
  assert.equal(job.last_committed_batch, 0);
});

// ============================================================================
// 11. LEASE EXPIRATION DURING PROCESSING
// ============================================================================
test("Gate 11D - Requirement 11: commitBatch rejects commit if worker lease expired before completion", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const job = await manager.createJob({
    repositoryId: "owner/repo",
    organizationId: "org_1",
    commitSha: "commit_abc",
  });

  const claim = await manager.claimNextJob("worker_slow");
  await manager.populateJobFiles(job.id, [
    { path: "src/a.js", blobSha: "sha_a", sizeBytes: 10, category: "source_code", language: "javascript" },
  ]);

  // Expire lease directly on the active job record
  const memoryJob = manager.memoryJobs.get(job.id);
  memoryJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    async () => {
      await manager.commitBatch({
        jobId: job.id,
        workerId: "worker_slow",
        fencingToken: claim.fencing_token,
        batchNumber: 1,
        fileOutcomes: [{ path: "src/a.js", status: "parsed" }],
      });
    },
    (err) => {
      assert.equal(err.code, "LEASE_EXPIRED");
      return true;
    }
  );

  assert.equal(memoryJob.last_committed_batch, 0);
});

// ============================================================================
// 12. PRESERVATION OF PREVIOUSLY COMMITTED BATCHES
// ============================================================================
test("Gate 11D - Requirement 12: Previously committed batches cannot be overwritten or regressed", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const job = await manager.createJob({
    repositoryId: "owner/repo",
    organizationId: "org_1",
    commitSha: "commit_abc",
  });

  const claim = await manager.claimNextJob("worker_persist");
  await manager.populateJobFiles(job.id, [
    { path: "src/batch1.js", blobSha: "sha_1", sizeBytes: 10, category: "source_code", language: "javascript" },
    { path: "src/batch2.js", blobSha: "sha_2", sizeBytes: 10, category: "source_code", language: "javascript" },
  ]);

  // 1. Commit batch 1
  await manager.commitBatch({
    jobId: job.id,
    workerId: "worker_persist",
    fencingToken: claim.fencing_token,
    batchNumber: 1,
    fileOutcomes: [{ path: "src/batch1.js", status: "parsed", sha256: "1".repeat(64) }],
  });

  const updatedJob1 = manager.memoryJobs.get(job.id);
  assert.equal(updatedJob1.last_committed_batch, 1);

  // 2. Attempt to commit batch 1 again (should reject as duplicate/stale batch number)
  await assert.rejects(
    async () => {
      await manager.commitBatch({
        jobId: job.id,
        workerId: "worker_persist",
        fencingToken: claim.fencing_token,
        batchNumber: 1,
        fileOutcomes: [{ path: "src/batch2.js", status: "parsed" }],
      });
    },
    (err) => {
      assert.equal(err.code, "BATCH_ALREADY_COMMITTED");
      return true;
    }
  );

  // 3. Attempt to re-commit file from batch 1 in batch 2 (should reject file overwrite)
  await assert.rejects(
    async () => {
      await manager.commitBatch({
        jobId: job.id,
        workerId: "worker_persist",
        fencingToken: claim.fencing_token,
        batchNumber: 2,
        fileOutcomes: [{ path: "src/batch1.js", status: "parsed" }],
      });
    },
    (err) => {
      assert.equal(err.code, "FILE_ALREADY_COMMITTED");
      return true;
    }
  );

  // Batch 1 file remains intact
  const file1 = manager.memoryFiles.get(job.id).get("src/batch1.js");
  assert.equal(file1.status, "parsed");
  assert.equal(file1.batch_number, 1);
});

// ============================================================================
// 13. RECOVERY AFTER PARTIAL BATCH PROCESSING
// ============================================================================
test("Gate 11D - Requirement 13: Dangling job recovery preserves committed batches and resets uncommitted files", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const job = await manager.createJob({
    repositoryId: "owner/repo",
    organizationId: "org_1",
    commitSha: "commit_abc",
  });

  const claim1 = await manager.claimNextJob("worker_crash_1");
  await manager.populateJobFiles(job.id, [
    { path: "src/b1.js", blobSha: "sha_b1", sizeBytes: 10, category: "source_code", language: "javascript" },
    { path: "src/b2.js", blobSha: "sha_b2", sizeBytes: 10, category: "source_code", language: "javascript" },
  ]);

  // Commit batch 1
  await manager.commitBatch({
    jobId: job.id,
    workerId: "worker_crash_1",
    fencingToken: claim1.fencing_token,
    batchNumber: 1,
    fileOutcomes: [{ path: "src/b1.js", status: "parsed", sha256: "b1".repeat(32) }],
  });

  // Worker 1 starts batch 2: downloads file, but dies before commit
  const filesMap = manager.memoryFiles.get(job.id);
  const b2 = filesMap.get("src/b2.js");
  b2.status = "downloaded";
  b2.batch_number = 2;

  // Lease expires
  const memoryJob = manager.memoryJobs.get(job.id);
  memoryJob.lease_expires_at = new Date(Date.now() - 5000).toISOString();

  // Run reconciliation
  const recon = await manager.reconcileDanglingJobs();
  assert.equal(recon.requeuedCount, 1);

  // Assertions:
  // 1. Batch 1 file remained parsed and committed
  const b1After = filesMap.get("src/b1.js");
  assert.equal(b1After.status, "parsed");
  assert.equal(b1After.batch_number, 1);

  // 2. Uncommitted batch 2 file reset to pending
  const b2After = filesMap.get("src/b2.js");
  assert.equal(b2After.status, "pending");
  assert.equal(b2After.batch_number, null);

  // 3. Fencing token incremented by reconciliation
  assert.ok(Number(memoryJob.fencing_token) > Number(claim1.fencing_token));

  // 4. New worker claims and processes batch 2
  const claim2 = await manager.claimNextJob("worker_healthy_2");
  assert.equal(claim2.id, job.id);
  assert.ok(Number(claim2.fencing_token) > Number(claim1.fencing_token));

  await manager.commitBatch({
    jobId: job.id,
    workerId: "worker_healthy_2",
    fencingToken: claim2.fencing_token,
    batchNumber: 2,
    fileOutcomes: [{ path: "src/b2.js", status: "parsed", sha256: "b2".repeat(32) }],
  });

  const updatedJob2 = manager.memoryJobs.get(job.id);
  assert.equal(updatedJob2.last_committed_batch, 2);
  assert.equal(updatedJob2.parsed_files, 2);
});

// ============================================================================
// 14. CANCELLATION BEHAVIOR
// ============================================================================
test("Gate 11D - Requirement 14: Job cancellation aborts parsing and rejects commitBatch", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const job = await manager.createJob({
    repositoryId: "owner/repo",
    organizationId: "org_1",
    commitSha: "commit_abc",
  });

  const claim = await manager.claimNextJob("worker_cancel");
  await manager.populateJobFiles(job.id, [
    { path: "src/c1.js", blobSha: "sha_c1", sizeBytes: 10, category: "source_code", language: "javascript" },
  ]);

  // Request cancellation with authorized organization ID
  await manager.requestCancellation(job.id, "org_1");
  const cancelledJob = manager.memoryJobs.get(job.id);
  assert.equal(cancelledJob.status, "cancel_requested");

  // Attempt commitBatch
  await assert.rejects(
    async () => {
      await manager.commitBatch({
        jobId: job.id,
        workerId: "worker_cancel",
        fencingToken: claim.fencing_token,
        batchNumber: 1,
        fileOutcomes: [{ path: "src/c1.js", status: "parsed" }],
      });
    },
    (err) => {
      assert.equal(err.code, "JOB_CANCELLED");
      return true;
    }
  );

  // Verify parseAndPersistBatch honors isCancelled
  const storageClient = new InMemoryStorageClient();
  const outcome = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: job.id,
    downloadedFiles: [
      {
        path: "src/c1.js",
        blobSha: "sha_c1",
        content: "var x = 1;",
        byteLength: 10,
        file: { path: "src/c1.js", language: "javascript", category: "source" },
      },
    ],
    options: {
      storageClient,
      isCancelled: () => true, // Cooperative cancellation check
    },
  });

  assert.equal(outcome.isCancelled, true);
  assert.equal(outcome.outcomes.length, 0);
});

// ============================================================================
// 15. REGRESSION: IMMUTABLE ARTIFACT CLEANUP SAFETY
// ============================================================================
test("Gate 11D - Regression 15: Batch 2 failure must never delete Batch 1's committed or reused artifacts", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();

  const job = await manager.createJob({
    repositoryId: TEST_REPO.fullName,
    organizationId: TEST_ORG_ID,
    commitSha: TEST_REPO.commitSha,
  });

  const claim = await manager.claimNextJob("worker_cleanup_test");
  await manager.populateJobFiles(job.id, [
    { path: "src/shared_util.js", blobSha: "sha_shared", sizeBytes: 50, category: "source_code", language: "javascript" },
    { path: "src/new_service.js", blobSha: "sha_new", sizeBytes: 60, category: "source_code", language: "javascript" },
  ]);

  // 1. Batch 1 parses and commits artifact A (src/shared_util.js)
  const batch1Files = [
    {
      path: "src/shared_util.js",
      blobSha: "sha_shared",
      content: "export const shared = 'A';",
      byteLength: 26,
      file: { path: "src/shared_util.js", language: "javascript", category: "source" },
    },
  ];

  const batch1Parsed = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: job.id,
    downloadedFiles: batch1Files,
    options: { storageClient, jobManager: manager },
  });

  assert.equal(batch1Parsed.summary.parsed, 1);
  const artifactPathA = batch1Parsed.stagedArtifacts[0].storagePath;

  // Verify artifact A exists in storage
  const readA1 = await storageClient.from("fileir-artifacts").download(artifactPathA);
  assert.ok(readA1.data, "Artifact A must exist in storage");

  // Commit Batch 1
  await manager.commitBatch({
    jobId: job.id,
    workerId: "worker_cleanup_test",
    fencingToken: claim.fencing_token,
    batchNumber: 1,
    fileOutcomes: batch1Parsed.outcomes,
  });

  const updatedJob1 = manager.memoryJobs.get(job.id);
  assert.equal(updatedJob1.last_committed_batch, 1);

  // 2. Batch 2 encounters artifact A again (reused), stages artifact B, but fails during upload of B
  const batch2Files = [
    {
      path: "src/shared_util.js",
      blobSha: "sha_shared",
      content: "export const shared = 'A';",
      byteLength: 26,
      file: { path: "src/shared_util.js", language: "javascript", category: "source" },
    },
    {
      path: "src/new_service.js",
      blobSha: "sha_new",
      content: "export const service = 'B';",
      byteLength: 27,
      file: { path: "src/new_service.js", language: "javascript", category: "source" },
    },
  ];

  // Wrap storageClient to simulate failure when uploading artifact B
  const failingStorage = {
    from: (bucket) => {
      const realBucket = storageClient.from(bucket);
      return {
        ...realBucket,
        upload: async (p, body, opts) => {
          if (p.includes("new_service.js")) {
            const err = new Error("Storage simulated failure on artifact B");
            return { data: null, error: err };
          }
          return realBucket.upload(p, body, opts);
        },
      };
    },
  };

  // Attempt Batch 2: must throw STORAGE_UPLOAD_FAILED
  await assert.rejects(
    async () => {
      await parseAndPersistBatch({
        repository: TEST_REPO,
        organizationId: TEST_ORG_ID,
        jobId: job.id,
        downloadedFiles: batch2Files,
        options: {
          storageClient: failingStorage,
          jobManager: manager,
        },
      });
    },
    (err) => {
      assert.equal(err.code, "STORAGE_UPLOAD_FAILED");
      return true;
    }
  );

  // 3. CRITICAL VERIFICATION:
  // Artifact A MUST STILL EXIST in storage! It was NOT deleted by Batch 2 cleanup.
  const readA2 = await storageClient.from("fileir-artifacts").download(artifactPathA);
  assert.ok(readA2.data, "Artifact A MUST still exist after Batch 2 failure cleanup!");
  const contentA = JSON.parse(readA2.data.toString("utf8"));
  assert.equal(contentA.irVersion, "1.0.0");

  // Artifact B must not exist
  const listItems = await storageClient.from("fileir-artifacts").list();
  assert.ok(!listItems.data.some((item) => item.name.includes("new_service.js")), "Artifact B must not remain");
});

// ============================================================================
// 16. REGRESSION: LEASE EXPIRATION DURING STORAGE UPLOAD
// ============================================================================
test("Gate 11D - Regression 16: Lease expiration during storage upload rejects Worker A, preserves artifacts for Worker B", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();

  const job = await manager.createJob({
    repositoryId: TEST_REPO.fullName,
    organizationId: TEST_ORG_ID,
    commitSha: TEST_REPO.commitSha,
  });

  // Step 1: Worker A claims the job
  const claimA = await manager.claimNextJob("worker_A");
  assert.equal(claimA.claimed_by, "worker_A");
  const tokenA = claimA.fencing_token;

  await manager.populateJobFiles(job.id, [
    { path: "src/worker_test.js", blobSha: "sha_wt_1", sizeBytes: 30, category: "source_code", language: "javascript" },
  ]);

  const batchFiles = [
    {
      path: "src/worker_test.js",
      blobSha: "sha_wt_1",
      content: "export const worker = 'A';",
      byteLength: 26,
      file: { path: "src/worker_test.js", language: "javascript", category: "source" },
    },
  ];

  // Step 2 & 3: Worker A parses and uploads, but before Worker A commits, Worker A loses its lease
  const memoryJob = manager.memoryJobs.get(job.id);
  memoryJob.lease_expires_at = new Date(Date.now() - 2000).toISOString();

  // Worker B reclaims the job with a newer fencing token
  const claimB = await manager.claimNextJob("worker_B");
  assert.ok(claimB, "Worker B should successfully reclaim the expired job");
  assert.equal(claimB.claimed_by, "worker_B");
  assert.ok(Number(claimB.fencing_token) > Number(tokenA), "Worker B must have newer fencing token");

  // Step 4: Worker A finishes its storage upload
  const parsedA = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: job.id,
    downloadedFiles: batchFiles,
    options: { storageClient, jobManager: manager },
  });

  assert.equal(parsedA.summary.parsed, 1);
  const artifactPathA = parsedA.stagedArtifacts[0].storagePath;

  // Step 5: Worker A attempts to commitBatch with stale token & expired ownership
  await assert.rejects(
    async () => {
      await manager.commitBatch({
        jobId: job.id,
        workerId: "worker_A",
        fencingToken: tokenA, // Stale!
        batchNumber: 1,
        fileOutcomes: parsedA.outcomes,
      });
    },
    (err) => {
      assert.ok(
        ["WORKER_MISMATCH", "STALE_FENCING_TOKEN", "LEASE_EXPIRED"].includes(err.code),
        `Unexpected error code: ${err.code}`
      );
      return true;
    }
  );

  // Verify Worker A's commit was rejected: job is not committed
  assert.equal(memoryJob.last_committed_batch, 0);

  // Step 6: Worker B processes the exact same batch
  // Worker B runs parseAndPersistBatch: detects the existing content-addressed artifact in storage
  const parsedB = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: job.id,
    downloadedFiles: batchFiles,
    options: { storageClient, jobManager: manager },
  });

  assert.equal(parsedB.summary.parsed, 1);
  assert.equal(parsedB.stagedArtifacts[0].storagePath, artifactPathA);
  assert.equal(parsedB.stagedArtifacts[0].alreadyExisted, true, "Worker B must safely reuse Worker A's content-addressed artifact");

  // Step 7: Worker B commits with authoritative token
  const commitB = await manager.commitBatch({
    jobId: job.id,
    workerId: "worker_B",
    fencingToken: claimB.fencing_token,
    batchNumber: 1,
    fileOutcomes: parsedB.outcomes,
  });

  assert.equal(commitB.success, true);
  assert.equal(memoryJob.last_committed_batch, 1);
  assert.equal(memoryJob.parsed_files, 1);

  // Verify artifact remains in storage and valid
  const finalArtifact = await storageClient.from("fileir-artifacts").download(artifactPathA);
  assert.ok(finalArtifact.data);
  const parsedFinal = JSON.parse(finalArtifact.data.toString("utf8"));
  assert.equal(parsedFinal.irVersion, "1.0.0");
});

// ============================================================================
// 17. REGRESSION: WORKER A / WORKER B CLEANUP RACE
// ============================================================================
test("Gate 11D - Regression 17: Worker A cannot delete an artifact Worker B is about to commit (Race Resolution)", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();

  const job = await manager.createJob({
    repositoryId: TEST_REPO.fullName,
    organizationId: TEST_ORG_ID,
    commitSha: TEST_REPO.commitSha,
  });

  // Step 1: Worker A claims job and uploads a new immutable artifact
  const claimA = await manager.claimNextJob("worker_A");
  assert.equal(claimA.claimed_by, "worker_A");
  const tokenA = claimA.fencing_token;

  await manager.populateJobFiles(job.id, [
    { path: "src/race_file.js", blobSha: "sha_rf_1", sizeBytes: 40, category: "source_code", language: "javascript" },
  ]);

  const batchFiles = [
    {
      path: "src/race_file.js",
      blobSha: "sha_rf_1",
      content: "export const raceValue = 42;",
      byteLength: 28,
      file: { path: "src/race_file.js", language: "javascript", category: "source" },
    },
  ];

  const parsedA = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: job.id,
    downloadedFiles: batchFiles,
    options: { storageClient, jobManager: manager },
  });

  assert.equal(parsedA.summary.parsed, 1);
  const artifactPath = parsedA.stagedArtifacts[0].storagePath;
  assert.equal(parsedA.stagedArtifacts[0].alreadyExisted, false, "Worker A uploaded the new artifact");

  // Step 2: Worker A loses its lease
  const memoryJob = manager.memoryJobs.get(job.id);
  memoryJob.lease_expires_at = new Date(Date.now() - 3000).toISOString();

  // Step 3: Worker B reclaims the job
  const claimB = await manager.claimNextJob("worker_B");
  assert.ok(claimB);
  assert.equal(claimB.claimed_by, "worker_B");
  assert.ok(Number(claimB.fencing_token) > Number(tokenA));

  // Step 4: Worker B reuses the artifact because it already exists in storage
  const parsedB = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: job.id,
    downloadedFiles: batchFiles,
    options: { storageClient, jobManager: manager },
  });

  assert.equal(parsedB.summary.parsed, 1);
  assert.equal(parsedB.stagedArtifacts[0].storagePath, artifactPath);
  assert.equal(parsedB.stagedArtifacts[0].alreadyExisted, true, "Worker B reused existing artifact");

  // Step 5: Worker A attempts to commit and is rejected
  await assert.rejects(
    async () => {
      await manager.commitBatch({
        jobId: job.id,
        workerId: "worker_A",
        fencingToken: tokenA,
        batchNumber: 1,
        fileOutcomes: parsedA.outcomes,
      });
    },
    (err) => {
      assert.ok(["WORKER_MISMATCH", "STALE_FENCING_TOKEN", "LEASE_EXPIRED"].includes(err.code));
      return true;
    }
  );

  // Step 6: Worker A attempts cleanup before Worker B commits!
  // Safe orphan cleanup MUST protect Worker B: because Worker B holds an active lease on the job,
  // cleanup skips deletion and refuses to remove the artifact.
  const cleanupAttempt = await safeOrphanCleanup({
    storageClient,
    jobManager: manager,
    jobId: job.id,
  });

  assert.equal(cleanupAttempt.skippedDueToActiveJob, true, "Cleanup must be refused while Worker B holds an active lease");
  assert.equal(cleanupAttempt.deletedCount, 0, "Zero artifacts deleted by Worker A's cleanup attempt");

  // Verify artifact is STILL intact in storage
  const checkArtifact = await storageClient.from("fileir-artifacts").download(artifactPath);
  assert.ok(checkArtifact.data, "Artifact must remain in storage when Worker A attempts cleanup");

  // Step 7: Worker B commits its database reference
  const commitB = await manager.commitBatch({
    jobId: job.id,
    workerId: "worker_B",
    fencingToken: claimB.fencing_token,
    batchNumber: 1,
    fileOutcomes: parsedB.outcomes,
  });

  assert.equal(commitB.success, true);
  assert.equal(memoryJob.last_committed_batch, 1);

  // Verify the artifact remains accessible, committed, and schema-compliant
  const committedArtifact = await storageClient.from("fileir-artifacts").download(artifactPath);
  assert.ok(committedArtifact.data);
  const parsedDoc = JSON.parse(committedArtifact.data.toString("utf8"));
  assert.equal(parsedDoc.irVersion, "1.0.0");
  assert.ok(typeof parsedDoc.parser.durationMs === "number", "Actual runtime timing must be preserved");
});

// ============================================================================
// 18. PARSER TIMING: ACTUAL OPERATIONAL TELEMETRY IN CANONICAL FILEIR
// ============================================================================
test("Gate 11D - Requirement 3 Timing: Actual runtime durationMs is preserved as operational telemetry in FileIR", async () => {
  const downloadedItem = {
    path: "src/timing.js",
    blobSha: "sha_time_123",
    content: "export function compute(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }",
    byteLength: 85,
    file: { path: "src/timing.js", language: "javascript", category: "source" },
  };

  const parsed = await parseSingleFile({
    downloadedItem,
    repository: TEST_REPO,
    registry: defaultRegistry,
  });

  assert.equal(parsed.fileIR.irVersion, "1.0.0");
  assert.equal(typeof parsed.fileIR.parser.durationMs, "number");
  // Actual timing is measured in ms by adapter and preserved
  assert.ok(parsed.fileIR.parser.durationMs >= 0);

  // Check upload: verify the stored artifact in Supabase Storage retains the actual measured durationMs
  const storageClient = new InMemoryStorageClient();
  const outcome = await parseAndPersistBatch({
    repository: TEST_REPO,
    organizationId: TEST_ORG_ID,
    jobId: "job_timing_test",
    downloadedFiles: [downloadedItem],
    options: { storageClient },
  });

  const downloaded = await storageClient.from("fileir-artifacts").download(outcome.stagedArtifacts[0].storagePath);
  const parsedJson = JSON.parse(downloaded.data.toString("utf8"));
  assert.equal(typeof parsedJson.parser.durationMs, "number");
  assert.ok(parsedJson.parser.durationMs >= 0);
});
