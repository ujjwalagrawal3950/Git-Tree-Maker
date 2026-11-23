/**
 * Cartograph Gate 11B Acceptance Test Suite: IngestionJobManager & Bounded Downloader.
 *
 * Verifies all 10 mandatory Gate 11B test requirements:
 * 1. Two workers cannot claim the same job.
 * 2. A stale worker cannot commit after losing its fencing token.
 * 3. Expired jobs can be reclaimed safely.
 * 4. Concurrent downloading respects the configured maximum.
 * 5. Aggregate and per-file byte limits are enforced.
 * 6. Git blob SHA verification works.
 * 7. Failed downloads do not corrupt successful file records.
 * 8. Retrying a failed download is idempotent.
 * 9. Cancellation stops scheduling new downloads.
 * 10. Previously committed batches are preserved during recovery.
 *
 * Mode: Deterministic in-memory transaction and concurrency engine (clearly labeled).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { IngestionJobManager } = require("../services/ingestion/IngestionJobManager");
const {
  verifyGitBlobSha,
  downloadBatchFiles,
} = require("../services/ingestion/BatchDownloader");
const github = require("../services/github");

// Helper to create a valid Git blob payload matching SHA-1
function createBlobPayload(text) {
  const buf = Buffer.from(text, "utf-8");
  const hash = crypto.createHash("sha1");
  hash.update(`blob ${buf.length}\0`);
  hash.update(buf);
  const sha = hash.digest("hex");
  return {
    sha,
    content: buf.toString("base64"),
    encoding: "base64",
    size: buf.length,
  };
}

test("Gate 11B Test 1: Two workers cannot claim the same job (SKIP LOCKED concurrency)", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();

  // Create single queued job
  const job = await manager.createJob({
    repositoryId: "owner/repo1",
    organizationId: "org_1",
    commitSha: "sha_001",
    mode: "small",
  });
  assert.equal(job.status, "queued");

  // Worker 1 claims job
  const claim1 = await manager.claimNextJob("worker_1");
  assert.ok(claim1, "Worker 1 must claim the job");
  assert.equal(claim1.id, job.id);
  assert.equal(claim1.claimed_by, "worker_1");
  assert.equal(claim1.fencing_token, 2);

  // Worker 2 attempts claim while job is active
  const claim2 = await manager.claimNextJob("worker_2");
  assert.equal(claim2, null, "Worker 2 must receive null (no available queued jobs)");
});

test("Gate 11B Test 2: A stale worker cannot commit or heartbeat after losing its fencing token", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();

  const job = await manager.createJob({
    repositoryId: "owner/repo2",
    organizationId: "org_1",
    commitSha: "sha_002",
  });

  // Worker 1 claims job (fencing_token = 2)
  const worker1Claim = await manager.claimNextJob("worker_1");
  assert.equal(worker1Claim.fencing_token, 2);

  // Simulate lease timeout on Worker 1
  const rawJob = manager.memoryJobs.get(job.id);
  rawJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  // Worker 2 reclaims the expired job (fencing_token increments to 3)
  const worker2Claim = await manager.claimNextJob("worker_2");
  assert.ok(worker2Claim);
  assert.equal(worker2Claim.fencing_token, 3);
  assert.equal(worker2Claim.claimed_by, "worker_2");

  // Worker 1 wakes up and attempts a heartbeat with stale fencing token (2)
  const heartbeatResult = await manager.heartbeat(job.id, "worker_1", 2);
  assert.equal(heartbeatResult.renewed, false, "Heartbeat must be rejected");
  assert.equal(heartbeatResult.status, "stale_fencing_token");

  // Worker 1 attempts to download/commit a batch with stale token
  await assert.rejects(
    async () => {
      await manager.downloadBatch({
        jobId: job.id,
        workerId: "worker_1",
        fencingToken: 2,
        batchFiles: [{ id: "f1", path: "src/index.js", blobSha: "abc" }],
      });
    },
    { code: "STALE_FENCING_TOKEN" }
  );
});

test("Gate 11B Test 3: Expired jobs can be reclaimed safely and max reclaims limit fails toxic jobs", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();

  const job = await manager.createJob({
    repositoryId: "owner/repo3",
    organizationId: "org_1",
    commitSha: "sha_003",
  });

  // Claim job and expire lease
  await manager.claimNextJob("worker_1");
  const rawJob = manager.memoryJobs.get(job.id);
  rawJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  rawJob.reclaim_count = 0;

  // Reconcile sweeps expired job (reclaim_count < 3)
  const sweep1 = await manager.reconcileDanglingJobs();
  assert.equal(sweep1.requeuedCount, 1);
  assert.equal(rawJob.status, "queued");
  assert.equal(rawJob.reclaim_count, 1);
  assert.equal(rawJob.claimed_by, null);

  // Simulate reaching max reclaims (reclaim_count = 3) and expiring again
  rawJob.status = "downloading_batch";
  rawJob.reclaim_count = 3;
  rawJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  const sweep2 = await manager.reconcileDanglingJobs();
  assert.equal(sweep2.failedCount, 1);
  assert.equal(rawJob.status, "failed");
  assert.equal(rawJob.termination_reason, "lease_reclaim_limit_exceeded");
});

test("Gate 11B Test 4: Concurrent downloading respects the configured maximum pool concurrency", async () => {
  let activeConcurrency = 0;
  let maxObservedConcurrency = 0;

  const payloads = new Map();
  const files = [];
  for (let i = 0; i < 15; i++) {
    const payload = createBlobPayload(`File content ${i}`);
    payloads.set(payload.sha, payload);
    files.push({
      id: `f_${i}`,
      path: `src/file_${i}.js`,
      blobSha: payload.sha,
      sizeBytes: payload.size,
      priorityRank: 2,
    });
  }

  const originalFetch = github.fetchGitBlob;
  github.fetchGitBlob = async (_owner, _repo, blobSha) => {
    activeConcurrency++;
    if (activeConcurrency > maxObservedConcurrency) {
      maxObservedConcurrency = activeConcurrency;
    }
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeConcurrency--;
    return payloads.get(blobSha);
  };

  try {
    const configuredConcurrency = 3;
    const result = await downloadBatchFiles({
      owner: "owner",
      repo: "repo",
      files,
      options: {
        concurrency: configuredConcurrency,
      },
    });

    assert.equal(result.downloaded.length, 15);
    assert.ok(
      maxObservedConcurrency <= configuredConcurrency,
      `Observed concurrency ${maxObservedConcurrency} must not exceed configured limit ${configuredConcurrency}`
    );
  } finally {
    github.fetchGitBlob = originalFetch;
  }
});

test("Gate 11B Test 5: Aggregate and per-file byte limits are enforced", async () => {
  const p1 = createBlobPayload("Small file 1 content");
  const p2 = createBlobPayload("Small file 2 content");
  const payloads = new Map([
    [p1.sha, p1],
    [p2.sha, p2],
  ]);

  const originalFetch = github.fetchGitBlob;
  github.fetchGitBlob = async (_owner, _repo, blobSha) => {
    return payloads.get(blobSha);
  };

  try {
    const files = [
      {
        id: "f_oversized",
        path: "huge.bin",
        blobSha: "sha_huge",
        sizeBytes: 2000000, // 2 MB (exceeds 1 MB cap)
        priorityRank: 4,
      },
      {
        id: "f_ok1",
        path: "src/small1.js",
        blobSha: p1.sha,
        sizeBytes: p1.size,
        priorityRank: 1,
      },
      {
        id: "f_ok2",
        path: "src/small2.js",
        blobSha: p2.sha,
        sizeBytes: p2.size,
        priorityRank: 1,
      },
    ];

    // Download with 1 MB per-file cap and 25 byte aggregate batch limit (only allows 1 file)
    const result = await downloadBatchFiles({
      owner: "owner",
      repo: "repo",
      files,
      options: {
        maxFileSizeBytes: 1000000,
        maxBatchBytes: 25,
      },
    });

    assert.equal(result.downloaded.length, 1);
    assert.equal(result.skipped.length, 2);

    const oversizedSkip = result.skipped.find((s) => s.path === "huge.bin");
    assert.ok(oversizedSkip);
    assert.equal(oversizedSkip.reason, "oversized");

    const budgetSkip = result.skipped.find((s) => s.reason === "batch_budget_exceeded");
    assert.ok(budgetSkip);
  } finally {
    github.fetchGitBlob = originalFetch;
  }
});

test("Gate 11B Test 6: Git blob SHA verification works (rejects corrupted payloads)", async () => {
  const validPayload = createBlobPayload("Verified Content");
  const validBuffer = Buffer.from("Verified Content", "utf-8");

  // Verify valid Git blob SHA-1
  const matches = verifyGitBlobSha(validBuffer, validPayload.sha);
  assert.equal(matches, true, "Valid buffer must match Git blob SHA");

  // Verify tampered content fails SHA verification
  const tamperedBuffer = Buffer.from("Tampered Content", "utf-8");
  const tamperedMatches = verifyGitBlobSha(tamperedBuffer, validPayload.sha);
  assert.equal(tamperedMatches, false, "Tampered buffer must fail SHA verification");
});

test("Gate 11B Test 7: Failed downloads do not corrupt successful file records", async () => {
  const originalFetch = github.fetchGitBlob;
  const goodPayload = createBlobPayload("Good file content");

  github.fetchGitBlob = async (_owner, _repo, blobSha) => {
    if (blobSha === "bad_sha") {
      const err = new Error("Not Found on GitHub");
      err.status = 404;
      err.code = "NOT_FOUND";
      throw err;
    }
    return goodPayload;
  };

  try {
    const manager = new IngestionJobManager({ useMemoryStore: true });
    manager.clearMemoryStore();

    const job = await manager.createJob({
      repositoryId: "owner/repo7",
      organizationId: "org_1",
      commitSha: "sha_007",
    });

    const claim = await manager.claimNextJob("worker_1");
    assert.ok(claim);

    await manager.populateJobFiles(job.id, [
      { path: "src/good.js", blobSha: goodPayload.sha, sizeBytes: 50, priorityRank: 1 },
      { path: "src/bad.js", blobSha: "bad_sha", sizeBytes: 50, priorityRank: 2 },
    ]);

    const batch = await manager.getNextPendingBatch(job.id, 10);

    const result = await manager.downloadBatch({
      jobId: job.id,
      workerId: "worker_1",
      fencingToken: claim.fencing_token,
      batchFiles: batch,
    });

    assert.equal(result.downloaded.length, 1);
    assert.equal(result.failed.length, 1);

    const filesMap = manager.memoryFiles.get(job.id);
    const goodFile = filesMap.get("src/good.js");
    const badFile = filesMap.get("src/bad.js");

    assert.equal(goodFile.status, "downloaded");
    assert.equal(badFile.status, "failed");
    assert.equal(badFile.error_code, "NOT_FOUND");
  } finally {
    github.fetchGitBlob = originalFetch;
  }
});

test("Gate 11B Test 8: Retrying a failed download is idempotent", async () => {
  let attempt = 0;
  const originalFetch = github.fetchGitBlob;
  const payload = createBlobPayload("Retried Content");

  github.fetchGitBlob = async () => {
    attempt++;
    if (attempt === 1) {
      const err = new Error("GitHub 503 Unavailable");
      err.status = 503;
      err.code = "GITHUB_UNAVAILABLE";
      throw err;
    }
    return payload;
  };

  try {
    const result = await downloadBatchFiles({
      owner: "owner",
      repo: "repo",
      files: [
        {
          id: "f_retry",
          path: "src/retry.js",
          blobSha: payload.sha,
          sizeBytes: 50,
          priorityRank: 1,
        },
      ],
      options: {
        maxRetries: 1,
      },
    });

    assert.equal(result.downloaded.length, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(attempt, 2, "Must retry once on 503 transient error");
  } finally {
    github.fetchGitBlob = originalFetch;
  }
});

test("Gate 11B Test 9: Cancellation stops scheduling new downloads", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();

  const job = await manager.createJob({
    repositoryId: "owner/repo9",
    organizationId: "org_1",
    commitSha: "sha_009",
  });

  const claim = await manager.claimNextJob("worker_1");
  assert.ok(claim);

  const originalFetch = github.fetchGitBlob;
  github.fetchGitBlob = async (_owner, _repo, blobSha) => {
    return createBlobPayload(`Content for ${blobSha}`);
  };

  try {
    // Request cancellation
    await manager.requestCancellation(job.id, "org_1");
    const cancelledJob = manager.memoryJobs.get(job.id);
    assert.equal(cancelledJob.status, "cancel_requested");

    const batch = [
      { id: "f1", path: "file1.js", blobSha: "sha1", sizeBytes: 10, priorityRank: 1 },
      { id: "f2", path: "file2.js", blobSha: "sha2", sizeBytes: 10, priorityRank: 1 },
    ];

    const result = await manager.downloadBatch({
      jobId: job.id,
      workerId: "worker_1",
      fencingToken: claim.fencing_token,
      batchFiles: batch,
    });

    assert.equal(result.isCancelled, true);
    assert.equal(result.downloaded.length, 0);
    assert.equal(result.skipped.length, 2);
    assert.equal(result.skipped[0].reason, "cancelled");
  } finally {
    github.fetchGitBlob = originalFetch;
  }
});

test("Gate 11B Test 10: Previously committed batches are preserved during recovery", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();

  const job = await manager.createJob({
    repositoryId: "owner/repo10",
    organizationId: "org_1",
    commitSha: "sha_010",
  });

  // Populate files across Batch 1 and Batch 2
  await manager.populateJobFiles(job.id, [
    { path: "src/b1_file1.js", blobSha: "sha_b1_1", sizeBytes: 50, priorityRank: 1 },
    { path: "src/b1_file2.js", blobSha: "sha_b1_2", sizeBytes: 50, priorityRank: 1 },
    { path: "src/b2_file1.js", blobSha: "sha_b2_1", sizeBytes: 50, priorityRank: 2 },
  ]);

  const rawJob = manager.memoryJobs.get(job.id);
  const filesMap = manager.memoryFiles.get(job.id);

  // Mark Batch 1 as durably committed
  rawJob.last_committed_batch = 1;
  filesMap.get("src/b1_file1.js").status = "parsed";
  filesMap.get("src/b1_file1.js").batch_number = 1;
  filesMap.get("src/b1_file2.js").status = "parsed";
  filesMap.get("src/b1_file2.js").batch_number = 1;

  // Simulate Batch 2 interrupted mid-download
  filesMap.get("src/b2_file1.js").status = "downloaded";
  filesMap.get("src/b2_file1.js").batch_number = 2;

  // Expire lease
  rawJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  // Run reconciliation sweep
  const sweep = await manager.reconcileDanglingJobs();
  assert.equal(sweep.requeuedCount, 1);

  // Verify: Batch 1 files are strictly preserved as 'parsed'
  assert.equal(filesMap.get("src/b1_file1.js").status, "parsed");
  assert.equal(filesMap.get("src/b1_file1.js").batch_number, 1);
  assert.equal(filesMap.get("src/b1_file2.js").status, "parsed");
  assert.equal(filesMap.get("src/b1_file2.js").batch_number, 1);

  // Verify: Uncommitted Batch 2 file was safely reset to 'pending'
  assert.equal(filesMap.get("src/b2_file1.js").status, "pending");
  assert.equal(filesMap.get("src/b2_file1.js").batch_number, null);
});

test("Gate 11B Test 11: Budget reservation is released after a file fails or is rejected", async () => {
  const p1 = createBlobPayload("File 1 content");
  const p2 = createBlobPayload("File 2 content");

  let p1Attempted = false;
  const originalFetch = github.fetchGitBlob;
  github.fetchGitBlob = async (_owner, _repo, blobSha) => {
    if (blobSha === "failing_sha") {
      p1Attempted = true;
      const err = new Error("GitHub Network 500");
      err.status = 500;
      throw err;
    }
    return p2;
  };

  try {
    const files = [
      {
        id: "f_fail",
        path: "src/fail.js",
        blobSha: "failing_sha",
        sizeBytes: 20, // Reserves 20 bytes
        priorityRank: 1,
      },
      {
        id: "f_ok",
        path: "src/ok.js",
        blobSha: p2.sha,
        sizeBytes: 20,
        priorityRank: 2,
      },
    ];

    // Batch limit is 25 bytes.
    // If f_fail didn't release its 20-byte reservation upon failing, f_ok (20 bytes) would be skipped with budget_exceeded.
    // With reservation release, f_fail releases its 20 bytes and f_ok succeeds!
    const result = await downloadBatchFiles({
      owner: "owner",
      repo: "repo",
      files,
      options: {
        concurrency: 1, // Sequential execution to verify reservation release
        maxFileSizeBytes: 1000000,
        maxBatchBytes: 25,
      },
    });

    assert.equal(p1Attempted, true);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, "src/fail.js");
    assert.equal(result.downloaded.length, 1);
    assert.equal(result.downloaded[0].path, "src/ok.js");
    assert.equal(result.skipped.length, 0);
  } finally {
    github.fetchGitBlob = originalFetch;
  }
});

test("Gate 11B Test 12: Migration 002 schema integrity, table constraints, RLS and indexes", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const migrationSql = fs.readFileSync(
    path.resolve(__dirname, "..", "migrations", "002_phase11_ingestion_jobs.sql"),
    "utf8"
  );

  // Table existence
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.ingestion_jobs/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.ingestion_job_files/i);

  // Foreign keys
  assert.match(migrationSql, /REFERENCES public\.organizations\(id\)\s+ON DELETE CASCADE/i);
  assert.match(migrationSql, /REFERENCES public\.ingestion_jobs\(id\)\s+ON DELETE CASCADE/i);

  // Constraints: unique index and path uniqueness
  assert.match(migrationSql, /CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_active_unique_idx/i);
  assert.match(migrationSql, /CONSTRAINT uq_ingestion_job_files_job_path UNIQUE \(job_id, path\)/i);
  assert.doesNotMatch(migrationSql, /PRIMARY KEY \(job_id, path\)/i, "Must not have duplicate primary key");

  // RLS enabled
  assert.match(migrationSql, /ALTER TABLE public\.ingestion_jobs ENABLE ROW LEVEL SECURITY/i);
  assert.match(migrationSql, /ALTER TABLE public\.ingestion_job_files ENABLE ROW LEVEL SECURITY/i);

  // Claim index
  assert.match(migrationSql, /CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_idx/i);
});
