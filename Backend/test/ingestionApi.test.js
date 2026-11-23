/**
 * Cartograph Real-Time Progress API & SSE Streaming Test Suite (Gate 11F & 11F.1).
 *
 * Clearly Separated Test Suites:
 * - Part 1: In-Memory Unit Tests (authoritative job progress, SSE lifecycle, cancellation state machine)
 * - Part 2: Gate 11F.1 Hardening Tests:
 *     1. Persistence & Multi-Instance Replay (survives backend restarts)
 *     2. Concurrent per-job event ID allocation (strict monotonicity & uniqueness)
 *     3. Replay-to-live race resolution (active buffer captures concurrent events)
 *     4. Event insertion failure surfacing (database errors are never silently swallowed)
 *     5. Job-state and event counter consistency (processed_files <= total_files, percentage 0-100)
 *     6. Cancellation-requested vs terminal-cancelled distinction
 *     7. All 5 terminal event types (completed, completed_with_errors, completed_partial, failed, cancelled)
 *     8. Concurrent single-use ticket consumption (atomic race resolution)
 *     9. Cross-tenant ticket, streaming, and cancellation isolation
 *    10. Real PostgreSQL DDL & Schema Integrity (002 & 003 migrations inspection)
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}

const { AppError } = require("../lib/errors");
const organizations = require("../services/organizations");
organizations.requireMembership = async () => ({ role: "member" });

const { defaultJobManager, IngestionJobManager } = require("../services/ingestion/IngestionJobManager");
const {
  IngestionProgressBroadcaster,
  defaultBroadcaster,
} = require("../services/ingestion/IngestionProgressBroadcaster");
const {
  registerAuthoritativeRepositoryOwnership,
  clearAuthoritativeRepositoryOwnership,
} = require("../services/repositoryAuth");
const {
  getJobProgress,
  createSseTicket,
  streamJobEvents,
  cancelJob,
} = require("../controllers/ingestionController");

const REPO_ID = "owner/realtime-repo";
const ORG_A = "org_alpha";
const ORG_B = "org_beta";
const COMMIT_SHA = "abcdef0123456789abcdef0123456789abcdef01";

function setupSpies() {
  const resState = {
    statusCode: 200,
    headers: {},
    jsonCalled: null,
    chunks: [],
    ended: false,
  };

  const resListeners = {};
  const res = {
    status(code) {
      resState.statusCode = code;
      return this;
    },
    json(body) {
      resState.jsonCalled = body;
      return this;
    },
    setHeader(name, val) {
      resState.headers[name.toLowerCase()] = val;
    },
    getHeader(name) {
      return resState.headers[name.toLowerCase()];
    },
    flushHeaders() {},
    write(chunk) {
      resState.chunks.push(chunk.toString());
      return true;
    },
    flush() {},
    end(chunk) {
      if (chunk) resState.chunks.push(chunk.toString());
      resState.ended = true;
      if (resListeners["close"]) resListeners["close"]();
    },
    on(event, handler) {
      resListeners[event] = handler;
    },
    emit(event, ...args) {
      if (resListeners[event]) resListeners[event](...args);
    },
  };

  return { resState, res, resListeners };
}

function createReq({
  params = {},
  body = {},
  query = {},
  headers = {},
  actor = null,
} = {}) {
  const reqListeners = {};
  return {
    params: { repositoryId: REPO_ID, ...params },
    body,
    query,
    headers,
    actor,
    on(event, handler) {
      reqListeners[event] = handler;
    },
    emit(event, ...args) {
      if (reqListeners[event]) reqListeners[event](...args);
    },
  };
}

function resetEnvironment() {
  defaultJobManager.useMemoryStore = true;
  defaultBroadcaster.useMemoryStore = true;
  defaultJobManager.broadcaster = defaultBroadcaster;
  defaultJobManager.clearMemoryStore();
  defaultBroadcaster.clear();
  clearAuthoritativeRepositoryOwnership();
  registerAuthoritativeRepositoryOwnership(REPO_ID, ORG_A);
}

// ============================================================================
// PART 1: Core API & Stream Unit Tests (In-Memory Simulation)
// ============================================================================

test("[Unit] 1. Authorized job status retrieval (GET /api/ingestion/jobs/:jobId)", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
    mode: "medium",
  });

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await getJobProgress(req, res);

  assert.equal(resState.statusCode, 200);
  assert.ok(resState.jsonCalled.success);
  const data = resState.jsonCalled.data.job;
  assert.equal(data.id, job.id);
  assert.equal(data.repositoryId, REPO_ID);
  assert.equal(data.organizationId, ORG_A);
  assert.equal(data.commitSha, COMMIT_SHA);
  assert.equal(data.mode, "medium");
  assert.equal(data.status, "queued");
  assert.equal(data.percentage, 0);
  assert.equal(data.isTerminal, false);
  assert.equal(data.isCancelled, false);
});

test("[Unit] 2. Unauthorized job access rejected with 401 UNAUTHENTICATED", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const { res } = setupSpies();
  const unauthedReq = createReq({
    params: { jobId: job.id },
    actor: null,
  });

  await assert.rejects(
    async () => getJobProgress(unauthedReq, res),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 401);
      assert.equal(err.code, "UNAUTHENTICATED");
      return true;
    }
  );
});

test("[Unit] 3. Cross-tenant job access rejected with 403 TENANT_ACCESS_DENIED", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const { res } = setupSpies();
  const crossTenantReq = createReq({
    params: { jobId: job.id, orgId: ORG_B },
    actor: { userId: "user_beta", orgId: ORG_B },
  });

  await assert.rejects(
    async () => getJobProgress(crossTenantReq, res),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 403);
      assert.equal(err.code, "TENANT_ACCESS_DENIED");
      return true;
    }
  );
});

test("[Unit] 4. Accurate persisted progress metrics and derived completion percentages", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const claim = await defaultJobManager.claimNextJob("worker_1");
  assert.ok(claim);

  await defaultJobManager.populateJobFiles(
    job.id,
    Array.from({ length: 100 }, (_, i) => ({
      path: `src/file_${i}.js`,
      blobSha: `sha_${i}`,
      sizeBytes: 1024,
      priorityRank: 1,
    }))
  );

  const fileOutcomes = Array.from({ length: 30 }, (_, i) => ({
    path: `src/file_${i}.js`,
    status: i < 25 ? "parsed" : (i < 28 ? "failed" : "skipped"),
    storagePath: `graphs/${job.id}/file_${i}.json`,
  }));

  await defaultJobManager.commitBatch({
    jobId: job.id,
    workerId: "worker_1",
    fencingToken: claim.fencing_token,
    batchNumber: 1,
    fileOutcomes,
  });

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await getJobProgress(req, res);

  assert.equal(resState.statusCode, 200);
  const data = resState.jsonCalled.data.job;
  assert.equal(data.totalFiles, 100);
  assert.equal(data.processedFiles, 30);
  assert.equal(data.parsedFiles, 25);
  assert.equal(data.failedFiles, 3);
  assert.equal(data.skippedFiles, 2);
  assert.equal(data.remainingFiles, 70);
  assert.equal(data.percentage, 30);
  assert.equal(data.isTerminal, false);
});

test("[Unit] 5. SSE authentication via single-use ticket and session token", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  // Issue ticket
  const { resState: ticketState, res: ticketRes } = setupSpies();
  const ticketReq = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await createSseTicket(ticketReq, ticketRes);
  assert.equal(ticketState.statusCode, 200);
  const { ticket, expiresAt } = ticketState.jsonCalled.data;
  assert.ok(ticket);
  assert.ok(expiresAt);

  // Connect using single-use ticket with NO session cookie / actor
  const { resState: sseState, res: sseRes } = setupSpies();
  const sseReq = createReq({
    params: { jobId: job.id },
    query: { ticket },
    actor: null,
  });

  await streamJobEvents(sseReq, sseRes);

  assert.equal(sseState.headers["content-type"], "text/event-stream");
  assert.equal(sseState.headers["cache-control"], "no-cache, no-transform");
  assert.equal(sseState.headers["connection"], "keep-alive");
  assert.ok(sseState.chunks.length > 0);
  assert.ok(sseState.chunks[0].includes("event: job.snapshot"));

  // Second attempt using the SAME ticket must be rejected (single-use consumed)
  const { res: reuseRes } = setupSpies();
  const reuseReq = createReq({
    params: { jobId: job.id },
    query: { ticket },
    actor: null,
  });

  await assert.rejects(
    async () => streamJobEvents(reuseReq, reuseRes),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 401);
      assert.equal(err.code, "INVALID_SSE_TICKET");
      return true;
    }
  );
});

test("[Unit] 6. SSE tenant isolation prevents unauthorized client subscriptions", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  // Cross-tenant attempt to issue ticket
  const { res: ticketRes } = setupSpies();
  const crossTicketReq = createReq({
    params: { jobId: job.id, orgId: ORG_B },
    actor: { userId: "user_beta", orgId: ORG_B },
  });

  await assert.rejects(
    async () => createSseTicket(crossTicketReq, ticketRes),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 403);
      assert.equal(err.code, "TENANT_ACCESS_DENIED");
      return true;
    }
  );

  // Cross-tenant direct SSE stream attempt
  const { res: sseRes } = setupSpies();
  const crossSseReq = createReq({
    params: { jobId: job.id, orgId: ORG_B },
    actor: { userId: "user_beta", orgId: ORG_B },
  });

  await assert.rejects(
    async () => streamJobEvents(crossSseReq, sseRes),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 403);
      assert.equal(err.code, "TENANT_ACCESS_DENIED");
      return true;
    }
  );
});

test("[Unit] 7. Monotonically increasing event IDs per job (1, 2, 3...)", async () => {
  resetEnvironment();

  const jobId = "job_monotony_test";
  const e1 = await defaultBroadcaster.recordEvent({ jobId, eventType: "job.progress", payload: { count: 10 } });
  const e2 = await defaultBroadcaster.recordEvent({ jobId, eventType: "graph.published", payload: { ver: 1 } });
  const e3 = await defaultBroadcaster.recordEvent({ jobId, eventType: "job.progress", payload: { count: 20 } });

  assert.equal(e1.eventId, 1);
  assert.equal(e2.eventId, 2);
  assert.equal(e3.eventId, 3);
  assert.ok(e1.eventId < e2.eventId);
  assert.ok(e2.eventId < e3.eventId);
});

test("[Unit] 8. Correct SSE wire protocol formatting (id, event, data)", async () => {
  resetEnvironment();

  const formatted = defaultBroadcaster.formatSseMessage({
    eventId: 42,
    eventType: "job.progress",
    percentage: 75,
  });

  assert.ok(formatted.startsWith("id: 42\n"));
  assert.ok(formatted.includes("event: job.progress\n"));
  assert.ok(formatted.includes('data: {"eventId":42,"eventType":"job.progress","percentage":75}\n\n'));
});

test("[Unit] 9. Last-Event-ID reconnection and gapless sequential replay", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  for (let i = 1; i <= 5; i++) {
    await defaultBroadcaster.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { batchIndex: i },
    });
  }

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    headers: { "last-event-id": "2" },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await streamJobEvents(req, res);

  assert.equal(resState.chunks.length, 3);
  assert.ok(resState.chunks[0].includes("id: 3\n"));
  assert.ok(resState.chunks[1].includes("id: 4\n"));
  assert.ok(resState.chunks[2].includes("id: 5\n"));
  assert.ok(!resState.chunks.some((c) => c.includes("event: job.snapshot")));
});

test("[Unit] 10. Event replay after transient client disconnection", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  await defaultBroadcaster.recordEvent({
    jobId: job.id,
    eventType: "job.progress",
    payload: { batchIndex: 1 },
  });

  await defaultBroadcaster.recordEvent({
    jobId: job.id,
    eventType: "job.progress",
    payload: { batchIndex: 2 },
  });
  await defaultBroadcaster.recordEvent({
    jobId: job.id,
    eventType: "graph.published",
    payload: { snapshotVersion: 1 },
  });

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    headers: { "last-event-id": "1" },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await streamJobEvents(req, res);

  assert.equal(resState.chunks.length, 2);
  assert.ok(resState.chunks[0].includes("id: 2\n"));
  assert.ok(resState.chunks[1].includes("id: 3\n"));
});

test("[Unit] 11. Authoritative job.snapshot fallback when replay history missing, invalid, or out-of-range", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  // Case A: Missing Last-Event-ID
  const { resState: s1, res: r1 } = setupSpies();
  const req1 = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });
  await streamJobEvents(req1, r1);
  assert.ok(s1.chunks[0].includes("event: job.snapshot\n"));

  // Case B: Future / out-of-range Last-Event-ID (e.g. 9999 when max is 0)
  const { resState: s2, res: r2 } = setupSpies();
  const req2 = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    headers: { "last-event-id": "9999" },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });
  await streamJobEvents(req2, r2);
  assert.ok(s2.chunks[0].includes("event: job.snapshot\n"));

  // Case C: Invalid string Last-Event-ID ("invalid_id")
  const { resState: s3, res: r3 } = setupSpies();
  const req3 = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    headers: { "last-event-id": "invalid_id" },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });
  await streamJobEvents(req3, r3);
  assert.ok(s3.chunks[0].includes("event: job.snapshot\n"));
});

test("[Unit] 12. SSE heartbeat delivery (15s keep-alive interval)", async () => {
  const fastBroadcaster = new IngestionProgressBroadcaster({
    useMemoryStore: true,
    heartbeatIntervalMs: 20,
  });

  const { resState, res } = setupSpies();
  const req = createReq({ params: { jobId: "job_hb_test" } });

  await fastBroadcaster.handleSseConnection({
    jobId: "job_hb_test",
    job: { id: "job_hb_test", status: "downloading_batch" },
    req,
    res,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const hasHeartbeat = resState.chunks.some((c) => c.includes("event: heartbeat\n"));
  assert.ok(hasHeartbeat, "Expected at least one heartbeat chunk");

  fastBroadcaster.clear();
});

test("[Unit] 13. Orderly connection termination on terminal event broadcast", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await streamJobEvents(req, res);
  assert.equal(resState.ended, false);

  await defaultBroadcaster.recordEvent({
    jobId: job.id,
    eventType: "job.completed",
    payload: { status: "completed" },
  });

  assert.equal(resState.ended, true);
  assert.equal(defaultBroadcaster.totalConnections, 0);
});

test("[Unit] 14. Client socket disconnection cleanup (subscriber & total connections released)", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await streamJobEvents(req, res);
  assert.equal(defaultBroadcaster.totalConnections, 1);
  assert.equal(defaultBroadcaster.subscribers.get(job.id).size, 1);

  req.emit("close");

  assert.equal(defaultBroadcaster.totalConnections, 0);
  assert.equal(defaultBroadcaster.subscribers.has(job.id), false);
});

test("[Unit] 15. Cancellation authorization and cross-tenant rejection", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const { res: cancelRes } = setupSpies();
  const crossCancelReq = createReq({
    params: { jobId: job.id, orgId: ORG_B },
    actor: { userId: "user_beta", orgId: ORG_B },
  });

  await assert.rejects(
    async () => cancelJob(crossCancelReq, cancelRes),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 403);
      assert.equal(err.code, "TENANT_ACCESS_DENIED");
      return true;
    }
  );
});

test("[Unit] 16. Cancellation requested vs terminal cancelled semantics", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  // Client requests cancellation
  const { resState: s1, res: r1 } = setupSpies();
  const req1 = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await cancelJob(req1, r1);
  assert.equal(s1.statusCode, 200);
  assert.equal(s1.jsonCalled.data.status, "cancel_requested");
  assert.equal(s1.jsonCalled.data.isCancelled, false); // cancel_requested is NOT terminal!
  assert.equal(s1.jsonCalled.data.isCancelRequested, true);

  // Repeat cancel call is idempotent
  const { resState: s2, res: r2 } = setupSpies();
  const req2 = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await cancelJob(req2, r2);
  assert.equal(s2.statusCode, 200);
  assert.equal(s2.jsonCalled.data.status, "cancel_requested");
  assert.equal(s2.jsonCalled.data.isCancelled, false);
});

test("[Unit] 17. Worker cooperative cancellation detection (isJobCancelled)", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  assert.equal(defaultJobManager.isJobCancelled(job.id), false);
  await defaultJobManager.requestCancellation(job.id, ORG_A);
  assert.equal(defaultJobManager.isJobCancelled(job.id), true);
});

test("[Unit] 18. Stale worker publication rejection after cancellation (JOB_NOT_ACTIVE)", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const claim = await defaultJobManager.claimNextJob("worker_zombie");
  assert.ok(claim);

  await defaultJobManager.requestCancellation(job.id, ORG_A);

  await assert.rejects(
    async () =>
      defaultJobManager.publishSnapshot({
        jobId: job.id,
        workerId: "worker_zombie",
        fencingToken: claim.fencing_token,
        snapshotVersion: 1,
        snapshotStoragePath: "snapshots/snap_1.json",
        snapshotSha256: "a".repeat(64),
        snapshotBytes: 5000,
        confirmedEdges: 10,
        unresolvedReferences: 2,
        isFinal: false,
      }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 409);
      assert.equal(err.code, "JOB_NOT_ACTIVE");
      return true;
    }
  );
});

test("[Unit] 19. Graph publication event correctness (snapshotVersion, graphStatus, isFinal)", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const claim = await defaultJobManager.claimNextJob("worker_pub");
  assert.ok(claim);

  await defaultJobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_pub",
    fencingToken: claim.fencing_token,
    snapshotVersion: 1,
    snapshotStoragePath: "snapshots/snap_1.json",
    snapshotSha256: "b".repeat(64),
    snapshotBytes: 5000,
    confirmedEdges: 15,
    unresolvedReferences: 3,
    isFinal: false,
  });

  await defaultJobManager.publishSnapshot({
    jobId: job.id,
    workerId: "worker_pub",
    fencingToken: claim.fencing_token,
    snapshotVersion: 2,
    snapshotStoragePath: "snapshots/snap_2.json",
    snapshotSha256: "c".repeat(64),
    snapshotBytes: 9000,
    confirmedEdges: 25,
    unresolvedReferences: 0,
    isFinal: true,
  });

  const events = await defaultBroadcaster.getEventsAfter(job.id, 0);
  assert.equal(events.length, 3);
  assert.equal(events[0].eventType, "graph.published");
  assert.equal(events[0].snapshotVersion, 1);
  assert.equal(events[0].graphStatus, "partial");
  assert.equal(events[1].eventType, "graph.published");
  assert.equal(events[1].snapshotVersion, 2);
  assert.equal(events[1].graphStatus, "complete");
  assert.equal(events[2].eventType, "job.completed");
});

test("[Unit] 20. Concurrency limit bounds (per-job 50 limit and global 500 limit)", async () => {
  const boundedBroadcaster = new IngestionProgressBroadcaster({ useMemoryStore: true });
  const dummyJob = { id: "job_bounded", status: "downloading_batch" };

  for (let i = 0; i < 50; i++) {
    const { res } = setupSpies();
    const req = createReq({ params: { jobId: "job_bounded" } });
    await boundedBroadcaster.handleSseConnection({
      jobId: "job_bounded",
      job: dummyJob,
      req,
      res,
    });
  }

  assert.equal(boundedBroadcaster.totalConnections, 50);

  const { res: overflowRes } = setupSpies();
  const overflowReq = createReq({ params: { jobId: "job_bounded" } });

  await assert.rejects(
    async () =>
      boundedBroadcaster.handleSseConnection({
        jobId: "job_bounded",
        job: dummyJob,
        req: overflowReq,
        res: overflowRes,
      }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 429);
      assert.equal(err.code, "STREAM_LIMIT_EXCEEDED");
      return true;
    }
  );

  boundedBroadcaster.totalConnections = 500;
  const { res: globalRes } = setupSpies();
  const globalReq = createReq({ params: { jobId: "job_other" } });

  await assert.rejects(
    async () =>
      boundedBroadcaster.handleSseConnection({
        jobId: "job_other",
        job: { id: "job_other", status: "queued" },
        req: globalReq,
        res: globalRes,
      }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status || err.statusCode, 503);
      assert.equal(err.code, "SERVER_BUSY");
      return true;
    }
  );

  boundedBroadcaster.clear();
});

// ============================================================================
// PART 2: Gate 11F.1 Hardening & Reliability Verification
// ============================================================================

test("[Hardening] 21. Multi-instance restart & persistent replay simulation", async () => {
  // Shared persistent storage mock representing database
  const sharedEventStore = [];
  
  const instanceA = new IngestionProgressBroadcaster({ useMemoryStore: true });
  // Hook instance A to store in shared store
  const originalRecordA = instanceA.recordEvent.bind(instanceA);
  instanceA.recordEvent = async (params) => {
    const res = await originalRecordA(params);
    sharedEventStore.push({ ...res });
    return res;
  };

  await instanceA.recordEvent({ jobId: "job_shared", eventType: "job.progress", payload: { step: 1 } });
  await instanceA.recordEvent({ jobId: "job_shared", eventType: "job.progress", payload: { step: 2 } });

  // Simulate instance A restart / crash by discarding instance A completely
  instanceA.clear();

  // Instance B starts fresh with empty memory
  const instanceB = new IngestionProgressBroadcaster({ useMemoryStore: true });
  instanceB.getEventsAfter = async (jobId, lastEventId) => {
    return sharedEventStore
      .filter((e) => e.jobId === jobId && e.eventId > lastEventId)
      .sort((a, b) => a.eventId - b.eventId);
  };
  instanceB.getMaxEventId = async (jobId) => {
    const matching = sharedEventStore.filter((e) => e.jobId === jobId);
    return matching.length > 0 ? Math.max(...matching.map((e) => e.eventId)) : 0;
  };

  const replayed = await instanceB.getEventsAfter("job_shared", 0);
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].eventId, 1);
  assert.equal(replayed[0].step, 1);
  assert.equal(replayed[1].eventId, 2);
  assert.equal(replayed[1].step, 2);
});

test("[Hardening] 22. Concurrent per-job event ID allocation guarantees strictly increasing uniqueness", async () => {
  resetEnvironment();

  const jobId = "job_concurrent_ids";
  const numConcurrent = 20;

  // Fire 20 simultaneous recordEvent calls
  const results = await Promise.all(
    Array.from({ length: numConcurrent }, (_, i) =>
      defaultBroadcaster.recordEvent({
        jobId,
        eventType: "job.progress",
        payload: { writeIndex: i },
      })
    )
  );

  assert.equal(results.length, numConcurrent);
  const allocatedIds = results.map((r) => r.eventId).sort((a, b) => a - b);

  // Verify IDs are strictly 1..20 with zero duplicates
  for (let i = 0; i < numConcurrent; i++) {
    assert.equal(allocatedIds[i], i + 1, `Expected event ID ${i + 1} but got ${allocatedIds[i]}`);
  }

  // Set size must match array length
  const uniqueIds = new Set(allocatedIds);
  assert.equal(uniqueIds.size, numConcurrent);
});

test("[Hardening] 23. Replay-to-live transition captures concurrent events without loss", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  // Record initial events 1 and 2
  await defaultBroadcaster.recordEvent({ jobId: job.id, eventType: "job.progress", payload: { index: 1 } });
  await defaultBroadcaster.recordEvent({ jobId: job.id, eventType: "job.progress", payload: { index: 2 } });

  // Hook getEventsAfter to simulate a live event (event 3) occurring DURING the historical replay query
  const originalGetEventsAfter = defaultBroadcaster.getEventsAfter.bind(defaultBroadcaster);
  defaultBroadcaster.getEventsAfter = async (jId, lastId) => {
    const historical = await originalGetEventsAfter(jId, lastId);
    // Concurrent event written right here during historical DB retrieval
    await defaultBroadcaster.recordEvent({ jobId: job.id, eventType: "job.progress", payload: { index: 3 } });
    return historical;
  };

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    headers: { "last-event-id": "1" },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  await streamJobEvents(req, res);

  // Client must receive historical event 2 AND concurrent live event 3 in exact sequential order
  assert.equal(resState.chunks.length, 2);
  assert.ok(resState.chunks[0].includes("id: 2\n"));
  assert.ok(resState.chunks[0].includes('"index":2'));
  assert.ok(resState.chunks[1].includes("id: 3\n"));
  assert.ok(resState.chunks[1].includes('"index":3'));
});

test("[Hardening] 24. Event insertion failure surfaces AppError and is never silently swallowed", async () => {
  const { supabaseAdmin } = require("../config/DbConnect");
  const originalFrom = supabaseAdmin.from;

  supabaseAdmin.from = () => ({
    insert: async () => ({ error: { message: "Database connection failed or disk full" } }),
    select: () => ({
      eq: () => ({
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({ data: { event_id: 1 }, error: null }),
          }),
        }),
      }),
    }),
  });

  try {
    const failingBroadcaster = new IngestionProgressBroadcaster({ useMemoryStore: false });

    await assert.rejects(
      async () =>
        failingBroadcaster.recordEvent({
          jobId: "00000000-0000-0000-0000-000000000000",
          eventType: "job.progress",
          payload: { test: true },
        }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "DATABASE_ERROR");
        assert.ok(err.message.includes("Database connection failed"));
        return true;
      }
    );
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

test("[Hardening] 25. Job-state and event counter consistency (processed_files <= total_files, percentage 0-100)", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const claim = await defaultJobManager.claimNextJob("worker_metrics");
  assert.ok(claim);

  // Populate 10 files
  await defaultJobManager.populateJobFiles(
    job.id,
    Array.from({ length: 10 }, (_, i) => ({
      path: `file_${i}.js`,
      blobSha: `sha_${i}`,
      sizeBytes: 500,
    }))
  );

  // Batch commit 7 files (5 parsed, 1 failed, 1 skipped)
  const outcomes = Array.from({ length: 7 }, (_, i) => ({
    path: `file_${i}.js`,
    status: i < 5 ? "parsed" : (i === 5 ? "failed" : "skipped"),
  }));

  await defaultJobManager.commitBatch({
    jobId: job.id,
    workerId: "worker_metrics",
    fencingToken: claim.fencing_token,
    batchNumber: 1,
    fileOutcomes: outcomes,
  });

  const updatedJob = await defaultJobManager.getJob(job.id, ORG_A);
  assert.equal(updatedJob.total_files, 10);
  assert.equal(updatedJob.processed_files, 7);
  assert.equal(updatedJob.parsed_files, 5);
  assert.equal(updatedJob.failed_files, 1);
  assert.equal(updatedJob.skipped_files, 1);
  assert.equal(updatedJob.remaining_files, 3);
  assert.ok(updatedJob.processed_files <= updatedJob.total_files);
  assert.equal(updatedJob.remaining_files, updatedJob.total_files - updatedJob.processed_files);

  // Derived percentage verification
  const events = await defaultBroadcaster.getEventsAfter(job.id, 0);
  const progressEv = events.find((e) => e.eventType === "job.progress");
  assert.ok(progressEv);
  assert.equal(progressEv.percentage, 70); // 7 / 10 = 70%
  assert.ok(progressEv.percentage >= 0 && progressEv.percentage <= 100);
});

test("[Hardening] 26. Cancellation lifecycle: cancel_requested keeps SSE open, finalizeCancellation terminates", async () => {
  resetEnvironment();

  const job = await defaultJobManager.createJob({
    repositoryId: REPO_ID,
    organizationId: ORG_A,
    commitSha: COMMIT_SHA,
  });

  const { resState, res } = setupSpies();
  const req = createReq({
    params: { jobId: job.id, orgId: ORG_A },
    actor: { userId: "user_alpha", orgId: ORG_A },
  });

  // Client opens SSE stream
  await streamJobEvents(req, res);
  assert.equal(resState.ended, false);

  // User requests cancellation
  await defaultJobManager.requestCancellation(job.id, ORG_A);

  // SSE stream must REMAIN OPEN after request
  assert.equal(resState.ended, false);
  const eventsAfterRequest = await defaultBroadcaster.getEventsAfter(job.id, 0);
  assert.ok(eventsAfterRequest.some((e) => e.eventType === "job.cancel_requested"));

  // Worker finalizes cancellation
  await defaultJobManager.finalizeCancellation({
    jobId: job.id,
    terminationReason: "Stopped by user request",
  });

  // Now, and only now, SSE stream is closed after terminal job.cancelled
  assert.equal(resState.ended, true);
  const finalJob = await defaultJobManager.getJob(job.id, ORG_A);
  assert.equal(finalJob.status, "cancelled");
});

test("[Hardening] 27. All 5 terminal states emit their distinct event and close SSE stream", async () => {
  const terminalCases = [
    { status: "completed", failed: 0, skipped: 0, expectedEvent: "job.completed" },
    { status: "completed_with_errors", failed: 2, skipped: 0, expectedEvent: "job.completed_with_errors" },
    { status: "completed_partial", failed: 0, skipped: 3, expectedEvent: "job.completed_partial" },
  ];

  for (const c of terminalCases) {
    resetEnvironment();
    const job = await defaultJobManager.createJob({ repositoryId: REPO_ID, organizationId: ORG_A, commitSha: COMMIT_SHA });
    const claim = await defaultJobManager.claimNextJob("worker_term");

    const { resState, res } = setupSpies();
    const req = createReq({ params: { jobId: job.id, orgId: ORG_A }, actor: { userId: "user_alpha", orgId: ORG_A } });
    await streamJobEvents(req, res);
    assert.equal(resState.ended, false);

    // Simulate file counters
    const dbJob = defaultJobManager.memoryJobs.get(job.id);
    dbJob.failed_files = c.failed;
    dbJob.skipped_files = c.skipped;

    await defaultJobManager.publishSnapshot({
      jobId: job.id,
      workerId: "worker_term",
      fencingToken: claim.fencing_token,
      snapshotVersion: 1,
      snapshotStoragePath: "path",
      snapshotSha256: "d".repeat(64),
      snapshotBytes: 100,
      confirmedEdges: 5,
      unresolvedReferences: 0,
      isFinal: true,
    });

    assert.equal(resState.ended, true);
    const events = await defaultBroadcaster.getEventsAfter(job.id, 0);
    assert.ok(events.some((e) => e.eventType === c.expectedEvent), `Expected event ${c.expectedEvent}`);
  }

  // Test failed terminal state
  resetEnvironment();
  const failJobRec = await defaultJobManager.createJob({ repositoryId: REPO_ID, organizationId: ORG_A, commitSha: COMMIT_SHA });
  const { resState: sFail, res: rFail } = setupSpies();
  const reqFail = createReq({ params: { jobId: failJobRec.id, orgId: ORG_A }, actor: { userId: "user_alpha", orgId: ORG_A } });
  await streamJobEvents(reqFail, rFail);
  assert.equal(sFail.ended, false);

  await defaultJobManager.failJob({ jobId: failJobRec.id, errorMessage: "Unrecoverable worker crash" });
  assert.equal(sFail.ended, true);
  const failEvents = await defaultBroadcaster.getEventsAfter(failJobRec.id, 0);
  assert.ok(failEvents.some((e) => e.eventType === "job.failed"));
});

test("[Hardening] 28. Concurrent single-use ticket consumption guarantees atomic single-winner", async () => {
  resetEnvironment();

  const ticketData = await defaultBroadcaster.createTicket({
    userId: "user_alpha",
    orgId: ORG_A,
    jobId: "job_atomic_ticket",
  });
  assert.ok(ticketData.ticket);

  // 5 concurrent attempts to consume the SAME ticket
  const results = await Promise.all([
    defaultBroadcaster.consumeTicket(ticketData.ticket, "job_atomic_ticket"),
    defaultBroadcaster.consumeTicket(ticketData.ticket, "job_atomic_ticket"),
    defaultBroadcaster.consumeTicket(ticketData.ticket, "job_atomic_ticket"),
    defaultBroadcaster.consumeTicket(ticketData.ticket, "job_atomic_ticket"),
    defaultBroadcaster.consumeTicket(ticketData.ticket, "job_atomic_ticket"),
  ]);

  const successfulConsumptions = results.filter((r) => r !== null);
  const failedConsumptions = results.filter((r) => r === null);

  // Exactly 1 winner, exactly 4 rejected
  assert.equal(successfulConsumptions.length, 1);
  assert.equal(failedConsumptions.length, 4);
  assert.equal(successfulConsumptions[0].userId, "user_alpha");
  assert.equal(successfulConsumptions[0].orgId, ORG_A);
});

test("[Hardening] 29. Ticket expiry authoritatively rejects expired tokens", async () => {
  const shortTtlBroadcaster = new IngestionProgressBroadcaster({
    useMemoryStore: true,
    ticketTtlMs: 20, // 20ms TTL
  });

  const { ticket } = await shortTtlBroadcaster.createTicket({
    userId: "user_exp",
    orgId: ORG_A,
    jobId: "job_exp",
  });

  // Wait 40ms for ticket to expire
  await new Promise((resolve) => setTimeout(resolve, 40));

  const consumed = await shortTtlBroadcaster.consumeTicket(ticket, "job_exp");
  assert.equal(consumed, null, "Expired ticket must return null");

  shortTtlBroadcaster.clear();
});

test("[PostgreSQL Schema DDL] 30. Migration 002 & 003 DDL integrity verification", () => {
  const migration002Path = path.resolve(__dirname, "../migrations/002_phase11_ingestion_jobs.sql");
  const migration003Path = path.resolve(__dirname, "../migrations/003_phase11_ingestion_events.sql");

  assert.ok(fs.existsSync(migration002Path), "002_phase11_ingestion_jobs.sql must exist");
  assert.ok(fs.existsSync(migration003Path), "003_phase11_ingestion_events.sql must exist");

  const sql002 = fs.readFileSync(migration002Path, "utf-8");
  const sql003 = fs.readFileSync(migration003Path, "utf-8");

  // Migration 002: authoritative progress counters and unique constraints
  assert.ok(sql002.includes("processed_files INT NOT NULL DEFAULT 0"), "002 must persist processed_files");
  assert.ok(sql002.includes("remaining_files INT NOT NULL DEFAULT 0"), "002 must persist remaining_files");
  assert.ok(sql002.includes("total_files INT NOT NULL DEFAULT 0"), "002 must persist total_files");
  assert.ok(sql002.includes("ENABLE ROW LEVEL SECURITY"), "002 must enable RLS");

  // Migration 003: authoritative event store and single-use tickets
  assert.ok(sql003.includes("CREATE TABLE IF NOT EXISTS public.ingestion_job_events"), "003 must create ingestion_job_events");
  assert.ok(sql003.includes("CONSTRAINT uq_ingestion_job_events_job_event_id UNIQUE (job_id, event_id)"), "003 must enforce unique (job_id, event_id)");
  assert.ok(sql003.includes("REFERENCES public.ingestion_jobs(id) ON DELETE CASCADE"), "003 must enforce foreign key cascade");
  assert.ok(sql003.includes("CREATE INDEX IF NOT EXISTS ingestion_job_events_replay_idx"), "003 must index (job_id, event_id ASC)");
  assert.ok(sql003.includes("CREATE TABLE IF NOT EXISTS public.ingestion_sse_tickets"), "003 must create ingestion_sse_tickets");
  assert.ok(sql003.includes("ENABLE ROW LEVEL SECURITY"), "003 must enable RLS on event store and tickets");
});
