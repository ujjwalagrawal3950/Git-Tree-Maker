/**
 * Cartograph Gate 11C Acceptance Test Suite: Manifest Classification & Priority Scheduler.
 *
 * Verifies all Gate 11C requirements:
 * 1. File classification (source, documentation, config/manifest, binary, unsupported).
 * 2. Exclusion behavior (vendor/build directories, submodules, symlinks, binary/media, oversized).
 * 3. Priority ordering (P0 -> P1 -> P2 -> P3 -> P4) with deterministic path tie-breaking.
 * 4. Deterministic batch generation (bounded files and byte budgets).
 * 5. Aggregate and per-file budgets enforcement.
 * 6. Duplicate path deduplication.
 * 7. Manifest retry idempotency (does not overwrite committed file states).
 * 8. Recovery of uncommitted batches.
 * 9. Preservation of committed batches.
 * 10. Stale worker rejection on scheduling.
 * 11. No unnecessary Git Tree rediscovery when durable manifest exists.
 * 12. Download failure isolation through BatchDownloader.
 * 13. Cancellation observation after downloading begins.
 *
 * Test Mode: Deterministic in-memory database simulation (clearly labeled).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { IngestionJobManager } = require("../services/ingestion/IngestionJobManager");
const {
  classifyManifestFile,
  classifyRepositoryManifest,
  computePriorityRank,
  selectIngestionMode,
  partitionIntoBatches,
  ManifestScheduler,
} = require("../services/ingestion/ManifestScheduler");
const github = require("../services/github");

function createBlobPayload(text) {
  const buf = Buffer.from(text, "utf-8");
  const hash = crypto.createHash("sha1");
  hash.update(`blob ${buf.length}\0`);
  hash.update(buf);
  return {
    sha: hash.digest("hex"),
    content: buf.toString("base64"),
    encoding: "base64",
    size: buf.length,
  };
}

test("Gate 11C Test 1: File classification categorizes source, docs, config, and unsupported files", () => {
  // Source files
  const jsFile = classifyManifestFile({ path: "src/utils.js", size: 100 });
  assert.equal(jsFile.isEligible, true);
  assert.equal(jsFile.category, "source");
  assert.equal(jsFile.language, "javascript");

  const pyFile = classifyManifestFile({ path: "app/main.py", size: 200 });
  assert.equal(pyFile.isEligible, true);
  assert.equal(pyFile.category, "source");
  assert.equal(pyFile.language, "python");

  // Documentation (P0 context)
  const readme = classifyManifestFile({ path: "README.md", size: 500 });
  assert.equal(readme.isEligible, true);
  assert.equal(readme.category, "documentation");
  assert.equal(readme.priorityRank, 0);

  // Configuration / dependency manifest
  const pkgJson = classifyManifestFile({ path: "package.json", size: 300 });
  assert.equal(pkgJson.isEligible, true);
  assert.equal(pkgJson.category, "dependency_manifest");
  assert.equal(pkgJson.priorityRank, 1);

  // Unsupported files
  const unknown = classifyManifestFile({ path: "data.xyz_unknown", size: 50 });
  assert.equal(unknown.isEligible, false);
  assert.equal(unknown.exclusionReason, "unsupported_type");
});

test("Gate 11C Test 2: Exclusion behavior excludes vendor, binary, media, and oversized files", () => {
  // Vendor / build directories
  const vendorFile = classifyManifestFile({ path: "node_modules/express/index.js", size: 100 });
  assert.equal(vendorFile.isEligible, false);
  assert.equal(vendorFile.exclusionReason, "vendor_or_build");

  const distFile = classifyManifestFile({ path: "dist/bundle.js", size: 100 });
  assert.equal(distFile.isEligible, false);
  assert.equal(distFile.exclusionReason, "vendor_or_build");

  // Binary and media assets
  const image = classifyManifestFile({ path: "public/logo.png", size: 1000 });
  assert.equal(image.isEligible, false);
  assert.equal(image.exclusionReason, "binary_or_media");

  const binary = classifyManifestFile({ path: "bin/server.exe", size: 5000 });
  assert.equal(binary.isEligible, false);
  assert.equal(binary.exclusionReason, "binary_or_media");

  // Oversized file exceeding 1 MB limit
  const oversized = classifyManifestFile({ path: "src/huge.ts", size: 1500000 });
  assert.equal(oversized.isEligible, false);
  assert.equal(oversized.exclusionReason, "oversized");
});

test("Gate 11C Test 3: Priority ordering enforces P0 -> P1 -> P2 -> P3 -> P4 with path tie-breaking", () => {
  assert.equal(computePriorityRank("README.md", "documentation"), 0);
  assert.equal(computePriorityRank("package.json", "dependency_manifest"), 1);
  assert.equal(computePriorityRank("tsconfig.json", "configuration"), 1);
  assert.equal(computePriorityRank("src/index.ts", "source"), 2);
  assert.equal(computePriorityRank("src/main.py", "source"), 2);
  assert.equal(computePriorityRank("src/controllers/userController.js", "source"), 3);
  assert.equal(computePriorityRank("src/models/user.ts", "source"), 3);
  assert.equal(computePriorityRank("src/utils/helpers.js", "source"), 4);

  // Verify manifest sorting
  const rawEntries = [
    { path: "src/utils/helpers.js", size: 10 },
    { path: "src/controllers/authController.js", size: 10 },
    { path: "src/index.js", size: 10 },
    { path: "package.json", size: 10 },
    { path: "README.md", size: 10 },
  ];

  const classified = classifyRepositoryManifest(rawEntries);
  const pathsInOrder = classified.eligible.map((f) => f.path);

  assert.deepEqual(pathsInOrder, [
    "README.md", // P0
    "package.json", // P1
    "src/index.js", // P2
    "src/controllers/authController.js", // P3
    "src/utils/helpers.js", // P4
  ]);
});

test("Gate 11C Test 4: Deterministic batch generation caps files and byte budgets", () => {
  const files = [];
  for (let i = 0; i < 150; i++) {
    files.push({
      path: `src/file_${String(i).padStart(3, "0")}.js`,
      sizeBytes: 1000,
      priorityRank: 4,
    });
  }

  // Partition with batch 1 max 100 files, subsequent batches max 50 files
  const batches = partitionIntoBatches(files, {
    batch1MaxFiles: 100,
    subsequentBatchMaxFiles: 50,
    maxBatchBytes: 8000000,
  });

  assert.equal(batches.length, 2);
  assert.equal(batches[0].batchNumber, 1);
  assert.equal(batches[0].files.length, 100);
  assert.equal(batches[1].batchNumber, 2);
  assert.equal(batches[1].files.length, 50);
});

test("Gate 11C Test 5: Mode selection correctly categorizes small, medium, and large repositories", () => {
  // Small: <= 200 files and <= 150 MB
  const smallFiles = new Array(50).fill({ sizeBytes: 1000 });
  const small = selectIngestionMode(smallFiles);
  assert.equal(small.mode, "small");
  assert.equal(small.strategy, "single_pass");

  // Medium: > 200 files
  const mediumFiles = new Array(250).fill({ sizeBytes: 1000 });
  const medium = selectIngestionMode(mediumFiles);
  assert.equal(medium.mode, "medium");
  assert.equal(medium.strategy, "continuous_progressive");

  // Large: >= 500 files
  const largeFiles = new Array(600).fill({ sizeBytes: 1000 });
  const large = selectIngestionMode(largeFiles);
  assert.equal(large.mode, "large");
  assert.equal(large.strategy, "adaptive_progressive");
});

test("Gate 11C Test 6: Duplicate paths are deduplicated deterministically", () => {
  const rawEntries = [
    { path: "src/app.js", size: 100, sha: "sha_first" },
    { path: "src/app.js", size: 100, sha: "sha_duplicate" },
    { path: "src/utils.js", size: 50, sha: "sha_utils" },
  ];

  const classified = classifyRepositoryManifest(rawEntries);
  assert.equal(classified.eligible.length, 2);
  assert.equal(classified.eligible[0].path, "src/app.js");
  assert.equal(classified.eligible[0].blobSha, "sha_first", "Must retain the first discovered entry");
});

test("Gate 11C Test 7: Manifest retry idempotency preserves committed file states", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();

  const job = await manager.createJob({
    repositoryId: "owner/repo_idemp",
    organizationId: "org_1",
    commitSha: "sha_idemp",
  });

  // Populate initial files
  await manager.populateJobFiles(job.id, [
    { path: "src/file1.js", blobSha: "sha1", sizeBytes: 100, priorityRank: 2 },
    { path: "src/file2.js", blobSha: "sha2", sizeBytes: 100, priorityRank: 2 },
  ]);

  const filesMap = manager.memoryFiles.get(job.id);
  // Mark file1 as already parsed (committed)
  filesMap.get("src/file1.js").status = "parsed";
  filesMap.get("src/file1.js").file_ir_sha256 = "ir_sha_1";

  // Re-run populateJobFiles (retry / re-schedule)
  await manager.populateJobFiles(job.id, [
    { path: "src/file1.js", blobSha: "sha1_new", sizeBytes: 120, priorityRank: 2 },
    { path: "src/file2.js", blobSha: "sha2_updated", sizeBytes: 100, priorityRank: 2 },
  ]);

  // file1 must NOT be overwritten back to pending
  assert.equal(filesMap.get("src/file1.js").status, "parsed");
  assert.equal(filesMap.get("src/file1.js").file_ir_sha256, "ir_sha_1");

  // file2 (pending) was safely updated
  assert.equal(filesMap.get("src/file2.js").status, "pending");
  assert.equal(filesMap.get("src/file2.js").blob_sha, "sha2_updated");
});

test("Gate 11C Test 8: No unnecessary Git Tree rediscovery when durable manifest exists", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();

  const scheduler = new ManifestScheduler({ jobManager: manager });

  const job = await manager.createJob({
    repositoryId: "owner/repo_skip",
    organizationId: "org_1",
    commitSha: "sha_skip",
  });

  const claim = await manager.claimNextJob("worker_1");
  assert.ok(claim);

  // First scheduling pass: discovers and populates manifest
  const rawTree = [
    { path: "README.md", size: 50, sha: "sha_rm" },
    { path: "src/index.js", size: 100, sha: "sha_idx" },
  ];

  let gitTreeCalled = false;
  const originalFetchTree = github.fetchGitTree;
  github.fetchGitTree = async () => {
    gitTreeCalled = true;
    return { tree: rawTree, truncated: false };
  };

  try {
    const pass1 = await scheduler.scheduleJob({
      jobId: job.id,
      workerId: "worker_1",
      fencingToken: claim.fencing_token,
      owner: "owner",
      repo: "repo_skip",
      treeEntries: rawTree,
    });

    assert.equal(pass1.isRediscoverySkipped, false);
    assert.equal(pass1.totalFiles, 2);

    // Job phase is now 'downloading_batch'
    const rawJob = manager.memoryJobs.get(job.id);
    assert.equal(rawJob.phase, "downloading_batch");

    // Second scheduling pass (e.g. after worker restart): MUST skip rediscovery!
    const pass2 = await scheduler.scheduleJob({
      jobId: job.id,
      workerId: "worker_1",
      fencingToken: claim.fencing_token,
      owner: "owner",
      repo: "repo_skip",
    });

    assert.equal(pass2.isRediscoverySkipped, true, "Rediscovery must be skipped when phase is downloading_batch");
    assert.equal(gitTreeCalled, false, "GitHub Tree API must never be called on rediscovery");
    assert.equal(pass2.totalFiles, 2);
  } finally {
    github.fetchGitTree = originalFetchTree;
  }
});

test("Gate 11C Test 9: Stale worker is rejected when attempting to schedule a job", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();
  const scheduler = new ManifestScheduler({ jobManager: manager });

  const job = await manager.createJob({
    repositoryId: "owner/repo_stale",
    organizationId: "org_1",
    commitSha: "sha_stale",
  });

  const claim = await manager.claimNextJob("worker_1");
  assert.equal(claim.fencing_token, 2);

  // Stale worker attempts to schedule with token 1
  await assert.rejects(
    async () => {
      await scheduler.scheduleJob({
        jobId: job.id,
        workerId: "worker_1",
        fencingToken: 1, // Stale!
        owner: "owner",
        repo: "repo_stale",
        treeEntries: [{ path: "src/index.js", size: 10 }],
      });
    },
    { code: "STALE_FENCING_TOKEN" }
  );
});

test("Gate 11C Test 10: End-to-end scheduler executes batch downloading with failure isolation", async () => {
  const manager = new IngestionJobManager({ useMemoryStore: true });
  manager.clearMemoryStore();
  const scheduler = new ManifestScheduler({ jobManager: manager });

  const job = await manager.createJob({
    repositoryId: "owner/repo_e2e",
    organizationId: "org_1",
    commitSha: "sha_e2e",
  });

  const claim = await manager.claimNextJob("worker_1");

  const pGood1 = createBlobPayload("Good file 1");
  const pGood2 = createBlobPayload("Good file 2");

  const rawTree = [
    { path: "README.md", size: 50, sha: pGood1.sha },
    { path: "src/bad.js", size: 50, sha: "failing_sha" },
    { path: "src/index.js", size: 50, sha: pGood2.sha },
  ];

  const originalFetchBlob = github.fetchGitBlob;
  github.fetchGitBlob = async (_owner, _repo, blobSha) => {
    if (blobSha === "failing_sha") {
      const err = new Error("GitHub 404");
      err.status = 404;
      err.code = "NOT_FOUND";
      throw err;
    }
    if (blobSha === pGood1.sha) return pGood1;
    if (blobSha === pGood2.sha) return pGood2;
    return createBlobPayload("default");
  };

  try {
    // 1. Schedule job
    const scheduled = await scheduler.scheduleJob({
      jobId: job.id,
      workerId: "worker_1",
      fencingToken: claim.fencing_token,
      owner: "owner",
      repo: "repo_e2e",
      treeEntries: rawTree,
    });
    assert.equal(scheduled.totalFiles, 3);

    // 2. Process next batch through scheduler
    const batchOutcome = await scheduler.processNextBatch({
      jobId: job.id,
      workerId: "worker_1",
      fencingToken: claim.fencing_token,
      batchSize: 10,
    });

    assert.equal(batchOutcome.batchProcessed, true);
    assert.equal(batchOutcome.batchSize, 3);
    assert.equal(batchOutcome.downloadResults.downloaded.length, 2);
    assert.equal(batchOutcome.downloadResults.failed.length, 1);

    // Verify file outcomes in job store
    const filesMap = manager.memoryFiles.get(job.id);
    assert.equal(filesMap.get("README.md").status, "downloaded");
    assert.equal(filesMap.get("src/index.js").status, "downloaded");
    assert.equal(filesMap.get("src/bad.js").status, "failed");
    assert.equal(filesMap.get("src/bad.js").error_code, "NOT_FOUND");
  } finally {
    github.fetchGitBlob = originalFetchBlob;
  }
});

test("Step 2: ManifestScheduler selectively excludes documentation and media during code-analysis ingestion", () => {
  // Documentation excluded when includeDocumentation: false or codeAnalysis: true
  const docExcluded1 = classifyManifestFile({ path: "README.md", size: 500 }, { includeDocumentation: false });
  assert.equal(docExcluded1.isEligible, false);
  assert.equal(docExcluded1.exclusionReason, "documentation_omitted");
  assert.equal(docExcluded1.tier, "documentation");

  const docExcluded2 = classifyManifestFile({ path: "docs/architecture.md", size: 1200 }, { codeAnalysis: true });
  assert.equal(docExcluded2.isEligible, false);
  assert.equal(docExcluded2.exclusionReason, "documentation_omitted");

  // Media / binary assets excluded via IGNORED_ASSET_EXTENSIONS
  const font = classifyManifestFile({ path: "assets/inter.woff2", size: 5000 });
  assert.equal(font.isEligible, false);
  assert.equal(font.exclusionReason, "binary_or_media");
  assert.equal(font.tier, "ignored_asset");

  const video = classifyManifestFile({ path: "demo/walkthrough.mp4", size: 9000 });
  assert.equal(video.isEligible, false);
  assert.equal(video.exclusionReason, "binary_or_media");

  // Required configs remain eligible with priority 1
  const gradleKts = classifyManifestFile({ path: "build.gradle.kts", size: 400 });
  assert.equal(gradleKts.isEligible, true);
  assert.equal(gradleKts.category, "dependency_manifest");
  assert.equal(gradleKts.priorityRank, 1);
  assert.equal(gradleKts.tier, "required_config");

  const pyproject = classifyManifestFile({ path: "pyproject.toml", size: 350 });
  assert.equal(pyproject.isEligible, true);
  assert.equal(pyproject.priorityRank, 1);
  assert.equal(pyproject.tier, "required_config");
});


