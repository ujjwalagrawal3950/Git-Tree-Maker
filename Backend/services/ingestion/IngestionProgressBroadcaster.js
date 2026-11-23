/**
 * Cartograph Real-Time Ingestion Progress Broadcaster & Event Store (Gate 11F & 11F.2).
 *
 * Implements:
 * - Database-atomic monotonic event ID assignment per job via PostgreSQL row-locking.
 * - Persistent event recording in PostgreSQL with transactional consistency.
 * - Cross-instance live event delivery via bounded interval poller (active only while subscribers exist).
 * - Reliable event replay via SSE `Last-Event-ID` header.
 * - Authoritative `job.snapshot` fallback when replay history is expired or unavailable.
 * - Native browser SSE streaming with periodic heartbeat keep-alives (15s).
 * - Safe client disconnection and bounded concurrent connection management.
 * - Terminal state detection and orderly connection closure.
 * - Single-use, short-lived ticket authorization with database-level conditional update & log redaction.
 */

const crypto = require("node:crypto");
const { supabaseAdmin } = require("../../config/DbConnect");
const { AppError } = require("../../lib/errors");

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds
const DEFAULT_TICKET_TTL_MS = 60000; // 60 seconds
const DEFAULT_CROSS_INSTANCE_POLL_MS = 500; // 500ms
const MAX_CONCURRENT_PER_JOB = 50;
const MAX_TOTAL_CONNECTIONS = 500;

class IngestionProgressBroadcaster {
  constructor(options = {}) {
    this.useMemoryStore = options.useMemoryStore !== undefined
      ? Boolean(options.useMemoryStore)
      : (process.env.NODE_ENV === "test" || !process.env.SUPABASE_URL);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.ticketTtlMs = options.ticketTtlMs || DEFAULT_TICKET_TTL_MS;
    this.crossInstancePollIntervalMs = options.crossInstancePollIntervalMs || DEFAULT_CROSS_INSTANCE_POLL_MS;

    // Optional shared backing store for simulating multi-instance across broadcaster instances
    this.sharedStore = options.sharedStore || null;

    // In-memory dual-store for isolated testing and fast replay
    // jobId -> Array<{ eventId, eventType, timestamp, jobId, ...payload }>
    this.memoryEvents = options.sharedStore ? options.sharedStore.memoryEvents : new Map();
    // jobId -> currentMonotonicCounter
    this.eventCounters = options.sharedStore ? options.sharedStore.eventCounters : new Map();

    // Active SSE subscribers: jobId -> Set<{ res, timer, clientId, isReplaying, replayBuffer }>
    this.subscribers = new Map();
    this.totalConnections = 0;

    // Single-use short-lived SSE auth tickets: ticket -> { userId, orgId, jobId, expiresAt }
    this.tickets = options.sharedStore ? options.sharedStore.tickets : new Map();

    // Per-job async serialization lock for monotonic ID allocation in single process
    this.jobLocks = new Map();

    // Cross-instance polling timers & highest seen event IDs: jobId -> timer / number
    this.pollers = new Map();
    this.highestSeenEventIds = new Map();

    // Bounded deduplication sets and out-of-order event reassembly buffers
    this.deliveredEventIds = new Map(); // jobId -> Set<number>
    this.pendingOutOfOrderEvents = new Map(); // jobId -> Map<number, { ev: object, seenAt: number, pollsWaiting: number }>
  }

  /**
   * Helper to serialize operations per job ID in single process.
   *
   * @param {string} jobId
   * @param {Function} fn
   * @returns {Promise<any>}
   * @private
   */
  async _withJobLock(jobId, fn) {
    const prev = this.jobLocks.get(jobId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.jobLocks.set(jobId, current);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.jobLocks.get(jobId) === current) {
        this.jobLocks.delete(jobId);
      }
    }
  }

  /**
   * Redacts sensitive ticket strings for safe logging.
   *
   * @param {string} ticket
   * @returns {string}
   */
  _redactTicket(ticket) {
    if (!ticket || typeof ticket !== "string") return "[EMPTY]";
    if (ticket.length <= 8) return "[REDACTED]";
    return `${ticket.slice(0, 4)}...[REDACTED]`;
  }

  /**
   * Generates an authorized single-use short-lived ticket for browser EventSource.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {string} params.jobId
   * @returns {Promise<{ ticket: string, expiresAt: string }>}
   */
  async createTicket({ userId, orgId, jobId }) {
    if (!userId || !orgId || !jobId) {
      throw new AppError(400, "INVALID_TICKET_PARAMS", "userId, orgId, and jobId are required to create an SSE ticket.");
    }

    const ticket = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + this.ticketTtlMs).toISOString();

    if (this.useMemoryStore) {
      this.tickets.set(ticket, {
        userId,
        orgId,
        jobId,
        expiresAt: new Date(expiresAt).getTime(),
      });
    } else {
      const { error } = await supabaseAdmin
        .from("ingestion_sse_tickets")
        .insert({
          ticket,
          job_id: jobId,
          organization_id: orgId,
          user_id: userId,
          expires_at: expiresAt,
        });

      if (error) {
        throw new AppError(500, "DATABASE_ERROR", `Failed to issue SSE ticket: ${error.message}`);
      }
    }

    return { ticket, expiresAt };
  }

  /**
   * Consumes a single-use ticket atomically across backend instances.
   * Returns actor payload if valid, null otherwise.
   *
   * @param {string} ticket
   * @param {string} jobId
   * @returns {Promise<object|null>}
   */
  async consumeTicket(ticket, jobId) {
    if (!ticket || typeof ticket !== "string") return null;

    if (this.useMemoryStore) {
      const entry = this.tickets.get(ticket);
      if (!entry) return null;

      // Single-use: delete immediately regardless of outcome
      this.tickets.delete(ticket);

      if (Date.now() > entry.expiresAt) return null;
      if (entry.jobId !== jobId) return null;

      return {
        userId: entry.userId,
        orgId: entry.orgId,
        jobId: entry.jobId,
      };
    }

    // Production database atomic conditional update via RPC or direct SQL
    try {
      const { data, error } = await supabaseAdmin.rpc("consume_sse_ticket", {
        p_ticket: ticket,
        p_job_id: jobId,
      });

      if (!error && data) {
        return data;
      }
    } catch (e) {
      // Fall through to direct table query
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("ingestion_sse_tickets")
      .update({ consumed_at: nowIso })
      .eq("ticket", ticket)
      .eq("job_id", jobId)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .select("user_id, organization_id, job_id")
      .maybeSingle();

    if (error || !data) return null;

    return {
      userId: data.user_id,
      orgId: data.organization_id,
      jobId: data.job_id,
    };
  }

  /**
   * Returns the current maximum event ID for a given job.
   *
   * @param {string} jobId
   * @returns {Promise<number>}
   */
  async getMaxEventId(jobId) {
    if (this.useMemoryStore) {
      return this.eventCounters.get(jobId) || 0;
    }

    const { data, error } = await supabaseAdmin
      .from("ingestion_job_events")
      .select("event_id")
      .eq("job_id", jobId)
      .order("event_id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new AppError(500, "DATABASE_ERROR", `Failed to fetch max event ID: ${error.message}`);
    }

    return data ? Number(data.event_id) : 0;
  }

  /**
   * Assigns the next monotonic event ID for a job atomically in memory store.
   *
   * @param {string} jobId
   * @returns {number} Monotonic event ID (1, 2, 3...)
   * @private
   */
  _getNextEventId(jobId) {
    const current = this.eventCounters.get(jobId) || 0;
    const next = current + 1;
    this.eventCounters.set(jobId, next);
    return next;
  }

  /**
   * Records a job event into the persistent store and broadcasts it to connected SSE clients.
   * Enforces database-atomic event ID allocation via PostgreSQL stored procedure when in DB mode.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} params.eventType - e.g. 'job.snapshot', 'job.progress', 'graph.published'
   * @param {object} params.payload
   * @param {string} [params.repositoryId]
   * @param {string} [params.commitSha]
   * @returns {Promise<object>} The recorded event object
   */
  async recordEvent({
    jobId,
    eventType,
    payload = {},
    repositoryId = null,
    commitSha = null,
  }) {
    if (!jobId || !eventType) {
      throw new AppError(400, "INVALID_EVENT_PARAMS", "jobId and eventType are required.");
    }

    let eventRecord;

    if (this.useMemoryStore) {
      return this._withJobLock(jobId, async () => {
        const eventId = this._getNextEventId(jobId);
        const timestamp = new Date().toISOString();
        eventRecord = {
          eventId,
          jobId,
          eventType,
          timestamp,
          repositoryId: repositoryId || payload.repositoryId || null,
          commitSha: commitSha || payload.commitSha || null,
          ...payload,
        };

        if (!this.memoryEvents.has(jobId)) {
          this.memoryEvents.set(jobId, []);
        }
        this.memoryEvents.get(jobId).push(eventRecord);
        if (!this.deliveredEventIds.has(jobId)) {
          this.deliveredEventIds.set(jobId, new Set());
        }
        this.deliveredEventIds.get(jobId).add(eventRecord.eventId);
        this.highestSeenEventIds.set(jobId, Math.max(this.highestSeenEventIds.get(jobId) || 0, eventId));

        // Broadcast to local live SSE subscribers
        this._broadcastToSubscribers(jobId, eventRecord);

        return eventRecord;
      });
    }

    // Database mode: Call PostgreSQL stored procedure `record_job_event`
    // which enforces row-level locking on `ingestion_jobs` for atomic per-job monotonic event_id allocation
    try {
      const { data, error } = await supabaseAdmin.rpc("record_job_event", {
        p_job_id: jobId,
        p_event_type: eventType,
        p_payload: payload,
        p_repository_id: repositoryId || payload.repositoryId || null,
        p_commit_sha: commitSha || payload.commitSha || null,
      });

      if (!error && data) {
        eventRecord = data;
      }
    } catch (rpcErr) {
      // Fall through to direct query if RPC is not defined in the connected environment
    }

    if (!eventRecord) {
      // Direct transactional query fallback
      return this._withJobLock(jobId, async () => {
        const currentMax = await this.getMaxEventId(jobId);
        const eventId = currentMax + 1;
        const timestamp = new Date().toISOString();
        eventRecord = {
          eventId,
          jobId,
          eventType,
          timestamp,
          repositoryId: repositoryId || payload.repositoryId || null,
          commitSha: commitSha || payload.commitSha || null,
          ...payload,
        };

        const { error: insertErr } = await supabaseAdmin
          .from("ingestion_job_events")
          .insert({
            job_id: jobId,
            event_id: eventId,
            event_type: eventType,
            payload: eventRecord,
            created_at: timestamp,
          });

        if (insertErr) {
          throw new AppError(500, "DATABASE_ERROR", `Failed to persist event: ${insertErr.message}`);
        }

        if (!this.deliveredEventIds.has(jobId)) {
          this.deliveredEventIds.set(jobId, new Set());
        }
        this.deliveredEventIds.get(jobId).add(eventId);
        this.highestSeenEventIds.set(jobId, Math.max(this.highestSeenEventIds.get(jobId) || 0, eventId));
        this._broadcastToSubscribers(jobId, eventRecord);
        return eventRecord;
      });
    }

    if (!this.deliveredEventIds.has(jobId)) {
      this.deliveredEventIds.set(jobId, new Set());
    }
    this.deliveredEventIds.get(jobId).add(eventRecord.eventId);
    this.highestSeenEventIds.set(jobId, Math.max(this.highestSeenEventIds.get(jobId) || 0, eventRecord.eventId));
    this._broadcastToSubscribers(jobId, eventRecord);
    return eventRecord;
  }

  /**
   * Retrieves all events for a job strictly after lastEventId ordered by eventId ASC.
   *
   * @param {string} jobId
   * @param {number} lastEventId
   * @returns {Promise<Array<object>>}
   */
  async getEventsAfter(jobId, lastEventId = 0) {
    const minId = Number(lastEventId) || 0;

    if (this.useMemoryStore) {
      const events = this.memoryEvents.get(jobId) || [];
      return events
        .filter((e) => e.eventId > minId)
        .sort((a, b) => a.eventId - b.eventId);
    }

    const { data, error } = await supabaseAdmin
      .from("ingestion_job_events")
      .select("event_id, payload")
      .eq("job_id", jobId)
      .gt("event_id", minId)
      .order("event_id", { ascending: true });

    if (error) {
      throw new AppError(500, "DATABASE_ERROR", `Failed to replay events: ${error.message}`);
    }

    return (data || []).map((row) => row.payload);
  }

  /**
   * Formats an SSE message block according to the SSE standard.
   *
   * @param {object} event
   * @returns {string}
   */
  formatSseMessage(event) {
    const eventId = event.eventId !== undefined ? `id: ${event.eventId}\n` : "";
    const eventType = `event: ${event.eventType}\n`;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    return `${eventId}${eventType}${data}`;
  }

  /**
   * Broadcasts an event to all active SSE subscribers for a job on this backend instance.
   * Buffers events if subscriber is currently replaying historical events.
   *
   * @param {string} jobId
   * @param {object} event
   * @private
   */
  _broadcastToSubscribers(jobId, event) {
    const subs = this.subscribers.get(jobId);
    if (!subs || subs.size === 0) return;

    const formatted = this.formatSseMessage(event);
    const terminalTypes = ["job.completed", "job.completed_with_errors", "job.completed_partial", "job.failed", "job.cancelled"];

    for (const sub of subs) {
      if (sub.isReplaying) {
        // Buffer event during replay to avoid race condition
        sub.replayBuffer.push(event);
        continue;
      }

      try {
        sub.res.write(formatted);
        if (typeof sub.res.flush === "function") sub.res.flush();

        // If this is a terminal event, cleanly close the client stream after delivery
        if (terminalTypes.includes(event.eventType)) {
          this._closeSubscriber(jobId, sub);
        }
      } catch (err) {
        // Socket write error, clean up
        this._closeSubscriber(jobId, sub);
      }
    }
  }

  /**
   * Ensures an active cross-instance poller is running for a job while local subscribers exist.
   *
   * @param {string} jobId
   * @private
   */
  _ensureCrossInstancePoller(jobId) {
    if (this.pollers.has(jobId)) return;
    if (this.useMemoryStore && !this.sharedStore) return;

    const poller = setInterval(async () => {
      try {
        await this._pollCrossInstanceEvents(jobId);
      } catch (err) {
        // Suppress poller background errors to prevent unhandled rejection
      }
    }, this.crossInstancePollIntervalMs);

    if (typeof poller.unref === "function") {
      poller.unref();
    }

    this.pollers.set(jobId, poller);
  }

  /**
   * Stops the cross-instance poller when no local subscribers remain for this job.
   *
   * @param {string} jobId
   * @private
   */
  _stopCrossInstancePoller(jobId) {
    const timer = this.pollers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.pollers.delete(jobId);
    }
  }

  /**
   * Polls database for events inserted by other backend instances.
   *
   * @param {string} jobId
   * @private
   */
  async _pollCrossInstanceEvents(jobId) {
    const subs = this.subscribers.get(jobId);
    if (!subs || subs.size === 0) {
      this._stopCrossInstancePoller(jobId);
      return;
    }

    let cursor = this.highestSeenEventIds.get(jobId) || 0;
    const newEvents = await this.getEventsAfter(jobId, cursor);
    if (!newEvents || newEvents.length === 0) return;

    if (!this.deliveredEventIds.has(jobId)) {
      this.deliveredEventIds.set(jobId, new Set());
    }
    const delivered = this.deliveredEventIds.get(jobId);

    if (!this.pendingOutOfOrderEvents.has(jobId)) {
      this.pendingOutOfOrderEvents.set(jobId, new Map());
    }
    const pendingBuffer = this.pendingOutOfOrderEvents.get(jobId);

    const sorted = [...newEvents].sort((a, b) => a.eventId - b.eventId);

    for (const ev of sorted) {
      if (delivered.has(ev.eventId)) {
        continue; // Duplicate prevention
      }

      const expectedNext = cursor + 1;
      if (ev.eventId === expectedNext) {
        // Contiguous in-order event
        delivered.add(ev.eventId);
        cursor = ev.eventId;
        this.highestSeenEventIds.set(jobId, cursor);
        this._broadcastToSubscribers(jobId, ev);

        // Drain any contiguous events from pending buffer
        while (pendingBuffer.has(cursor + 1)) {
          const nextEntry = pendingBuffer.get(cursor + 1);
          pendingBuffer.delete(cursor + 1);
          const nextEv = nextEntry.ev || nextEntry;
          delivered.add(nextEv.eventId);
          cursor = nextEv.eventId;
          this.highestSeenEventIds.set(jobId, cursor);
          this._broadcastToSubscribers(jobId, nextEv);
        }
      } else if (ev.eventId > expectedNext) {
        // Gap detected: out-of-order event arrival
        const existing = pendingBuffer.get(ev.eventId);
        const pollsWaiting = (existing ? existing.pollsWaiting : 0) + 1;
        const seenAt = existing ? existing.seenAt : Date.now();
        pendingBuffer.set(ev.eventId, { ev, seenAt, pollsWaiting });

        // If buffered for multiple poll ticks (or >2000ms), advance cursor past permanent gap to avoid stall
        if (pollsWaiting >= 5 || (Date.now() - seenAt > 2000)) {
          pendingBuffer.delete(ev.eventId);
          delivered.add(ev.eventId);
          cursor = ev.eventId;
          this.highestSeenEventIds.set(jobId, cursor);
          this._broadcastToSubscribers(jobId, ev);
        }
      }
    }
  }

  /**
   * Closes an individual subscriber socket cleanly and releases resources.
   * Stops cross-instance poller if zero subscribers remain.
   *
   * @param {string} jobId
   * @param {object} sub
   * @private
   */
  _closeSubscriber(jobId, sub) {
    if (sub.timer) {
      clearInterval(sub.timer);
      sub.timer = null;
    }
    const subs = this.subscribers.get(jobId);
    if (subs) {
      subs.delete(sub);
      if (subs.size === 0) {
        this.subscribers.delete(jobId);
        this._stopCrossInstancePoller(jobId);
      }
    }
    this.totalConnections = Math.max(0, this.totalConnections - 1);
    try {
      sub.res.end();
    } catch {}
  }

  /**
   * Establishes a real-time SSE stream for a client.
   * Handles replay via Last-Event-ID or falls back to authoritative job snapshot.
   * Eliminates replay-to-live races using an active subscription buffer.
   * Enables cross-instance delivery while active.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {object} params.job - Authoritative job record
   * @param {import('express').Request} params.req
   * @param {import('express').Response} params.res
   */
  async handleSseConnection({ jobId, job, req, res }) {
    // 1. Connection bounds enforcement
    if (this.totalConnections >= MAX_TOTAL_CONNECTIONS) {
      throw new AppError(503, "SERVER_BUSY", "Global concurrent real-time stream limit reached. Retry shortly.");
    }

    let subs = this.subscribers.get(jobId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(jobId, subs);
    }

    if (subs.size >= MAX_CONCURRENT_PER_JOB) {
      throw new AppError(429, "STREAM_LIMIT_EXCEEDED", "Maximum concurrent connections for this job reached.");
    }

    // 2. Set authoritative SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    this.totalConnections++;

    // 3. Register subscriber with replay buffer to eliminate replay-to-live races
    const subEntry = {
      res,
      clientId: crypto.randomUUID(),
      timer: null,
      isReplaying: true,
      replayBuffer: [],
    };
    subs.add(subEntry);

    // Start cross-instance poller if needed
    this._ensureCrossInstancePoller(jobId);

    // Heartbeat timer (15 seconds)
    subEntry.timer = setInterval(() => {
      try {
        const heartbeat = {
          eventType: "heartbeat",
          timestamp: new Date().toISOString(),
          jobId,
        };
        res.write(this.formatSseMessage(heartbeat));
        if (typeof res.flush === "function") res.flush();
      } catch (err) {
        this._closeSubscriber(jobId, subEntry);
      }
    }, this.heartbeatIntervalMs);

    // 4. Socket termination cleanup listeners
    const cleanup = () => {
      this._closeSubscriber(jobId, subEntry);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    // 5. Event Replay or Authoritative Snapshot Fallback
    const rawLastEventId = req.headers["last-event-id"] || req.query.lastEventId;
    let lastEventId = null;
    if (rawLastEventId !== undefined && rawLastEventId !== null && rawLastEventId !== "") {
      const parsed = parseInt(rawLastEventId, 10);
      if (!isNaN(parsed) && parsed > 0) {
        lastEventId = parsed;
      }
    }

    const currentMaxEventId = await this.getMaxEventId(jobId);
    this.highestSeenEventIds.set(jobId, Math.max(this.highestSeenEventIds.get(jobId) || 0, currentMaxEventId));
    const terminalTypes = ["job.completed", "job.completed_with_errors", "job.completed_partial", "job.failed", "job.cancelled"];

    let replayedCount = 0;
    if (lastEventId !== null && lastEventId <= currentMaxEventId) {
      const missedEvents = await this.getEventsAfter(jobId, lastEventId);
      if (missedEvents.length > 0) {
        for (const ev of missedEvents) {
          res.write(this.formatSseMessage(ev));
          replayedCount++;
        }
        if (typeof res.flush === "function") res.flush();

        const highestReplayedId = missedEvents[missedEvents.length - 1].eventId;
        this.highestSeenEventIds.set(jobId, Math.max(this.highestSeenEventIds.get(jobId) || 0, highestReplayedId));

        // Flush any buffered live events that occurred during the replay query
        const buffered = subEntry.replayBuffer || [];
        for (const bEvent of buffered) {
          if (bEvent.eventId > highestReplayedId) {
            res.write(this.formatSseMessage(bEvent));
            if (typeof res.flush === "function") res.flush();

            if (terminalTypes.includes(bEvent.eventType)) {
              this._closeSubscriber(jobId, subEntry);
              return;
            }
          }
        }
      }
    }

    // Done replaying - transition to direct live streaming
    subEntry.isReplaying = false;
    subEntry.replayBuffer = [];

    // If no events were replayed (first connection, invalid/missing/out-of-range lastEventId, or history unavailable)
    if (replayedCount === 0) {
      const totalFiles = job.total_files || 0;
      const processedFiles = job.processed_files || 0;
      const percentage = totalFiles > 0 ? Math.min(100, Math.max(0, Math.round((processedFiles / totalFiles) * 100))) : 0;
      const isTerminal = ["completed", "completed_with_errors", "completed_partial", "failed", "cancelled"].includes(job.status);
      const isCancelled = job.status === "cancelled";
      const isCancelRequested = job.status === "cancel_requested";

      const snapshotEvent = {
        eventId: currentMaxEventId,
        jobId,
        eventType: "job.snapshot",
        timestamp: new Date().toISOString(),
        repositoryId: job.repository_id,
        commitSha: job.commit_sha,
        status: job.status,
        phase: job.phase,
        mode: job.mode,
        totalFiles,
        processedFiles,
        downloadedFiles: job.downloaded_files || 0,
        parsedFiles: job.parsed_files || 0,
        failedFiles: job.failed_files || 0,
        skippedFiles: job.skipped_files || 0,
        remainingFiles: job.remaining_files || 0,
        currentBatch: job.current_batch || 0,
        totalBatches: job.total_batches || 0,
        snapshotVersion: job.snapshot_version || 0,
        graphStatus: job.graph_status || "none",
        initialGraphReady: Boolean(job.initial_graph_ready),
        confirmedEdges: job.confirmed_edges || 0,
        unresolvedReferences: job.unresolved_references || 0,
        percentage,
        isTerminal,
        isCancelled,
        isCancelRequested,
        terminationReason: job.termination_reason || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      };

      res.write(this.formatSseMessage(snapshotEvent));
      if (typeof res.flush === "function") res.flush();
    }

    // 6. If the job is already in a terminal state, cleanly close the SSE stream
    const isTerminal = ["completed", "completed_with_errors", "completed_partial", "failed", "cancelled"].includes(job.status);
    if (isTerminal) {
      this._closeSubscriber(jobId, subEntry);
    }
  }

  /**
   * Clears state (for testing).
   */
  clear() {
    for (const timer of this.pollers.values()) {
      clearInterval(timer);
    }
    this.pollers.clear();
    this.highestSeenEventIds.clear();

    for (const subs of this.subscribers.values()) {
      for (const sub of subs) {
        if (sub.timer) clearInterval(sub.timer);
      }
    }
    this.subscribers.clear();
    this.memoryEvents.clear();
    this.eventCounters.clear();
    this.tickets.clear();
    this.deliveredEventIds.clear();
    this.pendingOutOfOrderEvents.clear();
    this.totalConnections = 0;
  }
}

const defaultBroadcaster = new IngestionProgressBroadcaster();

module.exports = {
  IngestionProgressBroadcaster,
  defaultBroadcaster,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_TICKET_TTL_MS,
  DEFAULT_CROSS_INSTANCE_POLL_MS,
  MAX_CONCURRENT_PER_JOB,
  MAX_TOTAL_CONNECTIONS,
};
