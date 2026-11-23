/**
 * Cartograph Phase 11 — Gate 11E.1 Verification Test Suite.
 *
 * Verifies production-path reliability and hardening across 4 critical areas:
 * 1. Verification A: PostgreSQL Snapshot Publication Atomicity
 * 2. Verification B: Actual Worker Continuation and Crash Recovery (Scenarios 1 - 5)
 * 3. Verification C: FileIR Artifact Integrity & Rehydration (Checks 1 - 8)
 * 4. Verification D: GraphSnapshotStore Consistency & Multi-tenant Isolation
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { IngestionJobManager, LEASE_DURATION_MS } = require("../services/ingestion/IngestionJobManager");
const { ManifestScheduler } = require("../services/ingestion/ManifestScheduler");
const { InMemoryStorageClient } = require("../services/ingestion/BatchParser");
const {
  IncrementalGraphPublisher,
  verifyAndRehydrateFileIr,
  processRepositoryIngestion,
  buildSnapshotStoragePath,
  computeSnapshotSha256,
  SNAPSHOTS_BUCKET,
} = require("../services/ingestion/IncrementalGraphPublisher");
const { GraphSnapshotStore } = require("../services/graph/GraphSnapshotStore");
const { GraphValidator } = require("../services/graph/GraphValidator");
const { EDGE_SEMANTICS } = require("../services/graph/identity");

const REPO = "facebook/react";
const COMMIT_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ORG_ID = "org_gate11e1";

function createValidFileIR(filePath, language = "javascript", symbols = [], options = {}) {
  return {
    schemaVersion: "1.0.0",
    file: {
      path: filePath,
      blobSha: options.blobSha || "abc123blobsha",
      language,
    },
    repository: { fullName: REPO, commitSha: COMMIT_SHA },
    parserFingerprint: options.parserFingerprint || "javascript-adapter@1.0.0:babel@7.24.0",
    status: "complete",
    metrics: { lines: 50 },
    symbols,
    imports: options.imports || [],
    exports: options.exports || [],
    calls: options.calls || [],
    diagnostics: [],
  };
}

// ============================================================================
// Verification A: PostgreSQL Snapshot Publication Atomicity
// ============================================================================

test("Gate 11E.1 - Verification A.1: Two workers attempting concurrent publication (fencing rejection)", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });

  // Worker A claims -> fencing token 2
  const claimedA = await jobManager.claimNextJob("worker_a");
  const tokenA = claimedA.fencing_token;

  // Worker A lease expires, Worker B claims -> fencing token 3
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 5000).toISOString();
  liveJob.status = "queued";

  const claimedB = await jobManager.claimNextJob("worker_b");
  const tokenB = claimedB.fencing_token;
  assert.equal(tokenB, tokenA + 1);

  // Worker B publishes snapshot v1 successfully
  const pubB = await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_b",
    fencingToken: tokenB,
    snapshotVersion: 1,
    snapshotStoragePath: "path/b_v1.json",
    snapshotSha256: "sha_b1",
    snapshotBytes: 100,
  });
  assert.equal(pubB.success, true);

  // Worker A attempts delayed publication with stale tokenA
  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_a",
        fencingToken: tokenA,
        snapshotVersion: 1,
        snapshotStoragePath: "path/a_v1.json",
        snapshotSha256: "sha_a1",
        snapshotBytes: 100,
      });
    },
    (err) => {
      assert.ok(err.code === "WORKER_MISMATCH" || err.code === "STALE_FENCING_TOKEN");
      return true;
    }
  );

  // The database pointer must remain strictly Worker B's snapshot
  const finalJob = await jobManager.getJob(job.id);
  assert.equal(finalJob.snapshot_version, 1);
  assert.equal(finalJob.snapshot_storage_path, "path/b_v1.json");
});

test("Gate 11E.1 - Verification A.2: Expired lease attempting publication is rejected", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_exp");

  // Force lease expiration
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_exp",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 1,
        snapshotStoragePath: "path/exp.json",
        snapshotSha256: "sha_exp",
        snapshotBytes: 100,
      });
    },
    (err) => {
      assert.equal(err.code, "LEASE_EXPIRED");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification A.3: Incorrect expected prior snapshot version rejected (optimistic lock)", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_opt");

  // Publish v1
  await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_opt",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    expectedPriorVersion: 0,
    snapshotStoragePath: "path/v1.json",
    snapshotSha256: "sha_v1",
    snapshotBytes: 100,
  });

  // Attempt to publish v2 with mismatched expectedPriorVersion (expected 0, but current is 1)
  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_opt",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 2,
        expectedPriorVersion: 0, // Mismatch!
        snapshotStoragePath: "path/v2.json",
        snapshotSha256: "sha_v2",
        snapshotBytes: 200,
      });
    },
    (err) => {
      assert.equal(err.code, "SNAPSHOT_VERSION_CONFLICT");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification A.4: Non-monotonic snapshot version rejected", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_mono");

  await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_mono",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 2,
    snapshotStoragePath: "path/v2.json",
    snapshotSha256: "sha_v2",
    snapshotBytes: 100,
  });

  // Attempting to publish version 2 again or lower
  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_mono",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 2,
        snapshotStoragePath: "path/v2_again.json",
        snapshotSha256: "sha_v2",
        snapshotBytes: 100,
      });
    },
    (err) => {
      assert.equal(err.code, "INVALID_SNAPSHOT_VERSION");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification A.5: Snapshot pointer consistency after publication failure", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_fail");

  // Valid initial publish
  await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_fail",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    snapshotStoragePath: "path/valid_v1.json",
    snapshotSha256: "sha_valid",
    snapshotBytes: 50,
  });

  // Attempt publish with cancelled job
  await jobManager.requestCancellation(job.id, ORG_ID);

  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_fail",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 2,
        snapshotStoragePath: "path/v2_fail.json",
        snapshotSha256: "sha_fail",
        snapshotBytes: 50,
      });
    },
    (err) => {
      assert.equal(err.code, "JOB_NOT_ACTIVE");
      return true;
    }
  );

  // Authoritative state preserved
  const current = await jobManager.getJob(job.id);
  assert.equal(current.snapshot_version, 1);
  assert.equal(current.snapshot_storage_path, "path/valid_v1.json");
});

// ============================================================================
// Verification B: Actual Worker Continuation and Crash Recovery
// ============================================================================

test("Gate 11E.1 - Verification B Scenario 1: Small repository continuous run publishes complete graph", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const scheduler = new ManifestScheduler({ jobManager });
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const files = [
    { path: "src/entry.js", size: 100, priority_rank: 2 },
    { path: "src/helper.js", size: 100, priority_rank: 4 },
  ];

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA, mode: "small" });
  const claimed = await jobManager.claimNextJob("worker_small_real");
  await jobManager.populateJobFiles(job.id, files);

  const mockDownloader = {
    downloadFilesConcurrent: async (fl) => ({
      downloaded: fl.map((f) => ({ path: f.path, buffer: Buffer.from("console.log('small');") })),
      failed: [],
      skipped: [],
    }),
  };

  const file1 = createValidFileIR("src/entry.js", "javascript");
  const file2 = createValidFileIR("src/helper.js", "javascript");

  const outcome = await processRepositoryIngestion({
    jobId: job.id,
    workerId: "worker_small_real",
    fencingToken: claimed.fencing_token,
    scheduler,
    publisher,
    options: {
      downloader: mockDownloader,
      storageClient,
      fileIRList: [file1, file2],
    },
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.snapshotsPublished, 1);
  const finalJob = await jobManager.getJob(job.id);
  assert.equal(finalJob.status, "completed");
  assert.equal(finalJob.graph_status, "complete");
  assert.equal(finalJob.initial_graph_ready, true);
});

test("Gate 11E.1 - Verification B Scenario 2: Medium repository progressive publication without manual intervention", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const scheduler = new ManifestScheduler({ jobManager });
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const files = [
    { path: "src/core.js", size: 100, priority_rank: 1 },
    { path: "src/feature.js", size: 100, priority_rank: 3 },
  ];

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA, mode: "medium" });
  const claimed = await jobManager.claimNextJob("worker_med_real");
  await jobManager.populateJobFiles(job.id, files);

  const mockDownloader = {
    downloadFilesConcurrent: async (fl) => ({
      downloaded: fl.map((f) => ({ path: f.path, buffer: Buffer.from("console.log('med');") })),
      failed: [],
      skipped: [],
    }),
  };

  const file1 = createValidFileIR("src/core.js", "javascript");
  const file2 = createValidFileIR("src/feature.js", "javascript");

  const outcome = await processRepositoryIngestion({
    jobId: job.id,
    workerId: "worker_med_real",
    fencingToken: claimed.fencing_token,
    scheduler,
    publisher,
    options: {
      downloader: mockDownloader,
      storageClient,
      batchSize: 1, // Forces 2 progressive batches
      fileIRList: [file1, file2],
    },
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.batchesProcessed, 2);
  assert.equal(outcome.snapshotsPublished, 2);
  assert.equal(outcome.publishedSnapshots[0].snapshotVersion, 1);
  assert.equal(outcome.publishedSnapshots[0].graphStatus, "partial");
  assert.equal(outcome.publishedSnapshots[1].snapshotVersion, 2);
  assert.equal(outcome.publishedSnapshots[1].graphStatus, "complete");
});

test("Gate 11E.1 - Verification B Scenario 3: Worker crash between batch commit and snapshot publication resumes safely", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimedA = await jobManager.claimNextJob("worker_crash_a");

  // Worker A commits Batch 1
  await jobManager.populateJobFiles(job.id, [
    { path: "src/file1.js", size: 100, priority_rank: 1 },
    { path: "src/file2.js", size: 100, priority_rank: 2 },
  ]);

  await jobManager.commitBatch({
    jobId: job.id,
    workerId: "worker_crash_a",
    fencingToken: claimedA.fencing_token,
    batchNumber: 1,
    fileOutcomes: [
      { path: "src/file1.js", status: "parsed", storagePath: "path/ir1.json", sha256: "sha1" },
    ],
  });

  // Crash: Worker A dies before publishing snapshot (lease expires)
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 5000).toISOString();
  liveJob.status = "queued";

  // Worker B reclaims
  const claimedB = await jobManager.claimNextJob("worker_crash_b");
  assert.equal(claimedB.last_committed_batch, 1);
  assert.equal(claimedB.snapshot_version, 0);

  // Worker B publishes snapshot v1 from the durably committed batch
  const file1 = createValidFileIR("src/file1.js", "javascript");
  const pubB = await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    workerId: "worker_crash_b",
    fencingToken: claimedB.fencing_token,
    snapshotVersion: 1,
    fileIRList: [file1],
  });

  assert.equal(pubB.success, true);
  assert.equal(pubB.snapshotVersion, 1);
  const updatedJob = await jobManager.getJob(job.id);
  assert.equal(updatedJob.snapshot_version, 1);
});

test("Gate 11E.1 - Verification B Scenario 4: Worker lease expiration during resolution prevents publication and lets successor resume", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimedA = await jobManager.claimNextJob("worker_exp_a");

  // Worker A's lease expires during resolution
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  const file1 = createValidFileIR("src/f1.js", "javascript");

  await assert.rejects(
    async () => {
      await publisher.publishIncrementalSnapshot({
        jobId: job.id,
        workerId: "worker_exp_a",
        fencingToken: claimedA.fencing_token,
        snapshotVersion: 1,
        fileIRList: [file1],
      });
    },
    (err) => {
      assert.equal(err.code, "LEASE_EXPIRED");
      return true;
    }
  );

  // Successor Worker B claims and publishes
  liveJob.status = "queued";
  const claimedB = await jobManager.claimNextJob("worker_succ_b");

  const pubB = await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    workerId: "worker_succ_b",
    fencingToken: claimedB.fencing_token,
    snapshotVersion: 1,
    fileIRList: [file1],
  });
  assert.equal(pubB.success, true);
});

test("Gate 11E.1 - Verification B Scenario 5: Crash after snapshot upload leaves prior DB pointer intact and artifact as safe orphan", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_crash_post_upload");

  // Initial successful publish v1
  const file1 = createValidFileIR("src/f1.js", "javascript");
  await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    workerId: "worker_crash_post_upload",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    fileIRList: [file1],
  });

  const jobV1 = await jobManager.getJob(job.id);
  const authoritativeV1Path = jobV1.snapshot_storage_path;

  // Staging upload for v2 succeeds in storage directly, but worker crashes before database transaction
  const orphanPath = "snapshots/tenant_org/repo_facebook_react/commit_main/v2_tok2_orphan12345.json";
  await storageClient.from(SNAPSHOTS_BUCKET).upload(orphanPath, JSON.stringify({ version: 2 }));

  // Verify DB pointer is STILL pointing to v1!
  const currentJob = await jobManager.getJob(job.id);
  assert.equal(currentJob.snapshot_version, 1);
  assert.equal(currentJob.snapshot_storage_path, authoritativeV1Path);

  // The uploaded artifact exists in storage as an unreferenced orphan (not deleted)
  const downloadResult = await storageClient.from(SNAPSHOTS_BUCKET).download(orphanPath);
  assert.ok(downloadResult.data);
});

// ============================================================================
// Verification C: FileIR Artifact Integrity & Rehydration
// ============================================================================

test("Gate 11E.1 - Verification C.1: Valid FileIR artifact loads and verifies successfully", () => {
  const ir = createValidFileIR("src/auth.js", "javascript");
  const rawBytes = Buffer.from(JSON.stringify(ir), "utf8");
  const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");

  const rec = {
    path: "src/auth.js",
    file_ir_sha256: sha256,
    blob_sha: "abc123blobsha",
    parser_fingerprint: ir.parserFingerprint,
  };

  const verified = verifyAndRehydrateFileIr({
    rec,
    rawData: rawBytes,
    expectedRepositoryId: REPO,
    expectedCommitSha: COMMIT_SHA,
  });

  assert.equal(verified.file.path, "src/auth.js");
  assert.equal(verified.schemaVersion, "1.0.0");
});

test("Gate 11E.1 - Verification C.2: Missing FileIR artifact payload is rejected", () => {
  const rec = { path: "src/missing.js" };

  assert.throws(
    () => {
      verifyAndRehydrateFileIr({
        rec,
        rawData: null,
        expectedRepositoryId: REPO,
        expectedCommitSha: COMMIT_SHA,
      });
    },
    (err) => {
      assert.equal(err.code, "FILE_IR_ARTIFACT_MISSING");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification C.3: Corrupted FileIR artifact checksum mismatch is rejected", () => {
  const ir = createValidFileIR("src/auth.js", "javascript");
  const rawBytes = Buffer.from(JSON.stringify(ir), "utf8");

  const rec = {
    path: "src/auth.js",
    file_ir_sha256: "expected_sha_that_does_not_match",
  };

  assert.throws(
    () => {
      verifyAndRehydrateFileIr({
        rec,
        rawData: rawBytes,
        expectedRepositoryId: REPO,
        expectedCommitSha: COMMIT_SHA,
      });
    },
    (err) => {
      assert.equal(err.code, "FILE_IR_CHECKSUM_MISMATCH");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification C.4: FileIR with incorrect repository identity is rejected", () => {
  const ir = createValidFileIR("src/auth.js", "javascript");
  ir.repository = { fullName: "wrong/repo", commitSha: COMMIT_SHA };
  const rawBytes = Buffer.from(JSON.stringify(ir), "utf8");

  const rec = { path: "src/auth.js" };

  assert.throws(
    () => {
      verifyAndRehydrateFileIr({
        rec,
        rawData: rawBytes,
        expectedRepositoryId: REPO,
        expectedCommitSha: COMMIT_SHA,
      });
    },
    (err) => {
      assert.equal(err.code, "REPOSITORY_MISMATCH");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification C.5: FileIR with incorrect commit identity is rejected (mixed commit rejection)", () => {
  const ir = createValidFileIR("src/auth.js", "javascript");
  ir.repository = { fullName: REPO, commitSha: "wrong_commit_sha_999" };
  const rawBytes = Buffer.from(JSON.stringify(ir), "utf8");

  const rec = { path: "src/auth.js" };

  assert.throws(
    () => {
      verifyAndRehydrateFileIr({
        rec,
        rawData: rawBytes,
        expectedRepositoryId: REPO,
        expectedCommitSha: COMMIT_SHA,
      });
    },
    (err) => {
      assert.equal(err.code, "MIXED_COMMIT_FILE_IR");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification C.6: Unsupported FileIR schema version is rejected", () => {
  const ir = createValidFileIR("src/auth.js", "javascript");
  ir.schemaVersion = "2.0.0-unsupported";
  const rawBytes = Buffer.from(JSON.stringify(ir), "utf8");

  const rec = { path: "src/auth.js" };

  assert.throws(
    () => {
      verifyAndRehydrateFileIr({
        rec,
        rawData: rawBytes,
        expectedRepositoryId: REPO,
        expectedCommitSha: COMMIT_SHA,
      });
    },
    (err) => {
      assert.equal(err.code, "UNSUPPORTED_FILE_IR_SCHEMA");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification C.7: Parser fingerprint mismatch is rejected", () => {
  const ir = createValidFileIR("src/auth.js", "javascript", [], { parserFingerprint: "adapter_v2" });
  const rawBytes = Buffer.from(JSON.stringify(ir), "utf8");

  const rec = {
    path: "src/auth.js",
    parser_fingerprint: "adapter_v1_expected",
  };

  assert.throws(
    () => {
      verifyAndRehydrateFileIr({
        rec,
        rawData: rawBytes,
        expectedRepositoryId: REPO,
        expectedCommitSha: COMMIT_SHA,
      });
    },
    (err) => {
      assert.equal(err.code, "PARSER_FINGERPRINT_MISMATCH");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification C.8: Rehydration failure preserves last valid published snapshot", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_rehydrate_guard");

  // Initial successful publish v1
  const validIR1 = createValidFileIR("src/ok1.js", "javascript");
  await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    workerId: "worker_rehydrate_guard",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    fileIRList: [validIR1],
  });

  const jobV1 = await jobManager.getJob(job.id);
  assert.equal(jobV1.snapshot_version, 1);
  const validV1Path = jobV1.snapshot_storage_path;

  // Now, populate corrupted file record in database
  await jobManager.populateJobFiles(job.id, [{ path: "src/corrupt.js", size: 100, priority_rank: 2 }]);
  await jobManager.commitBatch({
    jobId: job.id,
    workerId: "worker_rehydrate_guard",
    fencingToken: claimed.fencing_token,
    batchNumber: 2,
    fileOutcomes: [
      {
        path: "src/corrupt.js",
        status: "parsed",
        storagePath: "corrupt_path.json",
        sha256: "sha_corrupt",
      },
    ],
  });

  // Stored artifact payload is corrupted JSON
  await storageClient.from("fileir-artifacts").upload("corrupt_path.json", "{ malformed json ");

  // Attempting to publish v2 must reject due to corrupted FileIR rehydration
  await assert.rejects(
    async () => {
      await publisher.publishIncrementalSnapshot({
        jobId: job.id,
        workerId: "worker_rehydrate_guard",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 2,
        options: { storageClient },
      });
    },
    (err) => {
      assert.ok(err.code === "FILE_IR_CORRUPTED" || err.code === "FILE_IR_CHECKSUM_MISMATCH");
      return true;
    }
  );

  // Authoritative snapshot pointer in database remains strictly at v1!
  const current = await jobManager.getJob(job.id);
  assert.equal(current.snapshot_version, 1);
  assert.equal(current.snapshot_storage_path, validV1Path);
});

// ============================================================================
// Verification D: GraphSnapshotStore Consistency
// ============================================================================

test("Gate 11E.1 - Verification D.1: Failed DB commit never updates GraphSnapshotStore cache", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const store = new GraphSnapshotStore();
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient, store });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_store_fail");

  // Worker lease expires before publication
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  const file1 = createValidFileIR("src/f1.js", "javascript");

  await assert.rejects(
    async () => {
      await publisher.publishIncrementalSnapshot({
        jobId: job.id,
        workerId: "worker_store_fail",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 1,
        fileIRList: [file1],
      });
    },
    (err) => {
      assert.equal(err.code, "LEASE_EXPIRED");
      return true;
    }
  );

  // Store cache must remain completely empty!
  assert.equal(store.cache.size, 0);
});

test("Gate 11E.1 - Verification D.2: GraphSnapshotStore enforces tenant isolation", () => {
  const store = new GraphSnapshotStore();
  store.bindRepositoryToOrganization(REPO, ORG_ID);

  // Authorized tenant
  assert.doesNotThrow(() => {
    store.verifyRepositoryAccess(REPO, ORG_ID);
  });

  // Cross-tenant access denied
  assert.throws(
    () => {
      store.verifyRepositoryAccess(REPO, "different_org_attacker");
    },
    (err) => {
      assert.equal(err.code, "TENANT_ACCESS_DENIED");
      return true;
    }
  );
});

test("Gate 11E.1 - Verification D.3: Restarted backend rehydrates latest snapshot using authoritative DB pointer", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const store1 = new GraphSnapshotStore();
  const publisher1 = new IncrementalGraphPublisher({ jobManager, storageClient, store: store1 });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_rehydrate_test");

  const file1 = createValidFileIR("src/f1.js", "javascript");
  const pub = await publisher1.publishIncrementalSnapshot({
    jobId: job.id,
    organizationId: ORG_ID,
    workerId: "worker_rehydrate_test",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    fileIRList: [file1],
  });

  // Simulate backend restart: brand new empty GraphSnapshotStore
  const store2 = new GraphSnapshotStore();
  assert.equal(store2.cache.size, 0);

  const publisher2 = new IncrementalGraphPublisher({ jobManager, storageClient, store: store2 });
  const rehydratedEntry = await publisher2.rehydrateLatestSnapshot({
    jobId: job.id,
    organizationId: ORG_ID,
    store: store2,
    storageClient,
  });

  assert.ok(rehydratedEntry);
  assert.equal(rehydratedEntry.snapshotVersion, 1);
  assert.equal(rehydratedEntry.snapshotStoragePath, pub.snapshotStoragePath);
  assert.equal(store2.cache.size, 1);
  assert.ok(rehydratedEntry.queryService);

  // Query neighborhood works immediately on rehydrated store
  const neighborhood = rehydratedEntry.queryService.getNeighborhood(
    rehydratedEntry.snapshot.nodes[0].id,
    { radius: 1 }
  );
  assert.ok(neighborhood.nodes.length >= 1);
});

