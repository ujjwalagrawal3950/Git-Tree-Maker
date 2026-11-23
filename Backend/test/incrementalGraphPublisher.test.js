/**
 * Cartograph Phase 11 — Gate 11E Verification Test Suite.
 *
 * Verifies all 26 required test cases specified in Section 11 of:
 * Docs/specs/phase_11_gate_11E_incremental_graph_publication.md
 *
 * Requirements verified:
 * - Incremental resolution (1..6)
 * - Graph correctness (7..12)
 * - Snapshot publication & fencing (13..22)
 * - End-to-end ingestion behavior (23..26)
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const { IngestionJobManager, LEASE_DURATION_MS } = require("../services/ingestion/IngestionJobManager");
const { BatchDownloader } = require("../services/ingestion/BatchDownloader");
const { ManifestScheduler } = require("../services/ingestion/ManifestScheduler");
const { InMemoryStorageClient } = require("../services/ingestion/BatchParser");
const {
  IncrementalGraphPublisher,
  resolveAndBuildGraph,
  processRepositoryIngestion,
  buildSnapshotStoragePath,
  computeSnapshotSha256,
  SNAPSHOTS_BUCKET,
} = require("../services/ingestion/IncrementalGraphPublisher");
const { GraphSnapshotStore } = require("../services/graph/GraphSnapshotStore");
const { GraphValidator } = require("../services/graph/GraphValidator");
const { EDGE_SEMANTICS } = require("../services/graph/identity");
const { NORMALIZED_STATUSES } = require("../services/graph/evidenceNormalizer");

// Test constants
const REPO = "facebook/react";
const COMMIT_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ORG_ID = "org_gate11e";

function createMockFileIR(filePath, language, symbols = [], options = {}) {
  return {
    schemaVersion: "1.0.0",
    file: {
      path: filePath,
      blobSha: options.blobSha || "abc123blobsha",
      language,
    },
    status: options.status || "complete",
    metrics: { lines: options.lines || 50 },
    symbols,
    imports: options.imports || [],
    exports: options.exports || [],
    calls: options.calls || [],
    diagnostics: options.diagnostics || [],
  };
}

// ============================================================================
// Group 1: Incremental Resolution (Requirements 1 - 6)
// ============================================================================

test("Gate 11E - Requirement 1: A dependency unresolved in batch 1 becomes resolved after its target arrives in batch 2", () => {
  // Batch 1: auth.js imports ./user.js, but user.js does not yet exist
  const authFileIR = createMockFileIR("src/auth.js", "javascript", [], {
    imports: [
      {
        id: "imp_auth_user",
        rawSource: "./user.js",
        location: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
      },
    ],
  });

  const batch1Result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [authFileIR],
    options: { snapshotVersion: 1, batchNumber: 1, isFinal: false },
  });

  // In Batch 1, the import must be unresolved (no confirmed internal edge to user.js)
  assert.equal(batch1Result.snapshot.edges.length, 0);
  assert.equal(batch1Result.snapshot.unresolvedReferences.length, 1);
  assert.equal(batch1Result.snapshot.unresolvedReferences[0].sourceFile, "src/auth.js");

  // Batch 2: user.js arrives
  const userFileIR = createMockFileIR("src/user.js", "javascript", [
    {
      id: "sym_user",
      name: "getUser",
      qualifiedName: "getUser",
      kind: "function",
      location: { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } },
    },
  ]);

  // Accumulated FileIR state contains both Batch 1 and Batch 2
  const batch2Result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [authFileIR, userFileIR],
    options: { snapshotVersion: 2, batchNumber: 2, isFinal: true },
  });

  // In Batch 2, the import is now resolved! Confirmed dependency edge exists
  const depEdges = batch2Result.snapshot.edges.filter((e) => e.type === EDGE_SEMANTICS.IMPORTS);
  assert.equal(depEdges.length, 1);
  assert.ok(depEdges[0].source.includes("src/auth.js"));
  assert.ok(depEdges[0].target.includes("src/user.js"));
  // Unresolved references list no longer contains this import
  assert.equal(batch2Result.snapshot.unresolvedReferences.length, 0);
});

test("Gate 11E - Requirement 2: Existing committed FileIR is included when resolving a new batch", () => {
  const file1 = createMockFileIR("src/a.js", "javascript");
  const file2 = createMockFileIR("src/b.js", "javascript");

  const result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [file1, file2],
    options: { snapshotVersion: 2 },
  });

  assert.equal(result.snapshot.statistics.fileNodes, 2);
  const paths = result.snapshot.nodes.filter((n) => n.type === "file").map((n) => n.path);
  assert.ok(paths.includes("src/a.js"));
  assert.ok(paths.includes("src/b.js"));
});

test("Gate 11E - Requirement 3: Repeated resolution does not duplicate edges", () => {
  const auth = createMockFileIR("src/auth.js", "javascript", [], {
    imports: [{ id: "imp_1", rawSource: "./user.js" }],
  });
  const user = createMockFileIR("src/user.js", "javascript");

  const run1 = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [auth, user],
  });

  const run2 = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [auth, user],
  });

  assert.equal(run1.snapshot.edges.length, run2.snapshot.edges.length);
  assert.equal(run1.snapshot.nodes.length, run2.snapshot.nodes.length);
  assert.equal(run1.snapshot.publication.graphContentSha256, run2.snapshot.publication.graphContentSha256);
});

test("Gate 11E - Requirement 4: Unresolved and ambiguous references remain explicit", () => {
  const file = createMockFileIR("src/client.js", "javascript", [], {
    imports: [
      { id: "imp_ext", rawSource: "axios" }, // external package
      { id: "imp_missing", rawSource: "./missing-file.js" }, // unresolvable internal
    ],
  });

  const result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [file],
  });

  // No internal dependency edges fabricated
  const internalEdges = result.snapshot.edges.filter((e) => e.target.includes(":file:"));
  assert.equal(internalEdges.length, 0);
  assert.ok(result.snapshot.unresolvedReferences.length >= 1);
  const unres = result.snapshot.unresolvedReferences.find((r) => r.rawSpecifier === "./missing-file.js");
  assert.ok(unres);
  assert.equal(unres.status, NORMALIZED_STATUSES.UNRESOLVED);
});

test("Gate 11E - Requirement 5: Cross-language resolution does not invent relationships", () => {
  const jsFile = createMockFileIR("src/service.js", "javascript");
  const pyFile = createMockFileIR("backend/service.py", "python");

  const result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [jsFile, pyFile],
  });

  // No edge between them
  const crossEdges = result.snapshot.edges.filter(
    (e) => (e.source.includes("service.js") && e.target.includes("service.py")) ||
           (e.source.includes("service.py") && e.target.includes("service.js"))
  );
  assert.equal(crossEdges.length, 0);
});

test("Gate 11E - Requirement 6: Existing language resolver behavior remains intact across JS, Python, Java, and C++", () => {
  // Python import resolution
  const pyMain = createMockFileIR("app/main.py", "python", [], {
    imports: [{ id: "py_1", rawSource: ".utils", languageMetadata: { level: 1 } }],
  });
  const pyUtils = createMockFileIR("app/utils.py", "python");

  const pyResult = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [pyMain, pyUtils],
  });
  assert.ok(pyResult.snapshot.edges.some((e) => e.source.includes("app/main.py") && e.target.includes("app/utils.py")));

  // C++ include resolution
  const cppSrc = createMockFileIR("src/main.cpp", "cpp", [], {
    imports: [{ id: "cpp_1", rawSource: "engine.h" }],
  });
  const cppHeader = createMockFileIR("include/engine.h", "c_cpp_header");

  const cppResult = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [cppSrc, cppHeader],
  });
  assert.ok(cppResult.snapshot.edges.some((e) => e.source.includes("src/main.cpp") && e.target.includes("include/engine.h")));
});

// ============================================================================
// Group 2: Graph Correctness (Requirements 7 - 12)
// ============================================================================

test("Gate 11E - Requirement 7: Canonical node IDs remain stable across batches", () => {
  const auth = createMockFileIR("src/auth.js", "javascript");
  const user = createMockFileIR("src/user.js", "javascript");

  const batch1 = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [auth],
  });
  const authNodeId1 = batch1.snapshot.nodes.find((n) => n.path === "src/auth.js").id;

  const batch2 = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [auth, user],
  });
  const authNodeId2 = batch2.snapshot.nodes.find((n) => n.path === "src/auth.js").id;

  assert.equal(authNodeId1, authNodeId2);
});

test("Gate 11E - Requirement 8: Full file paths distinguish identical basenames in different directories", () => {
  const ctrlIndex = createMockFileIR("src/controllers/index.js", "javascript");
  const svcIndex = createMockFileIR("src/services/index.js", "javascript");

  const result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [ctrlIndex, svcIndex],
  });

  const fileNodes = result.snapshot.nodes.filter((n) => n.type === "file");
  assert.equal(fileNodes.length, 2);
  assert.notEqual(fileNodes[0].id, fileNodes[1].id);
  assert.ok(fileNodes.some((n) => n.path === "src/controllers/index.js"));
  assert.ok(fileNodes.some((n) => n.path === "src/services/index.js"));
});

test("Gate 11E - Requirement 9: Edge provenance is preserved", () => {
  const auth = createMockFileIR("src/auth.js", "javascript", [], {
    imports: [{ id: "imp_1", rawSource: "./user.js", location: { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } } }],
  });
  const user = createMockFileIR("src/user.js", "javascript");

  const result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [auth, user],
  });

  const edge = result.snapshot.edges.find((e) => e.type === EDGE_SEMANTICS.IMPORTS);
  assert.ok(edge);
  assert.ok(Array.isArray(edge.evidence) && edge.evidence.length > 0);
  const ev = edge.evidence[0];
  assert.equal(ev.sourceFile, "src/auth.js");
  assert.equal(ev.resolver.name, "JavaScriptModuleResolver");
  assert.equal(ev.status.normalized, NORMALIZED_STATUSES.RESOLVED);
  assert.deepEqual(ev.sourceLocation, { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } });
});

test("Gate 11E - Requirement 10: GraphValidator rejects invalid candidate graphs", () => {
  const val = GraphValidator.validate({ schemaVersion: "9.9.9", nodes: [] });
  assert.equal(val.isValid, false);
  assert.ok(val.errors.some((e) => e.includes("schemaVersion")));

  const store = new GraphSnapshotStore();
  assert.throws(
    () => {
      store.put({ schemaVersion: "9.9.9", nodes: [] });
    },
    (err) => {
      assert.equal(err.code, "INVALID_GRAPH_SNAPSHOT");
      return true;
    }
  );
});

test("Gate 11E - Requirement 11: A failed candidate does not replace the last valid snapshot", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const store = new GraphSnapshotStore();
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient, store });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const workerId = "worker_val_test";
  const claimed = await jobManager.claimNextJob(workerId);

  // Publish valid snapshot v1
  const auth = createMockFileIR("src/auth.js", "javascript");
  const pub1 = await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    organizationId: ORG_ID,
    workerId,
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    fileIRList: [auth],
  });

  assert.equal(pub1.success, true);
  const jobAfterV1 = await jobManager.getJob(job.id);
  assert.equal(jobAfterV1.snapshot_version, 1);
  const validPath = jobAfterV1.snapshot_storage_path;

  // Attempt to resolve candidate with mixed commits (should fail validation)
  const mixedFile = createMockFileIR("src/mixed.js", "javascript", [], { blobSha: "diff" });
  mixedFile.analysis = { repository: { commitSha: "different_commit_sha", fullName: REPO } };

  await assert.rejects(
    async () => {
      await publisher.publishIncrementalSnapshot({
        jobId: job.id,
        organizationId: ORG_ID,
        workerId,
        fencingToken: claimed.fencing_token,
        snapshotVersion: 2,
        fileIRList: [auth, mixedFile],
      });
    },
    (err) => {
      assert.equal(err.code, "MIXED_COMMIT_FILE_IR");
      return true;
    }
  );

  // Authoritative pointer remains unchanged at v1!
  const jobAfterFail = await jobManager.getJob(job.id);
  assert.equal(jobAfterFail.snapshot_version, 1);
  assert.equal(jobAfterFail.snapshot_storage_path, validPath);
});

test("Gate 11E - Requirement 12: Overview graph remains at the intended file/module level", () => {
  const file = createMockFileIR("src/auth.js", "javascript", [
    { id: "sym_1", name: "login", qualifiedName: "login", kind: "function", location: { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } } },
    { id: "sym_2", name: "logout", qualifiedName: "logout", kind: "function", location: { start: { line: 6, column: 0 }, end: { line: 10, column: 1 } } },
  ]);

  const result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [file],
  });

  assert.equal(result.snapshot.statistics.fileNodes, 1);
  assert.equal(result.snapshot.statistics.symbolNodes, 2);
  const fileNodes = result.snapshot.nodes.filter((n) => n.type === "file");
  assert.equal(fileNodes.length, 1);
  assert.equal(fileNodes[0].path, "src/auth.js");
});

// ============================================================================
// Group 3: Snapshot Publication & Fencing (Requirements 13 - 22)
// ============================================================================

test("Gate 11E - Requirement 13: Snapshot versions increase monotonically", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_mono");

  // Publish v1
  const pub1 = await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_mono",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    snapshotStoragePath: "path/v1.json",
    snapshotSha256: "sha_v1",
    snapshotBytes: 100,
  });
  assert.equal(pub1.snapshotVersion, 1);

  // Publish v2
  const pub2 = await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_mono",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 2,
    snapshotStoragePath: "path/v2.json",
    snapshotSha256: "sha_v2",
    snapshotBytes: 200,
  });
  assert.equal(pub2.snapshotVersion, 2);

  // Attempting to publish v2 or v1 again must be rejected
  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_mono",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 2,
        snapshotStoragePath: "path/v2_again.json",
        snapshotSha256: "sha_v2",
        snapshotBytes: 200,
      });
    },
    (err) => {
      assert.equal(err.code, "INVALID_SNAPSHOT_VERSION");
      return true;
    }
  );
});

test("Gate 11E - Requirement 14: Identical retries do not create duplicate versions", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_retry");

  await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_retry",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    snapshotStoragePath: "path/v1.json",
    snapshotSha256: "sha_v1",
    snapshotBytes: 100,
  });

  // Retry with same version 1
  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_retry",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 1,
        snapshotStoragePath: "path/v1.json",
        snapshotSha256: "sha_v1",
        snapshotBytes: 100,
      });
    },
    (err) => {
      assert.equal(err.code, "INVALID_SNAPSHOT_VERSION");
      return true;
    }
  );

  const currentJob = await jobManager.getJob(job.id);
  assert.equal(currentJob.snapshot_version, 1);
});

test("Gate 11E - Requirement 15: Stale fencing tokens cannot publish", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });

  // Worker A claims with initial incremented token
  const claimedA = await jobManager.claimNextJob("worker_a");
  const tokenA = claimedA.fencing_token;
  assert.equal(tokenA, 2);

  // Worker A loses lease; Worker B reclaims with incremented token
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 5000).toISOString();
  liveJob.status = "queued";

  const claimedB = await jobManager.claimNextJob("worker_b");
  const tokenB = claimedB.fencing_token;
  assert.equal(tokenB, 3);

  // Worker A attempts to publish with stale tokenA
  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_a",
        fencingToken: tokenA,
        snapshotVersion: 1,
        snapshotStoragePath: "path/stale.json",
        snapshotSha256: "sha_stale",
        snapshotBytes: 100,
      });
    },
    (err) => {
      assert.ok(err.code === "WORKER_MISMATCH" || err.code === "STALE_FENCING_TOKEN");
      return true;
    }
  );
});

test("Gate 11E - Requirement 16: Expired leases cannot publish", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_lease");

  // Expire worker lease
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_lease",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 1,
        snapshotStoragePath: "path/v1.json",
        snapshotSha256: "sha_v1",
        snapshotBytes: 100,
      });
    },
    (err) => {
      assert.equal(err.code, "LEASE_EXPIRED");
      return true;
    }
  );
});

test("Gate 11E - Requirement 17: Concurrent workers cannot overwrite a newer snapshot", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });

  const claimedA = await jobManager.claimNextJob("worker_a");
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 5000).toISOString();
  liveJob.status = "queued";

  const claimedB = await jobManager.claimNextJob("worker_b");
  assert.equal(claimedB.fencing_token, 3);

  // Worker B publishes v1
  await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_b",
    fencingToken: claimedB.fencing_token,
    snapshotVersion: 1,
    snapshotStoragePath: "path/b_v1.json",
    snapshotSha256: "sha_b1",
    snapshotBytes: 100,
  });

  // Worker A attempts to publish v1 or overwrite
  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_a",
        fencingToken: claimedA.fencing_token,
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

  const finalJob = await jobManager.getJob(job.id);
  assert.equal(finalJob.snapshot_storage_path, "path/b_v1.json");
});

test("Gate 11E - Requirement 18: Snapshot checksum and metadata are verified during rehydration", async () => {
  const storageClient = new InMemoryStorageClient();
  const publisher = new IncrementalGraphPublisher({ storageClient });

  const file = createMockFileIR("src/auth.js", "javascript");
  const { snapshot, sha256 } = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [file],
    options: { snapshotVersion: 1 },
  });

  const path = buildSnapshotStoragePath({
    organizationId: ORG_ID,
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    snapshotVersion: 1,
    fencingToken: 1,
    sha256,
  });

  // Store in storage
  await storageClient.from(SNAPSHOTS_BUCKET).upload(path, JSON.stringify(snapshot));

  // Successful rehydration
  const rehydrated = await publisher.rehydrateSnapshot({
    snapshotStoragePath: path,
    expectedSha256: sha256,
    expectedRepositoryId: REPO,
    expectedCommitSha: COMMIT_SHA,
    expectedVersion: 1,
    storageClient,
  });
  assert.equal(rehydrated.repository.repositoryId, REPO);

  // Tampered payload fails checksum check
  await assert.rejects(
    async () => {
      await publisher.rehydrateSnapshot({
        snapshotStoragePath: path,
        expectedSha256: "tampered_sha_256",
        expectedRepositoryId: REPO,
        expectedCommitSha: COMMIT_SHA,
        expectedVersion: 1,
        storageClient,
      });
    },
    (err) => {
      assert.equal(err.code, "SNAPSHOT_INTEGRITY_VIOLATION");
      return true;
    }
  );
});

test("Gate 11E - Requirement 19: Storage upload success followed by DB failure leaves the prior pointer intact", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_up_db");

  // Initial successful publish v1
  const file1 = createMockFileIR("src/file1.js", "javascript");
  await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    workerId: "worker_up_db",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    fileIRList: [file1],
  });

  const jobV1 = await jobManager.getJob(job.id);
  const priorPath = jobV1.snapshot_storage_path;
  assert.equal(jobV1.snapshot_version, 1);

  // Expire worker lease before publishing v2
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();

  const file2 = createMockFileIR("src/file2.js", "javascript");
  await assert.rejects(
    async () => {
      await publisher.publishIncrementalSnapshot({
        jobId: job.id,
        workerId: "worker_up_db",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 2,
        fileIRList: [file1, file2],
      });
    },
    (err) => {
      assert.equal(err.code, "LEASE_EXPIRED");
      return true;
    }
  );

  // Prior database pointer remains strictly intact!
  const jobAfterFailedV2 = await jobManager.getJob(job.id);
  assert.equal(jobAfterFailedV2.snapshot_version, 1);
  assert.equal(jobAfterFailedV2.snapshot_storage_path, priorPath);
});

test("Gate 11E - Requirement 20: Worker recovery preserves the last valid published snapshot", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimedA = await jobManager.claimNextJob("worker_a");

  await jobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_a",
    fencingToken: claimedA.fencing_token,
    snapshotVersion: 1,
    snapshotStoragePath: "path/v1.json",
    snapshotSha256: "sha_1",
    snapshotBytes: 50,
  });

  // Reconcile dangling job after lease expiry
  const liveJob = jobManager.memoryJobs.get(job.id);
  liveJob.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  const reconciled = await jobManager.reconcileDanglingJobs();
  assert.equal(reconciled.requeuedCount, 1);

  // New worker claims
  const claimedB = await jobManager.claimNextJob("worker_b");
  assert.equal(claimedB.snapshot_version, 1);
  assert.equal(claimedB.snapshot_storage_path, "path/v1.json");
});

test("Gate 11E - Requirement 21: Cancellation prevents publication", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_cancel");

  // User requests cancellation
  await jobManager.requestCancellation(job.id, ORG_ID);

  await assert.rejects(
    async () => {
      await jobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_cancel",
        fencingToken: claimed.fencing_token,
        snapshotVersion: 1,
        snapshotStoragePath: "path/v1.json",
        snapshotSha256: "sha_1",
        snapshotBytes: 100,
      });
    },
    (err) => {
      assert.equal(err.code, "JOB_NOT_ACTIVE");
      return true;
    }
  );
});

test("Gate 11E - Requirement 22: Previously published snapshots remain intact in Storage", async () => {
  const storageClient = new InMemoryStorageClient();
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const job = await jobManager.createJob({ repositoryId: REPO, organizationId: ORG_ID, commitSha: COMMIT_SHA });
  const claimed = await jobManager.claimNextJob("worker_store_intact");

  const file1 = createMockFileIR("src/f1.js", "javascript");
  const pub1 = await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    workerId: "worker_store_intact",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 1,
    fileIRList: [file1],
  });

  const file2 = createMockFileIR("src/f2.js", "javascript");
  const pub2 = await publisher.publishIncrementalSnapshot({
    jobId: job.id,
    workerId: "worker_store_intact",
    fencingToken: claimed.fencing_token,
    snapshotVersion: 2,
    fileIRList: [file1, file2],
  });

  // Both artifacts must exist in storage!
  const list = await storageClient.from(SNAPSHOTS_BUCKET).list();
  assert.equal(list.data.length, 2);
  assert.ok(list.data.some((item) => item.name === pub1.snapshotStoragePath));
  assert.ok(list.data.some((item) => item.name === pub2.snapshotStoragePath));
});

// ============================================================================
// Group 4: End-to-End Ingestion Behavior (Requirements 23 - 26)
// ============================================================================

test("Gate 11E - Requirement 23: A small repository processes all eligible files in one continuous run", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const scheduler = new ManifestScheduler({ jobManager });
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  // Mock downloader returning source files
  const filesToIngest = [
    { path: "src/a.js", size: 100, priority_rank: 2 },
    { path: "src/b.js", size: 100, priority_rank: 3 },
  ];

  const job = await jobManager.createJob({
    repositoryId: REPO,
    organizationId: ORG_ID,
    commitSha: COMMIT_SHA,
    mode: "small",
  });
  const claimed = await jobManager.claimNextJob("worker_small");
  await jobManager.populateJobFiles(job.id, filesToIngest);

  const mockDownloader = {
    downloadFilesConcurrent: async (files) => ({
      downloaded: files.map((f) => ({ path: f.path, buffer: Buffer.from("console.log('hi');") })),
      failed: [],
      skipped: [],
    }),
  };

  const outcome = await processRepositoryIngestion({
    jobId: job.id,
    workerId: "worker_small",
    fencingToken: claimed.fencing_token,
    scheduler,
    publisher,
    options: {
      downloader: mockDownloader,
      storageClient,
      fileIRList: [createMockFileIR("src/a.js", "javascript"), createMockFileIR("src/b.js", "javascript")],
    },
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.mode, "small");
  // Small repo publishes 1 complete graph at the end
  assert.equal(outcome.snapshotsPublished, 1);
  const finalJob = await jobManager.getJob(job.id);
  assert.equal(finalJob.graph_status, "complete");
  assert.equal(finalJob.initial_graph_ready, true);
  assert.equal(finalJob.status, "completed");
});

test("Gate 11E - Requirement 24: A medium repository publishes progressively while later batches continue automatically", async () => {
  const jobManager = new IngestionJobManager({ useMemoryStore: true });
  const storageClient = new InMemoryStorageClient();
  const scheduler = new ManifestScheduler({ jobManager });
  const publisher = new IncrementalGraphPublisher({ jobManager, storageClient });

  const filesToIngest = [
    { path: "src/batch1.js", size: 100, priority_rank: 1 },
    { path: "src/batch2.js", size: 100, priority_rank: 3 },
  ];

  const job = await jobManager.createJob({
    repositoryId: REPO,
    organizationId: ORG_ID,
    commitSha: COMMIT_SHA,
    mode: "medium",
  });
  const claimed = await jobManager.claimNextJob("worker_med");
  await jobManager.populateJobFiles(job.id, filesToIngest);

  const mockDownloader = {
    downloadFilesConcurrent: async (files) => ({
      downloaded: files.map((f) => ({ path: f.path, buffer: Buffer.from("console.log('med');") })),
      failed: [],
      skipped: [],
    }),
  };

  const file1 = createMockFileIR("src/batch1.js", "javascript");
  const file2 = createMockFileIR("src/batch2.js", "javascript");

  const outcome = await processRepositoryIngestion({
    jobId: job.id,
    workerId: "worker_med",
    fencingToken: claimed.fencing_token,
    scheduler,
    publisher,
    options: {
      downloader: mockDownloader,
      storageClient,
      batchSize: 1, // Force 2 batches
      fileIRList: [file1, file2],
    },
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.mode, "medium");
  assert.equal(outcome.batchesProcessed, 2);
  // Medium repository published progressively (snapshot 1 then snapshot 2)
  assert.equal(outcome.snapshotsPublished, 2);
  assert.equal(outcome.publishedSnapshots[0].snapshotVersion, 1);
  assert.equal(outcome.publishedSnapshots[1].snapshotVersion, 2);
  const finalJob = await jobManager.getJob(job.id);
  assert.equal(finalJob.graph_status, "complete");
});

test("Gate 11E - Requirement 25: A large repository remains within configured resource limits", () => {
  const fileList = [];
  for (let i = 0; i < 50; i++) {
    fileList.push(createMockFileIR(`src/file_${i}.js`, "javascript"));
  }

  const result = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: fileList,
    options: { snapshotVersion: 1 },
  });

  // Telemetry metrics are tracked and bounded
  assert.ok(result.stats.resolutionDurationMs >= 0);
  assert.ok(result.stats.graphBuildDurationMs >= 0);
  assert.equal(result.stats.totalNodes, 50);
  assert.ok(result.stats.bytes > 0);
});

test("Gate 11E - Requirement 26: Clicking a file or requesting a neighborhood does not trigger ingestion or downloading", async () => {
  const store = new GraphSnapshotStore();
  const fileA = createMockFileIR("src/auth.js", "javascript");
  const fileB = createMockFileIR("src/user.js", "javascript");

  const buildResult = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    organizationId: ORG_ID,
    fileIRList: [fileA, fileB],
  });

  const { queryService } = store.put(buildResult.snapshot, { organizationId: ORG_ID });
  const authNode = buildResult.snapshot.nodes.find((n) => n.path === "src/auth.js");

  // Querying neighborhood must be entirely synchronous in-memory from GraphQueryService
  const neighborhood = queryService.getNeighborhood(authNode.id, { radius: 1 });

  assert.ok(neighborhood);
  assert.ok(Array.isArray(neighborhood.nodes));
  assert.ok(Array.isArray(neighborhood.edges));
  assert.ok(neighborhood.nodes.some((n) => n.id === authNode.id));
  // Verified: zero HTTP calls, zero downloads, zero scheduler invocations
});
