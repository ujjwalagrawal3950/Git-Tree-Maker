/**
 * Cartograph Phase 11 — Gate 11F.2: Database Reliability & Verification Test Suite
 *
 * Verifies all Gate 11F.2 core database reliability and transactional guarantees:
 * 1. Concurrent event allocation from separate broadcaster instances.
 * 2. Event persistence after broadcaster restart.
 * 3. Replay across separate instances.
 * 4. Transaction rollback when event insertion fails.
 * 5. Transaction rollback when job-state mutation fails.
 * 6. Cross-instance live event delivery (with poller auto-cleanup).
 * 7. Concurrent ticket consumption (atomic single-winner).
 * 8. Expired and cross-tenant ticket rejection.
 *
 * Gate 11F.2 Final Verification Deep Dives:
 * 9. commitBatch database atomicity & idempotent retry safety.
 * 10. Polling: Out-of-order event visibility and gap-free reassembly.
 * 11. Polling: Duplicate event prevention and cursor stability.
 * 12. Polling: Database failure tolerance and automatic recovery.
 * 13. Polling: Client socket disconnection cleanup and poller teardown.
 * 14. Polling: Multiple subscribers on the same instance.
 * 15. Polling: Separate instances receiving the same job's events concurrently.
 * 16. SQL Security: Fixed search_path, explicit grants, and RLS policies in migration 003.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { IngestionProgressBroadcaster } = require("../services/ingestion/IngestionProgressBroadcaster");
const { IngestionJobManager } = require("../services/ingestion/IngestionJobManager");
const { AppError } = require("../lib/errors");

describe("Gate 11F.2 — Database Reliability & Verification Suite", () => {
  let sharedBackingStore;
  let instanceA;
  let instanceB;
  let instanceC;
  let jobManagerA;
  let jobManagerB;

  const testOrgId = "org_cartograph_11f2";
  const testRepoId = "cartograph/reliability-core";
  const testCommitSha = "c0ffee11f2000000000000000000000000000000";

  beforeEach(() => {
    // Shared backing store simulating the common database engine accessed by multiple instances
    sharedBackingStore = {
      memoryEvents: new Map(),
      eventCounters: new Map(),
      tickets: new Map(),
    };

    instanceA = new IngestionProgressBroadcaster({
      useMemoryStore: true,
      sharedStore: sharedBackingStore,
      crossInstancePollIntervalMs: 50,
      heartbeatIntervalMs: 60000,
    });

    instanceB = new IngestionProgressBroadcaster({
      useMemoryStore: true,
      sharedStore: sharedBackingStore,
      crossInstancePollIntervalMs: 50,
      heartbeatIntervalMs: 60000,
    });

    instanceC = new IngestionProgressBroadcaster({
      useMemoryStore: true,
      sharedStore: sharedBackingStore,
      crossInstancePollIntervalMs: 50,
      heartbeatIntervalMs: 60000,
    });

    jobManagerA = new IngestionJobManager({
      useMemoryStore: true,
      broadcaster: instanceA,
    });

    jobManagerB = new IngestionJobManager({
      useMemoryStore: true,
      broadcaster: instanceB,
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Concurrent event allocation from separate broadcaster instances
  // ---------------------------------------------------------------------------
  it("1. Concurrent event allocation from separate instances produces strictly increasing, unique IDs", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
      mode: "small",
    });

    const totalEvents = 20;
    const promises = [];
    for (let i = 0; i < totalEvents; i++) {
      const broadcaster = i % 2 === 0 ? instanceA : instanceB;
      promises.push(
        broadcaster.recordEvent({
          jobId: job.id,
          eventType: "job.progress",
          payload: { index: i, worker: i % 2 === 0 ? "instance-A" : "instance-B" },
          repositoryId: testRepoId,
          commitSha: testCommitSha,
        })
      );
    }

    const recorded = await Promise.all(promises);
    assert.equal(recorded.length, totalEvents);

    const allocatedIds = recorded.map((r) => r.eventId).sort((a, b) => a - b);
    const uniqueIds = new Set(allocatedIds);

    assert.equal(uniqueIds.size, totalEvents, "Every event ID must be unique");
    for (let i = 0; i < totalEvents; i++) {
      assert.equal(allocatedIds[i], i + 1, `Expected monotonic ID ${i + 1}, got ${allocatedIds[i]}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Event persistence after broadcaster restart
  // ---------------------------------------------------------------------------
  it("2. Event persistence is preserved after broadcaster destruction and restart", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.started",
      payload: { step: 1 },
    });
    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { step: 2 },
    });
    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "graph.published",
      payload: { step: 3, snapshotVersion: 1 },
    });

    // Destroy Instance A
    instanceA = null;

    // Spin up fresh Instance D pointing to the same shared store
    const instanceD = new IngestionProgressBroadcaster({
      useMemoryStore: true,
      sharedStore: sharedBackingStore,
    });

    const maxId = await instanceD.getMaxEventId(job.id);
    assert.equal(maxId, 3, "Instance D must see maxEventId 3 from persisted store");

    const replayed = await instanceD.getEventsAfter(job.id, 0);
    assert.equal(replayed.length, 3, "All 3 historical events must be rehydrated");

    const nextEvent = await instanceD.recordEvent({
      jobId: job.id,
      eventType: "job.completed",
      payload: { step: 4 },
    });
    assert.equal(nextEvent.eventId, 4, "Post-restart event ID must monotonically continue as 4");
  });

  // ---------------------------------------------------------------------------
  // 3. Replay across separate instances
  // ---------------------------------------------------------------------------
  it("3. Events recorded by Instance A are replayed by Instance B in ascending order", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    for (let i = 1; i <= 5; i++) {
      await instanceA.recordEvent({
        jobId: job.id,
        eventType: "job.progress",
        payload: { progress: i * 20 },
      });
    }

    const replayFrom2 = await instanceB.getEventsAfter(job.id, 2);
    assert.equal(replayFrom2.length, 3, "Instance B must retrieve exactly 3 missed events");
    assert.equal(replayFrom2[0].eventId, 3);
    assert.equal(replayFrom2[1].eventId, 4);
    assert.equal(replayFrom2[2].eventId, 5);
  });

  // ---------------------------------------------------------------------------
  // 4. Transaction rollback when event insertion fails
  // ---------------------------------------------------------------------------
  it("4. Atomic rollback: failed event insertion rolls back job and file state changes", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const claimed = await jobManagerA.claimNextJob("worker-atomic-1");
    assert.ok(claimed);

    await jobManagerA.populateJobFiles(job.id, [
      { path: "src/index.ts", sha256: "aaa", bytes: 100 },
      { path: "src/utils.ts", sha256: "bbb", bytes: 200 },
    ]);

    const originalRecordEvent = instanceA.recordEvent.bind(instanceA);
    instanceA.recordEvent = async () => {
      throw new AppError(500, "DATABASE_ERROR", "Simulated event insertion failure");
    };

    // Cancellation rollback
    await assert.rejects(
      async () => {
        await jobManagerA.requestCancellation(job.id, testOrgId);
      },
      (err) => err.code === "DATABASE_ERROR"
    );

    const jobAfterFailedCancel = jobManagerA.memoryJobs.get(job.id);
    assert.equal(jobAfterFailedCancel.status, "downloading_batch", "Job status must roll back to downloading_batch");

    // Batch commit rollback
    const filesBeforeBatch = jobManagerA.memoryFiles.get(job.id).get("src/index.ts");
    assert.equal(filesBeforeBatch.status, "pending");

    await assert.rejects(
      async () => {
        await jobManagerA.commitBatch({
          jobId: job.id,
          workerId: "worker-atomic-1",
          fencingToken: claimed.fencing_token,
          batchNumber: 1,
          fileOutcomes: [{ path: "src/index.ts", status: "parsed" }],
        });
      },
      (err) => err.code === "DATABASE_ERROR"
    );

    const filesAfterFailedBatch = jobManagerA.memoryFiles.get(job.id).get("src/index.ts");
    assert.equal(filesAfterFailedBatch.status, "pending", "File status must roll back to pending");
    assert.equal(jobManagerA.memoryJobs.get(job.id).last_committed_batch, 0, "last_committed_batch must roll back to 0");

    instanceA.recordEvent = originalRecordEvent;
  });

  // ---------------------------------------------------------------------------
  // 5. Transaction rollback when job-state mutation fails
  // ---------------------------------------------------------------------------
  it("5. Failed job-state validation never commits an orphaned event", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const claimed = await jobManagerA.claimNextJob("worker-atomic-2");
    assert.ok(claimed);

    const initialEventCount = (sharedBackingStore.memoryEvents.get(job.id) || []).length;

    await assert.rejects(
      async () => {
        await jobManagerA.publishSnapshot({
          jobId: job.id,
          organizationId: testOrgId,
          workerId: "worker-atomic-2",
          fencingToken: 999, // Stale fencing token
          snapshotVersion: 1,
          snapshotStoragePath: "snapshots/v1.json",
          snapshotSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          snapshotBytes: 500,
        });
      },
      (err) => err.code === "STALE_FENCING_TOKEN"
    );

    const finalEventCount = (sharedBackingStore.memoryEvents.get(job.id) || []).length;
    assert.equal(finalEventCount, initialEventCount, "No event must be written when validation fails");
  });

  // ---------------------------------------------------------------------------
  // 6. Cross-instance live event delivery
  // ---------------------------------------------------------------------------
  it("6. Connected SSE subscriber on Instance B receives live events recorded by Instance A", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const clientDeliveredEvents = [];
    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      write: (str) => {
        const match = str.match(/data: ({.*})\n\n/);
        if (match) {
          try {
            clientDeliveredEvents.push(JSON.parse(match[1]));
          } catch {}
        }
      },
      flush: () => {},
      end: () => {},
      on: () => {},
    };

    const mockReq = {
      headers: {},
      query: {},
      on: () => {},
    };

    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: mockReq,
      res: mockRes,
    });

    assert.ok(instanceB.pollers.has(job.id), "Instance B poller must be active");
    assert.ok(clientDeliveredEvents.some((e) => e.eventType === "job.snapshot"));

    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { step: "cross_instance_test", processedFiles: 5 },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const crossEvent = clientDeliveredEvents.find((e) => e.step === "cross_instance_test");
    assert.ok(crossEvent, "Instance B subscriber must receive event recorded by Instance A");
    assert.equal(crossEvent.eventType, "job.progress");

    instanceB.clear();
    assert.equal(instanceB.pollers.has(job.id), false, "Poller must stop when subscribers disconnect");
  });

  // ---------------------------------------------------------------------------
  // 7. Concurrent ticket consumption
  // ---------------------------------------------------------------------------
  it("7. Concurrent ticket consumption across instances guarantees atomic single-winner", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const { ticket } = await instanceA.createTicket({
      userId: "user_concurrent",
      orgId: testOrgId,
      jobId: job.id,
    });

    const attempts = await Promise.all([
      instanceA.consumeTicket(ticket, job.id),
      instanceB.consumeTicket(ticket, job.id),
      instanceA.consumeTicket(ticket, job.id),
      instanceB.consumeTicket(ticket, job.id),
      instanceA.consumeTicket(ticket, job.id),
      instanceB.consumeTicket(ticket, job.id),
    ]);

    const successfulConsumptions = attempts.filter((res) => res !== null);
    const rejectedConsumptions = attempts.filter((res) => res === null);

    assert.equal(successfulConsumptions.length, 1, "Exactly one caller must succeed");
    assert.equal(rejectedConsumptions.length, 5, "All subsequent attempts must be rejected");
    assert.equal(successfulConsumptions[0].userId, "user_concurrent");
  });

  // ---------------------------------------------------------------------------
  // 8. Expired and cross-tenant ticket rejection
  // ---------------------------------------------------------------------------
  it("8. Expired tickets and cross-tenant ticket attempts are strictly rejected", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const shortLivedBroadcaster = new IngestionProgressBroadcaster({
      useMemoryStore: true,
      ticketTtlMs: -1000,
    });

    const { ticket: expiredTicket } = await shortLivedBroadcaster.createTicket({
      userId: "user_expired",
      orgId: testOrgId,
      jobId: job.id,
    });

    const consumedExpired = await shortLivedBroadcaster.consumeTicket(expiredTicket, job.id);
    assert.equal(consumedExpired, null, "Expired ticket must return null");

    const otherJobId = crypto.randomUUID();
    const { ticket: validTicket } = await instanceA.createTicket({
      userId: "user_valid",
      orgId: testOrgId,
      jobId: job.id,
    });

    const consumedWrongJob = await instanceA.consumeTicket(validTicket, otherJobId);
    assert.equal(consumedWrongJob, null, "Ticket for mismatched job must return null");

    const redacted = instanceA._redactTicket(validTicket);
    assert.ok(!redacted.includes(validTicket), "Redacted ticket must never contain the full plaintext token");
    assert.ok(redacted.endsWith("...[REDACTED]"));
  });

  // ---------------------------------------------------------------------------
  // 9. commitBatch Database Atomicity & Idempotent Retry
  // ---------------------------------------------------------------------------
  it("9. commitBatch: Persists files, counters, and event atomically; rejects duplicate re-commit", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const claimed = await jobManagerA.claimNextJob("worker-commit-1");
    assert.ok(claimed);

    await jobManagerA.populateJobFiles(job.id, [
      { path: "src/a.ts", sha256: "sha_a", bytes: 150 },
      { path: "src/b.ts", sha256: "sha_b", bytes: 250 },
    ]);

    // Batch 1 commit
    const commitResult = await jobManagerA.commitBatch({
      jobId: job.id,
      workerId: "worker-commit-1",
      fencingToken: claimed.fencing_token,
      batchNumber: 1,
      fileOutcomes: [
        { path: "src/a.ts", status: "parsed", storagePath: "ir/a.json", sha256: "sha_a", bytes: 150 },
        { path: "src/b.ts", status: "parsed", storagePath: "ir/b.json", sha256: "sha_b", bytes: 250 },
      ],
    });

    assert.equal(commitResult.success, true);
    assert.equal(commitResult.batchNumber, 1);
    assert.equal(commitResult.filesCommitted, 2);

    const updatedJob = jobManagerA.memoryJobs.get(job.id);
    assert.equal(updatedJob.last_committed_batch, 1);
    assert.equal(updatedJob.parsed_files, 2);
    assert.equal(updatedJob.processed_files, 2);
    assert.equal(updatedJob.remaining_files, 0);

    const events = sharedBackingStore.memoryEvents.get(job.id) || [];
    const progressEvent = events.find((e) => e.eventType === "job.progress");
    assert.ok(progressEvent, "job.progress event must be persisted with batch commit");
    assert.equal(progressEvent.currentBatch, 1);
    assert.equal(progressEvent.processedFiles, 2);

    // Retrying the identical batch must be rejected with BATCH_ALREADY_COMMITTED
    await assert.rejects(
      async () => {
        await jobManagerA.commitBatch({
          jobId: job.id,
          workerId: "worker-commit-1",
          fencingToken: claimed.fencing_token,
          batchNumber: 1,
          fileOutcomes: [{ path: "src/a.ts", status: "parsed" }],
        });
      },
      (err) => err.code === "BATCH_ALREADY_COMMITTED"
    );

    // Counters must not have been double-incremented
    assert.equal(jobManagerA.memoryJobs.get(job.id).parsed_files, 2);
  });

  // ---------------------------------------------------------------------------
  // 10. Polling: Out-of-order event visibility and gap-free reassembly
  // ---------------------------------------------------------------------------
  it("10. Polling: Out-of-order event arrival buffers gaps and delivers strictly in ascending contiguous order", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const receivedEvents = [];
    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      write: (str) => {
        const match = str.match(/data: ({.*})\n\n/);
        if (match) {
          try {
            receivedEvents.push(JSON.parse(match[1]));
          } catch {}
        }
      },
      flush: () => {},
      end: () => {},
      on: () => {},
    };

    // Event 1 is recorded normally; cursor establishes at 1
    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { seq: 1 },
    });

    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: mockRes,
    });

    // Clear initial events from test array
    receivedEvents.length = 0;

    const storeEvents = sharedBackingStore.memoryEvents.get(job.id);

    // Simulate out-of-order event arrival in store: Event 3 arrives before Event 2!
    storeEvents.push({
      eventId: 3, // Out of order! Missing 2!
      jobId: job.id,
      eventType: "job.progress",
      payload: { seq: 3 },
    });

    // Poll cycle 1: cursor is 1, expected next is 2. Event 3 must be buffered waiting for missing Event 2!
    await instanceB._pollCrossInstanceEvents(job.id);

    assert.equal(receivedEvents.length, 0, "Event 3 must not be delivered before missing Event 2");
    assert.equal(instanceB.highestSeenEventIds.get(job.id), 1, "Cursor must remain at 1");

    // Now Event 2 arrives in the database
    storeEvents.push({
      eventId: 2,
      jobId: job.id,
      eventType: "job.progress",
      payload: { seq: 2 },
    });

    // Poll cycle 2: Event 2 arrives -> Event 2 delivered -> buffered Event 3 drained and delivered!
    await instanceB._pollCrossInstanceEvents(job.id);

    assert.equal(receivedEvents.length, 2, "Both Event 2 and buffered Event 3 must be delivered");
    assert.equal(receivedEvents[0].eventId, 2);
    assert.equal(receivedEvents[1].eventId, 3);
    assert.equal(instanceB.highestSeenEventIds.get(job.id), 3, "Cursor must advance to 3");

    instanceB.clear();
  });

  // ---------------------------------------------------------------------------
  // 11. Polling: Duplicate event prevention and cursor stability
  // ---------------------------------------------------------------------------
  it("11. Polling: Duplicate event records returned from query are ignored without duplicate broadcast", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const delivered = [];
    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      write: (str) => {
        const match = str.match(/data: ({.*})\n\n/);
        if (match) {
          try {
            delivered.push(JSON.parse(match[1]));
          } catch {}
        }
      },
      flush: () => {},
      end: () => {},
      on: () => {},
    };

    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: mockRes,
    });
    delivered.length = 0;

    // Record Event 1
    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { num: 1 },
    });

    // Poll cycle 1
    await instanceB._pollCrossInstanceEvents(job.id);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].eventId, 1);

    // Force getEventsAfter on Instance B to return Event 1 again
    const origGetEvents = instanceB.getEventsAfter.bind(instanceB);
    instanceB.getEventsAfter = async () => [{ eventId: 1, eventType: "job.progress", payload: { num: 1 } }];

    // Poll cycle 2 with duplicate event returned
    await instanceB._pollCrossInstanceEvents(job.id);

    // Delivered count must STILL be 1 (duplicate strictly suppressed)
    assert.equal(delivered.length, 1);

    instanceB.getEventsAfter = origGetEvents;
    instanceB.clear();
  });

  // ---------------------------------------------------------------------------
  // 12. Polling: Database failure tolerance and automatic recovery
  // ---------------------------------------------------------------------------
  it("12. Polling: Transient database query error does not kill poller or corrupt cursor", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const delivered = [];
    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      write: (str) => {
        const match = str.match(/data: ({.*})\n\n/);
        if (match) delivered.push(JSON.parse(match[1]));
      },
      flush: () => {},
      end: () => {},
      on: () => {},
    };

    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: mockRes,
    });
    delivered.length = 0;

    // Simulate transient DB failure on Instance B
    const origGetEvents = instanceB.getEventsAfter.bind(instanceB);
    let failQuery = true;
    instanceB.getEventsAfter = async (...args) => {
      if (failQuery) {
        throw new Error("Connection reset by database peer");
      }
      return origGetEvents(...args);
    };

    // Instance A records Event 1
    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { step: 1 },
    });

    // Poller runs and catches error safely
    await instanceB._pollCrossInstanceEvents(job.id).catch(() => {});
    assert.equal(delivered.length, 0, "No event delivered during DB outage");
    assert.ok(instanceB.pollers.has(job.id), "Poller must remain active despite error");

    // Database recovers
    failQuery = false;

    // Next poller cycle
    await instanceB._pollCrossInstanceEvents(job.id);
    assert.equal(delivered.length, 1, "Poller must automatically recover and deliver event");
    assert.equal(delivered[0].eventId, 1);

    instanceB.getEventsAfter = origGetEvents;
    instanceB.clear();
  });

  // ---------------------------------------------------------------------------
  // 13. Polling: Client socket disconnection cleanup and poller teardown
  // ---------------------------------------------------------------------------
  it("13. Polling: Client socket write error disconnects subscriber and cleanly terminates poller", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    let socketClosed = false;
    let shouldFail = false;
    const faultyRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      write: () => {
        if (shouldFail) {
          throw new Error("EPIPE: Broken pipe");
        }
      },
      flush: () => {},
      end: () => {
        socketClosed = true;
      },
      on: () => {},
    };

    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: faultyRes,
    });

    assert.ok(instanceB.pollers.has(job.id));

    // Enable simulated write failure on subsequent live broadcast
    shouldFail = true;

    // Recording an event triggers write -> write throws -> _closeSubscriber cleans up
    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { test: "broken_pipe" },
    });

    await instanceB._pollCrossInstanceEvents(job.id);

    assert.equal(socketClosed, true, "Socket end() must be called");
    assert.equal(instanceB.subscribers.has(job.id), false, "Subscriber must be removed");
    assert.equal(instanceB.pollers.has(job.id), false, "Poller must be terminated when subscriber is removed");
  });

  // ---------------------------------------------------------------------------
  // 14. Polling: Multiple subscribers on the same instance
  // ---------------------------------------------------------------------------
  it("14. Polling: Multiple subscribers on the same instance all receive events; poller persists until all leave", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const client1Delivered = [];
    const client2Delivered = [];

    const makeMockRes = (dest) => ({
      setHeader: () => {},
      flushHeaders: () => {},
      write: (str) => {
        const match = str.match(/data: ({.*})\n\n/);
        if (match) dest.push(JSON.parse(match[1]));
      },
      flush: () => {},
      end: () => {},
      on: () => {},
    });

    const sub1Res = makeMockRes(client1Delivered);
    const sub2Res = makeMockRes(client2Delivered);

    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: sub1Res,
    });
    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: sub2Res,
    });

    client1Delivered.length = 0;
    client2Delivered.length = 0;

    assert.equal(instanceB.subscribers.get(job.id).size, 2);

    // Instance A emits event
    await instanceA.recordEvent({
      jobId: job.id,
      eventType: "job.progress",
      payload: { broadcast: "multi_sub" },
    });

    await instanceB._pollCrossInstanceEvents(job.id);

    assert.equal(client1Delivered.length, 1);
    assert.equal(client2Delivered.length, 1);
    assert.equal(client1Delivered[0].broadcast, "multi_sub");
    assert.equal(client2Delivered[0].broadcast, "multi_sub");

    // Close Subscriber 1
    const sub1Entry = Array.from(instanceB.subscribers.get(job.id))[0];
    instanceB._closeSubscriber(job.id, sub1Entry);

    assert.equal(instanceB.subscribers.get(job.id).size, 1);
    assert.ok(instanceB.pollers.has(job.id), "Poller must remain active when 1 subscriber remains");

    // Close Subscriber 2
    const sub2Entry = Array.from(instanceB.subscribers.get(job.id))[0];
    instanceB._closeSubscriber(job.id, sub2Entry);

    assert.equal(instanceB.pollers.has(job.id), false, "Poller must terminate when 0 subscribers remain");
  });

  // ---------------------------------------------------------------------------
  // 15. Polling: Separate instances receiving the same job's events concurrently
  // ---------------------------------------------------------------------------
  it("15. Polling: Separate instances (Instance B and Instance C) concurrently receive events from Instance A", async () => {
    const job = await jobManagerA.createJob({
      repositoryId: testRepoId,
      organizationId: testOrgId,
      commitSha: testCommitSha,
    });

    const bDelivered = [];
    const cDelivered = [];

    const makeRes = (arr) => ({
      setHeader: () => {},
      flushHeaders: () => {},
      write: (str) => {
        const match = str.match(/data: ({.*})\n\n/);
        if (match) arr.push(JSON.parse(match[1]));
      },
      flush: () => {},
      end: () => {},
      on: () => {},
    });

    await instanceB.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: makeRes(bDelivered),
    });

    await instanceC.handleSseConnection({
      jobId: job.id,
      job,
      req: { headers: {}, query: {}, on: () => {} },
      res: makeRes(cDelivered),
    });

    bDelivered.length = 0;
    cDelivered.length = 0;

    // Instance A records 3 events
    await instanceA.recordEvent({ jobId: job.id, eventType: "job.progress", payload: { count: 1 } });
    await instanceA.recordEvent({ jobId: job.id, eventType: "job.progress", payload: { count: 2 } });
    await instanceA.recordEvent({ jobId: job.id, eventType: "job.progress", payload: { count: 3 } });

    // Instance B and Instance C poll
    await Promise.all([
      instanceB._pollCrossInstanceEvents(job.id),
      instanceC._pollCrossInstanceEvents(job.id),
    ]);

    assert.equal(bDelivered.length, 3, "Instance B must receive all 3 events");
    assert.equal(cDelivered.length, 3, "Instance C must receive all 3 events");

    assert.equal(bDelivered[0].eventId, 1);
    assert.equal(bDelivered[1].eventId, 2);
    assert.equal(bDelivered[2].eventId, 3);

    assert.equal(cDelivered[0].eventId, 1);
    assert.equal(cDelivered[1].eventId, 2);
    assert.equal(cDelivered[2].eventId, 3);

    instanceB.clear();
    instanceC.clear();
  });

  // ---------------------------------------------------------------------------
  // 16. SQL Security: Fixed search_path, explicit grants, and RLS policies
  // ---------------------------------------------------------------------------
  it("16. SQL Security: All migration 003 functions enforce fixed search_path, explicit grants, and RLS", () => {
    const sqlPath = path.resolve(__dirname, "../migrations/003_phase11_ingestion_events.sql");
    assert.ok(fs.existsSync(sqlPath));

    const sql = fs.readFileSync(sqlPath, "utf8");

    // All SECURITY DEFINER functions have fixed search_path = public, pg_temp
    const securityDefinerCount = (sql.match(/SECURITY DEFINER/g) || []).length;
    const searchPathCount = (sql.match(/SET search_path = public, pg_temp/g) || []).length;
    assert.equal(
      searchPathCount,
      securityDefinerCount,
      "Every SECURITY DEFINER function must specify SET search_path = public, pg_temp"
    );

    // commit_job_batch function exists with FOR UPDATE row lock and transaction
    assert.ok(sql.includes("FUNCTION public.commit_job_batch"));
    assert.ok(sql.includes("PERFORM 1 FROM public.ingestion_jobs WHERE id = p_job_id FOR UPDATE;"));

    // Explicit execution permissions revoked from PUBLIC and granted to service_role / authenticated
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION public.record_job_event FROM PUBLIC;"));
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.record_job_event TO service_role;"));
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION public.commit_job_batch FROM PUBLIC;"));
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.commit_job_batch TO service_role;"));

    // RLS enabled and policies defined
    assert.ok(sql.includes("ALTER TABLE public.ingestion_job_events ENABLE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.ingestion_sse_tickets ENABLE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("CREATE POLICY ingestion_job_events_tenant_isolation ON public.ingestion_job_events"));
    assert.ok(sql.includes("CREATE POLICY ingestion_sse_tickets_service_role ON public.ingestion_sse_tickets"));
  });
});
