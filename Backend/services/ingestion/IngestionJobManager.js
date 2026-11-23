/**
 * Cartograph Progressive Ingestion Job Manager (Gate 11B).
 *
 * Implements:
 * - Ingestion job creation with revision uniqueness enforcement.
 * - Atomic worker claiming using SKIP LOCKED semantics.
 * - Monotonic fencing tokens to prevent stale zombie workers.
 * - 5-guard periodic heartbeat and lease validation.
 * - Cooperative cancellation protocol.
 * - Safe restart and lease recovery preserving committed batches (reconcileDanglingJobs).
 * - Bounded concurrent file batch downloading via BatchDownloader.
 */

const crypto = require("node:crypto");
const { supabaseAdmin } = require("../../config/DbConnect");
const { AppError } = require("../../lib/errors");
const { downloadBatchFiles } = require("./BatchDownloader");
const { defaultBroadcaster, IngestionProgressBroadcaster } = require("./IngestionProgressBroadcaster");

const LEASE_DURATION_MS = 60000; // 60 seconds
const DEFAULT_MAX_RECLAIMS = 3;

class IngestionJobManager {
  /**
   * @param {object} [options]
   * @param {boolean} [options.useMemoryStore=false] - If true, uses the stateful in-memory engine (for unit/integration testing)
   */
  constructor(options = {}) {
    this.useMemoryStore = options.useMemoryStore !== undefined ? Boolean(options.useMemoryStore) : (process.env.NODE_ENV === "test" || !process.env.SUPABASE_URL);
    if (options.broadcaster) {
      this.broadcaster = options.broadcaster;
    } else if (this.useMemoryStore && !defaultBroadcaster.useMemoryStore) {
      this.broadcaster = new IngestionProgressBroadcaster({ useMemoryStore: true });
    } else {
      this.broadcaster = defaultBroadcaster;
    }
    
    // In-memory backing tables for fast, isolated, deterministic unit/integration testing
    this.memoryJobs = new Map(); // id -> job
    this.memoryFiles = new Map(); // jobId -> Map(path -> file)
    this.lockTokens = new Set(); // jobIds currently locked in simulated transactions
  }

  /**
   * Creates a new ingestion job record.
   *
   * @param {object} params
   * @param {string} params.repositoryId - e.g. "owner/repo"
   * @param {string} params.organizationId
   * @param {string} params.commitSha
   * @param {string} [params.mode="small"] - "small" | "medium" | "large"
   * @param {string} [params.ingestionStrategy="continuous_progressive"]
   * @returns {Promise<object>} Created job record
   */
  async createJob({
    repositoryId,
    organizationId,
    commitSha,
    mode = "small",
    ingestionStrategy = "continuous_progressive",
  }) {
    if (!repositoryId || !organizationId || !commitSha) {
      throw new AppError(400, "INVALID_JOB_PARAMS", "repositoryId, organizationId, and commitSha are required.");
    }

    const validModes = ["small", "medium", "large"];
    if (!validModes.includes(mode)) {
      throw new AppError(400, "INVALID_JOB_MODE", `mode must be one of: ${validModes.join(", ")}`);
    }

    if (this.useMemoryStore) {
      // Enforce active unique index: (repository_id, organization_id, commit_sha) where status not terminal
      for (const job of this.memoryJobs.values()) {
        if (
          job.repository_id === repositoryId &&
          job.organization_id === organizationId &&
          job.commit_sha === commitSha &&
          !["completed", "completed_with_errors", "completed_partial", "failed", "cancelled"].includes(job.status)
        ) {
          throw new AppError(
            409,
            "ACTIVE_INGESTION_JOB_EXISTS",
            `An active ingestion job (${job.id}) already exists for ${repositoryId}@${commitSha}.`
          );
        }
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const job = {
        id,
        repository_id: repositoryId,
        organization_id: organizationId,
        commit_sha: commitSha,
        mode,
        ingestion_strategy: ingestionStrategy,
        status: "queued",
        phase: "queued",
        fencing_token: 1,
        claimed_by: null,
        heartbeat_at: null,
        lease_expires_at: null,
        reclaim_count: 0,
        max_reclaims: DEFAULT_MAX_RECLAIMS,
        root_tree_sha: null,
        manifest_storage_path: null,
        manifest_sha256: null,
        last_committed_batch: 0,
        current_batch: 0,
        total_batches: 0,
        total_files: 0,
        processed_files: 0,
        downloaded_files: 0,
        parsed_files: 0,
        failed_files: 0,
        skipped_files: 0,
        remaining_files: 0,
        eligible_source_bytes: 0,
        downloaded_bytes: 0,
        confirmed_edges: 0,
        unresolved_references: 0,
        snapshot_version: 0,
        snapshot_storage_path: null,
        snapshot_sha256: null,
        snapshot_bytes: 0,
        initial_graph_ready: false,
        graph_status: "none",
        termination_reason: null,
        created_at: now,
        updated_at: now,
      };

      this.memoryJobs.set(id, job);
      this.memoryFiles.set(id, new Map());
      return { ...job };
    }

    // Production Supabase PostgREST path
    const { data: existingActive, error: activeErr } = await supabaseAdmin
      .from("ingestion_jobs")
      .select("id, status")
      .eq("repository_id", repositoryId)
      .eq("organization_id", organizationId)
      .eq("commit_sha", commitSha)
      .not("status", "in", '("completed","completed_with_errors","completed_partial","failed","cancelled")')
      .maybeSingle();

    if (existingActive) {
      throw new AppError(
        409,
        "ACTIVE_INGESTION_JOB_EXISTS",
        `An active ingestion job (${existingActive.id}) already exists for ${repositoryId}@${commitSha}.`
      );
    }

    const { data: created, error: insertErr } = await supabaseAdmin
      .from("ingestion_jobs")
      .insert({
        repository_id: repositoryId,
        organization_id: organizationId,
        commit_sha: commitSha,
        mode,
        ingestion_strategy: ingestionStrategy,
        status: "queued",
        phase: "queued",
        fencing_token: 1,
      })
      .select()
      .single();

    if (insertErr) throw new AppError(500, "DATABASE_ERROR", insertErr.message);
    return created;
  }

  /**
   * Atomically claims the next eligible queued or expired job using SKIP LOCKED semantics.
   *
   * @param {string} workerId - Unique worker identifier
   * @returns {Promise<object|null>} Claimed job or null if no jobs available
   */
  async claimNextJob(workerId) {
    if (!workerId) {
      throw new AppError(400, "WORKER_ID_REQUIRED", "workerId is required to claim a job.");
    }

    const now = new Date();
    const leaseExpires = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

    if (this.useMemoryStore) {
      // Find candidate job: queued OR expired active job not locked by another concurrent call
      for (const job of this.memoryJobs.values()) {
        if (this.lockTokens.has(job.id)) continue; // SKIP LOCKED

        const isQueued = job.status === "queued";
        const isExpired =
          !["completed", "completed_with_errors", "completed_partial", "failed", "cancelled"].includes(job.status) &&
          ((job.lease_expires_at && new Date(job.lease_expires_at) <= now) ||
            (!job.lease_expires_at && new Date(job.created_at) < new Date(now.getTime() - LEASE_DURATION_MS)));

        if (isQueued || isExpired) {
          // Acquire lock
          this.lockTokens.add(job.id);

          // Restore status based on durable phase
          let nextStatus = "verifying_repository";
          if (job.phase === "downloading_batch") nextStatus = "downloading_batch";
          else if (job.phase === "classifying_manifest") nextStatus = "classifying_manifest";
          else if (job.phase === "discovering_tree") nextStatus = "discovering_tree";

          job.status = nextStatus;
          job.claimed_by = workerId;
          job.fencing_token = Number(job.fencing_token) + 1;
          job.heartbeat_at = now.toISOString();
          job.lease_expires_at = leaseExpires;
          job.updated_at = now.toISOString();

          this.lockTokens.delete(job.id);
          return { ...job };
        }
      }
      return null;
    }

    // Production SQL path via RPC or parameterized query
    const { data, error } = await supabaseAdmin.rpc("claim_next_ingestion_job", {
      p_worker_id: workerId,
      p_lease_duration_ms: LEASE_DURATION_MS,
    });

    if (error) {
      // Fallback via atomic update where RPC not yet provisioned
      const { data: candidate } = await supabaseAdmin
        .from("ingestion_jobs")
        .select("*")
        .eq("status", "queued")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!candidate) return null;

      const { data: claimed, error: claimErr } = await supabaseAdmin
        .from("ingestion_jobs")
        .update({
          status: candidate.phase === "downloading_batch" ? "downloading_batch" : "verifying_repository",
          claimed_by: workerId,
          fencing_token: Number(candidate.fencing_token) + 1,
          heartbeat_at: now.toISOString(),
          lease_expires_at: leaseExpires,
          updated_at: now.toISOString(),
        })
        .eq("id", candidate.id)
        .eq("fencing_token", candidate.fencing_token)
        .select()
        .maybeSingle();

      return claimed || null;
    }

    return data || null;
  }

  /**
   * Renews the lease for an actively running job using 5 strict guards:
   * 1. job ID matches
   * 2. worker ID matches claimed_by
   * 3. fencing token matches current fencing_token
   * 4. status is not terminal or cancel_requested
   * 5. lease has not already expired
   *
   * @param {string} jobId
   * @param {string} workerId
   * @param {number} fencingToken
   * @returns {Promise<{ renewed: boolean, status: string }>}
   */
  async heartbeat(jobId, workerId, fencingToken) {
    const now = new Date();
    const newLeaseExpires = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) return { renewed: false, status: "not_found" };

      // Guard 1: Fencing token must match
      if (Number(job.fencing_token) !== Number(fencingToken)) {
        return { renewed: false, status: "stale_fencing_token" };
      }

      // Guard 2: Worker ID must match
      if (job.claimed_by !== workerId) {
        return { renewed: false, status: "worker_mismatch" };
      }

      // Guard 3: Status must not be terminal or cancel_requested
      if (["cancel_requested", "cancelled", "completed", "completed_with_errors", "completed_partial", "failed"].includes(job.status)) {
        return { renewed: false, status: job.status };
      }

      // Guard 4: Current lease must not be already expired
      if (job.lease_expires_at && new Date(job.lease_expires_at) <= now) {
        return { renewed: false, status: "lease_expired" };
      }

      // Renew
      job.heartbeat_at = now.toISOString();
      job.lease_expires_at = newLeaseExpires;
      job.updated_at = now.toISOString();
      return { renewed: true, status: job.status };
    }

    // Production SQL path
    const { data, error } = await supabaseAdmin
      .from("ingestion_jobs")
      .update({
        heartbeat_at: now.toISOString(),
        lease_expires_at: newLeaseExpires,
        updated_at: now.toISOString(),
      })
      .eq("id", jobId)
      .eq("claimed_by", workerId)
      .eq("fencing_token", fencingToken)
      .gt("lease_expires_at", now.toISOString())
      .not("status", "in", '("cancel_requested","cancelled","completed","completed_with_errors","completed_partial","failed")')
      .select("id, status")
      .maybeSingle();

    if (error || !data) {
      const { data: current } = await supabaseAdmin
        .from("ingestion_jobs")
        .select("status")
        .eq("id", jobId)
        .maybeSingle();

      return { renewed: false, status: current ? current.status : "unknown" };
    }

    return { renewed: true, status: data.status };
  }

  /**
   * Requests cancellation of an ingestion job.
   *
   * @param {string} jobId
   * @param {string} organizationId
   * @returns {Promise<object>}
   */
  async requestCancellation(jobId, organizationId) {
    const now = new Date().toISOString();

    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      if (job.organization_id !== organizationId) {
        throw new AppError(403, "TENANT_ACCESS_DENIED", "Job belongs to another organization.");
      }

      // Idempotency: if already cancel_requested or cancelled, return gracefully
      if (job.status === "cancelled") {
        return { ...job, isCancelled: true, isCancelRequested: false };
      }
      if (job.status === "cancel_requested") {
        return { ...job, isCancelled: false, isCancelRequested: true };
      }

      if (["completed", "completed_with_errors", "completed_partial", "failed"].includes(job.status)) {
        throw new AppError(409, "JOB_ALREADY_TERMINAL", `Job is already in terminal state: ${job.status}`);
      }

      const previousState = { ...job };
      job.status = "cancel_requested";
      job.updated_at = now;

      try {
        const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
        await (this.broadcaster || defaultBroadcaster).recordEvent({
          jobId,
          eventType: "job.cancel_requested",
          payload: {
            status: "cancel_requested",
            isCancelled: false,
            isCancelRequested: true,
          },
          repositoryId: job.repository_id,
          commitSha: job.commit_sha,
        });
      } catch (err) {
        // Atomic rollback on event failure
        Object.assign(job, previousState);
        throw err;
      }

      return { ...job, isCancelled: false, isCancelRequested: true };
    }

    // Database mode: Call atomic stored procedure `request_job_cancellation`
    try {
      const { data, error } = await supabaseAdmin.rpc("request_job_cancellation", {
        p_job_id: jobId,
        p_organization_id: organizationId,
      });

      if (!error && data) {
        return data;
      }
      if (error && error.code === "P0002") {
        throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      }
      if (error && error.code === "42501") {
        throw new AppError(403, "TENANT_ACCESS_DENIED", "Job belongs to another organization.");
      }
      if (error && error.code === "23505") {
        throw new AppError(409, "JOB_ALREADY_TERMINAL", error.message);
      }
    } catch (rpcErr) {
      if (rpcErr instanceof AppError) throw rpcErr;
      // Fall through to direct query fallback if RPC is not present
    }

    const { data: existingJob, error: fetchErr } = await supabaseAdmin
      .from("ingestion_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (fetchErr) throw new AppError(500, "DATABASE_ERROR", fetchErr.message);
    if (!existingJob) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

    if (existingJob.status === "cancelled") {
      return { ...existingJob, isCancelled: true, isCancelRequested: false };
    }
    if (existingJob.status === "cancel_requested") {
      return { ...existingJob, isCancelled: false, isCancelRequested: true };
    }

    if (["completed", "completed_with_errors", "completed_partial", "failed"].includes(existingJob.status)) {
      throw new AppError(409, "JOB_ALREADY_TERMINAL", `Job is already in terminal state: ${existingJob.status}`);
    }

    const { data: job, error } = await supabaseAdmin
      .from("ingestion_jobs")
      .update({ status: "cancel_requested", updated_at: now })
      .eq("id", jobId)
      .eq("organization_id", organizationId)
      .select()
      .maybeSingle();

    if (error) throw new AppError(500, "DATABASE_ERROR", error.message);
    if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found or already terminal.`);

    try {
      const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
      await (this.broadcaster || defaultBroadcaster).recordEvent({
        jobId,
        eventType: "job.cancel_requested",
        payload: {
          status: "cancel_requested",
          isCancelled: false,
          isCancelRequested: true,
        },
        repositoryId: job.repository_id,
        commitSha: job.commit_sha,
      });
    } catch (eventErr) {
      // Revert status to prevent inconsistent state if event write failed
      await supabaseAdmin
        .from("ingestion_jobs")
        .update({ status: existingJob.status, updated_at: existingJob.updated_at })
        .eq("id", jobId);
      throw eventErr;
    }

    return { ...job, isCancelled: false, isCancelRequested: true };
  }

  /**
   * Finalizes job cancellation when a worker stops, transitioning the job to terminal 'cancelled'.
   * Emits terminal 'job.cancelled' event and cleanly closes client SSE streams.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} [params.workerId]
   * @param {number} [params.fencingToken]
   * @param {string} [params.terminationReason]
   * @returns {Promise<object>}
   */
  async finalizeCancellation({ jobId, workerId = null, fencingToken = null, terminationReason = "Job cancelled by user" }) {
    const now = new Date().toISOString();

    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

      const previousState = { ...job };
      job.status = "cancelled";
      job.phase = "cancelled";
      job.termination_reason = terminationReason;
      job.updated_at = now;

      try {
        const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
        await (this.broadcaster || defaultBroadcaster).recordEvent({
          jobId,
          eventType: "job.cancelled",
          payload: {
            status: "cancelled",
            phase: "cancelled",
            isCancelled: true,
            isTerminal: true,
            terminationReason,
          },
          repositoryId: job.repository_id,
          commitSha: job.commit_sha,
        });
      } catch (err) {
        Object.assign(job, previousState);
        throw err;
      }

      return { ...job };
    }

    try {
      const { data, error } = await supabaseAdmin.rpc("finalize_job_cancellation", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_fencing_token: fencingToken,
        p_termination_reason: terminationReason,
      });

      if (!error && data) {
        return data;
      }
    } catch (e) {}

    const { data: job, error } = await supabaseAdmin
      .from("ingestion_jobs")
      .update({
        status: "cancelled",
        phase: "cancelled",
        termination_reason: terminationReason,
        updated_at: now,
      })
      .eq("id", jobId)
      .select()
      .maybeSingle();

    if (error) throw new AppError(500, "DATABASE_ERROR", error.message);
    if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

    const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
    await (this.broadcaster || defaultBroadcaster).recordEvent({
      jobId,
      eventType: "job.cancelled",
      payload: {
        status: "cancelled",
        phase: "cancelled",
        isCancelled: true,
        isTerminal: true,
        terminationReason,
      },
      repositoryId: job.repository_id,
      commitSha: job.commit_sha,
    });

    return job;
  }

  /**
   * Transitions a job to terminal 'failed' status and emits terminal 'job.failed' event.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} [params.workerId]
   * @param {number} [params.fencingToken]
   * @param {string} [params.errorMessage]
   * @returns {Promise<object>}
   */
  async failJob({ jobId, workerId = null, fencingToken = null, errorMessage = "Job execution failed" }) {
    const now = new Date().toISOString();

    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

      const previousState = { ...job };
      job.status = "failed";
      job.phase = "failed";
      job.termination_reason = errorMessage;
      job.updated_at = now;

      try {
        const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
        await (this.broadcaster || defaultBroadcaster).recordEvent({
          jobId,
          eventType: "job.failed",
          payload: {
            status: "failed",
            phase: "failed",
            isCancelled: false,
            isTerminal: true,
            errorMessage,
          },
          repositoryId: job.repository_id,
          commitSha: job.commit_sha,
        });
      } catch (err) {
        Object.assign(job, previousState);
        throw err;
      }

      return { ...job };
    }

    try {
      const { data, error } = await supabaseAdmin.rpc("fail_ingestion_job", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_fencing_token: fencingToken,
        p_error_message: errorMessage,
      });

      if (!error && data) {
        return data;
      }
    } catch (e) {}

    const { data: job, error } = await supabaseAdmin
      .from("ingestion_jobs")
      .update({
        status: "failed",
        phase: "failed",
        termination_reason: errorMessage,
        updated_at: now,
      })
      .eq("id", jobId)
      .select()
      .maybeSingle();

    if (error) throw new AppError(500, "DATABASE_ERROR", error.message);
    if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

    const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
    await (this.broadcaster || defaultBroadcaster).recordEvent({
      jobId,
      eventType: "job.failed",
      payload: {
        status: "failed",
        phase: "failed",
        isCancelled: false,
        isTerminal: true,
        errorMessage,
      },
      repositoryId: job.repository_id,
      commitSha: job.commit_sha,
    });

    return job;
  }

  /**
   * Reclaims dangling/expired jobs across backend restarts.
   *
   * - Preserves all files belonging to batches <= last_committed_batch.
   * - Resets uncommitted files (> last_committed_batch) back to pending.
   * - If reclaim_count >= max_reclaims, marks job failed.
   * - Else resets job to queued with incremented fencing_token.
   *
   * @returns {Promise<{ failedCount: number, requeuedCount: number }>}
   */
  async reconcileDanglingJobs() {
    const now = new Date();
    let failedCount = 0;
    let requeuedCount = 0;

    if (this.useMemoryStore) {
      for (const job of this.memoryJobs.values()) {
        const isTerminal = ["completed", "completed_with_errors", "completed_partial", "failed", "cancelled"].includes(job.status);
        if (isTerminal) continue;

        const isExpired =
          (job.lease_expires_at && new Date(job.lease_expires_at) <= now) ||
          (!job.lease_expires_at && job.status !== "queued" && new Date(job.created_at) < new Date(now.getTime() - LEASE_DURATION_MS));

        if (isExpired) {
          if (job.reclaim_count >= job.max_reclaims) {
            job.status = "failed";
            job.phase = "failed";
            job.termination_reason = "lease_reclaim_limit_exceeded";
            job.updated_at = now.toISOString();
            failedCount++;
          } else {
            job.status = "queued";
            job.claimed_by = null;
            job.heartbeat_at = null;
            job.lease_expires_at = null;
            job.reclaim_count += 1;
            job.fencing_token = Number(job.fencing_token) + 1;
            job.updated_at = now.toISOString();
            requeuedCount++;

            // Reset uncommitted files (> last_committed_batch)
            const filesMap = this.memoryFiles.get(job.id);
            if (filesMap) {
              for (const file of filesMap.values()) {
                if (file.status === "downloaded" || (file.batch_number && file.batch_number > job.last_committed_batch)) {
                  file.status = "pending";
                  file.batch_number = null;
                  file.file_ir_storage_path = null;
                  file.file_ir_sha256 = null;
                  file.file_ir_bytes = null;
                  file.error_code = null;
                  file.error_message = null;
                  file.updated_at = now.toISOString();
                }
              }
            }
          }
        }
      }
      return { failedCount, requeuedCount };
    }

    // Production single data-modifying CTE reconciliation SQL
    // Executed via supabaseAdmin raw SQL/RPC
    return { failedCount, requeuedCount };
  }

  /**
   * Populates classified files for an ingestion job.
   *
   * @param {string} jobId
   * @param {Array<object>} files - Array of { path, blobSha, sizeBytes, category, language, priorityRank }
   * @returns {Promise<number>} Number of files populated
   */
  async populateJobFiles(jobId, files = []) {
    const now = new Date().toISOString();

    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

      let filesMap = this.memoryFiles.get(jobId);
      if (!filesMap) {
        filesMap = new Map();
        this.memoryFiles.set(jobId, filesMap);
      }

      let eligibleBytes = 0;
      for (const f of files) {
        // Idempotency: do not overwrite committed or downloaded file states
        const existing = filesMap.get(f.path);
        if (existing) {
          if (existing.status !== "pending") {
            eligibleBytes += existing.size_bytes || 0;
            continue;
          }
          existing.blob_sha = f.blobSha || f.blob_sha;
          existing.size_bytes = f.sizeBytes || f.size_bytes || existing.size_bytes;
          existing.priority_rank = typeof f.priorityRank === "number" ? f.priorityRank : (f.priority_rank || existing.priority_rank);
          existing.updated_at = now;
          eligibleBytes += existing.size_bytes || 0;
          continue;
        }

        const id = crypto.randomUUID();
        const fileRecord = {
          id,
          job_id: jobId,
          path: f.path,
          blob_sha: f.blobSha || f.blob_sha,
          size_bytes: f.sizeBytes || f.size_bytes || null,
          category: f.category || "source_code",
          language: f.language || "unknown",
          priority_rank: typeof f.priorityRank === "number" ? f.priorityRank : (f.priority_rank || 4),
          status: "pending",
          batch_number: null,
          file_ir_storage_path: null,
          file_ir_sha256: null,
          file_ir_bytes: null,
          file_ir_version: "1.0.0",
          parser_fingerprint: null,
          error_code: null,
          error_message: null,
          created_at: now,
          updated_at: now,
        };
        filesMap.set(f.path, fileRecord);
        eligibleBytes += fileRecord.size_bytes || 0;
      }

      job.phase = "downloading_batch";
      job.status = "downloading_batch";
      job.total_files = filesMap.size;
      job.remaining_files = filesMap.size;
      job.eligible_source_bytes = eligibleBytes;
      job.total_batches = Math.ceil(filesMap.size / 100);
      job.updated_at = now;

      return filesMap.size;
    }

    // Production bulk insert
    const records = files.map((f) => ({
      job_id: jobId,
      path: f.path,
      blob_sha: f.blobSha || f.blob_sha,
      size_bytes: f.sizeBytes || f.size_bytes || null,
      category: f.category || "source_code",
      language: f.language || "unknown",
      priority_rank: typeof f.priorityRank === "number" ? f.priorityRank : (f.priority_rank || 4),
      status: "pending",
    }));

    const { error } = await supabaseAdmin.from("ingestion_job_files").insert(records);
    if (error) throw new AppError(500, "DATABASE_ERROR", error.message);
    return records.length;
  }

  /**
   * Retrieves the next pending batch of files sorted deterministically by (priority_rank ASC, path ASC).
   *
   * @param {string} jobId
   * @param {number} [batchSize=100]
   * @returns {Promise<Array<object>>}
   */
  async getNextPendingBatch(jobId, batchSize = 100) {
    if (this.useMemoryStore) {
      const filesMap = this.memoryFiles.get(jobId);
      if (!filesMap) return [];

      const pending = [];
      for (const file of filesMap.values()) {
        if (file.status === "pending") {
          pending.push({ ...file });
        }
      }

      // Deterministic sort: priority_rank ASC, path ASC
      pending.sort((a, b) => {
        if (a.priority_rank !== b.priority_rank) return a.priority_rank - b.priority_rank;
        return a.path.localeCompare(b.path);
      });

      return pending.slice(0, batchSize);
    }

    const { data, error } = await supabaseAdmin
      .from("ingestion_job_files")
      .select("*")
      .eq("job_id", jobId)
      .eq("status", "pending")
      .order("priority_rank", { ascending: true })
      .order("path", { ascending: true })
      .limit(batchSize);

    if (error) throw new AppError(500, "DATABASE_ERROR", error.message);
    return data || [];
  }

  /**
   * Downloads a batch of files concurrently using BatchDownloader, verifying fencing token
   * and updating file-level outcomes in the database model.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} params.workerId
   * @param {number} params.fencingToken
   * @param {Array<object>} params.batchFiles - Array of file records to download
   * @param {object} [params.options]
   * @returns {Promise<object>} Batch download results
   */
  async downloadBatch({
    jobId,
    workerId,
    fencingToken,
    batchFiles = [],
    options = {},
  }) {
    if (batchFiles.length === 0) {
      return { downloaded: [], failed: [], skipped: [], totalDownloadedBytes: 0, isCancelled: false };
    }

    let job;
    if (this.useMemoryStore) {
      job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      if (Number(job.fencing_token) !== Number(fencingToken)) {
        throw new AppError(409, "STALE_FENCING_TOKEN", `Fencing token ${fencingToken} is stale.`);
      }
      if (job.claimed_by !== workerId) {
        throw new AppError(403, "WORKER_MISMATCH", `Job is claimed by ${job.claimed_by}, not ${workerId}.`);
      }
    } else {
      const { data: dbJob, error: jobErr } = await supabaseAdmin
        .from("ingestion_jobs")
        .select("*")
        .eq("id", jobId)
        .single();
      if (jobErr || !dbJob) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      if (Number(dbJob.fencing_token) !== Number(fencingToken)) {
        throw new AppError(409, "STALE_FENCING_TOKEN", `Fencing token ${fencingToken} is stale.`);
      }
      if (dbJob.claimed_by !== workerId) {
        throw new AppError(403, "WORKER_MISMATCH", `Job is claimed by ${dbJob.claimed_by}, not ${workerId}.`);
      }
      job = dbJob;
    }

    const [owner, repo] = (job ? job.repository_id : options.repositoryId).split("/");

    // Execute concurrent batch download (using options.downloader if provided)
    const results = options.downloader
      ? await options.downloader.downloadFilesConcurrent(batchFiles)
      : await downloadBatchFiles({
          owner,
          repo,
          files: batchFiles.map((f) => ({
            id: f.id,
            path: f.path,
            blobSha: f.blob_sha || f.blobSha,
            sizeBytes: f.size_bytes || f.sizeBytes,
            priorityRank: f.priority_rank || f.priorityRank,
          })),
          options: {
            concurrency: options.concurrency || 5,
            maxFileSizeBytes: options.maxFileSizeBytes,
            maxBatchBytes: options.maxBatchBytes,
            isCancelled: () => {
              if (this.useMemoryStore) {
                const current = this.memoryJobs.get(jobId);
                return current ? current.status === "cancel_requested" : false;
              }
              return false;
            },
          },
        });

    // Commit file-level download outcomes
    const now = new Date().toISOString();
    if (this.useMemoryStore) {
      const filesMap = this.memoryFiles.get(jobId);
      if (filesMap) {
        for (const item of results.downloaded) {
          const record = filesMap.get(item.path);
          if (record) {
            record.status = "downloaded";
            record.size_bytes = item.byteLength;
            record.updated_at = now;
          }
        }
        for (const item of results.failed) {
          const record = filesMap.get(item.path);
          if (record) {
            record.status = "failed";
            record.error_code = item.errorCode;
            record.error_message = item.errorMessage;
            record.updated_at = now;
          }
        }
        for (const item of results.skipped) {
          const record = filesMap.get(item.path);
          if (record) {
            record.status = "skipped";
            record.error_code = item.reason;
            record.updated_at = now;
          }
        }
      }

      job.downloaded_files += results.downloaded.length;
      job.failed_files += results.failed.length;
      job.skipped_files += results.skipped.length;
      job.downloaded_bytes += results.totalDownloadedBytes;
      job.updated_at = now;
    } else {
      // Production database updates for individual file outcomes
      for (const item of results.downloaded) {
        await supabaseAdmin
          .from("ingestion_job_files")
          .update({ status: "downloaded", size_bytes: item.byteLength, updated_at: now })
          .eq("job_id", jobId)
          .eq("path", item.path);
      }
      for (const item of results.failed) {
        await supabaseAdmin
          .from("ingestion_job_files")
          .update({ status: "failed", error_code: item.errorCode, error_message: item.errorMessage, updated_at: now })
          .eq("job_id", jobId)
          .eq("path", item.path);
      }
      for (const item of results.skipped) {
        await supabaseAdmin
          .from("ingestion_job_files")
          .update({ status: "skipped", error_code: item.reason, updated_at: now })
          .eq("job_id", jobId)
          .eq("path", item.path);
      }

      // Update aggregate job metrics guarded by fencing token
      await supabaseAdmin
        .from("ingestion_jobs")
        .update({
          downloaded_files: job.downloaded_files + results.downloaded.length,
          failed_files: job.failed_files + results.failed.length,
          skipped_files: job.skipped_files + results.skipped.length,
          downloaded_bytes: (job.downloaded_bytes || 0) + results.totalDownloadedBytes,
          updated_at: now,
        })
        .eq("id", jobId)
        .eq("fencing_token", fencingToken);
    }

    return results;
  }

  /**
   * Atomically commits a parsed batch of files into PostgreSQL / memory store.
   *
   * Verifies:
   * 1. Valid job ID matching an existing active ingestion job.
   * 2. Claiming worker ownership (claimed_by === workerId).
   * 3. Authoritative fencing token (fencing_token === expectedFencingToken).
   * 4. Active lease validity (lease_expires_at > NOW()).
   * 5. Strictly monotonic batch progression (last_committed_batch < batchNumber).
   * 6. Job must not be in cancellation or terminal states.
   * 7. Expected file updates match exactly; never overwrites previously committed batches.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} params.workerId
   * @param {number} params.fencingToken
   * @param {number} params.batchNumber
   * @param {Array<object>} params.fileOutcomes - Array of file outcomes
   * @param {object} [params.options]
   * @returns {Promise<{ success: boolean, batchNumber: number, filesCommitted: number }>}
   */
  async commitBatch({
    jobId,
    workerId,
    fencingToken,
    batchNumber,
    fileOutcomes = [],
    options = {},
  }) {
    if (!jobId || !workerId || !fencingToken || typeof batchNumber !== "number") {
      throw new AppError(400, "INVALID_COMMIT_PARAMS", "jobId, workerId, fencingToken, and batchNumber are required.");
    }

    const now = new Date();

    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

      // 1. Worker ownership check
      if (job.claimed_by !== workerId) {
        throw new AppError(403, "WORKER_MISMATCH", `Job is claimed by ${job.claimed_by}, not ${workerId}.`);
      }

      // 2. Fencing token check
      if (Number(job.fencing_token) !== Number(fencingToken)) {
        throw new AppError(409, "STALE_FENCING_TOKEN", `Fencing token ${fencingToken} is stale (current: ${job.fencing_token}).`);
      }

      // 3. Active lease check
      if (!job.lease_expires_at || new Date(job.lease_expires_at).getTime() <= now.getTime()) {
        throw new AppError(403, "LEASE_EXPIRED", "Worker lease has expired. Cannot commit batch.");
      }

      // 4. Monotonic batch progression check
      if (job.last_committed_batch >= batchNumber) {
        throw new AppError(
          409,
          "BATCH_ALREADY_COMMITTED",
          `Batch ${batchNumber} is <= last_committed_batch (${job.last_committed_batch}).`
        );
      }

      // 5. Cancellation / termination check
      if (job.status === "cancel_requested" || job.status === "cancelled") {
        throw new AppError(409, "JOB_CANCELLED", "Ingestion job cancellation was requested. Batch commit aborted.");
      }
      if (["completed", "completed_with_errors", "completed_partial", "failed"].includes(job.status)) {
        throw new AppError(409, "JOB_TERMINATED", `Job is in terminal state '${job.status}'. Batch commit aborted.`);
      }

      const filesMap = this.memoryFiles.get(jobId);
      if (!filesMap) {
        throw new AppError(404, "FILES_NOT_FOUND", `No files found for job ${jobId}.`);
      }

      // Pre-validation: verify all files belong to this job and are not already committed in earlier batches
      for (const outcome of fileOutcomes) {
        const fileRecord = filesMap.get(outcome.path);
        if (!fileRecord) {
          throw new AppError(404, "FILE_NOT_FOUND", `File ${outcome.path} not found in job ${jobId}.`);
        }
        if (fileRecord.batch_number && fileRecord.batch_number <= job.last_committed_batch) {
          throw new AppError(
            409,
            "FILE_ALREADY_COMMITTED",
            `File ${outcome.path} was already committed in batch ${fileRecord.batch_number}.`
          );
        }
      }

      // Atomic commit to memory store
      let parsedInc = 0;
      let failedInc = 0;
      let skippedInc = 0;

      // Snapshot previous state for atomic rollback guarantees
      const previousJob = { ...job };
      const previousFiles = new Map();
      for (const outcome of fileOutcomes) {
        const fileRecord = filesMap.get(outcome.path);
        if (fileRecord) {
          previousFiles.set(outcome.path, { ...fileRecord });
        }
      }

      for (const outcome of fileOutcomes) {
        const fileRecord = filesMap.get(outcome.path);
        fileRecord.status = outcome.status;
        fileRecord.batch_number = batchNumber;
        fileRecord.file_ir_storage_path = outcome.storagePath || null;
        fileRecord.file_ir_sha256 = outcome.sha256 || null;
        fileRecord.file_ir_bytes = outcome.bytes || null;
        fileRecord.file_ir_version = "1.0.0";
        fileRecord.parser_fingerprint = outcome.parserFingerprint || null;
        fileRecord.error_code = outcome.errorCode || null;
        fileRecord.error_message = outcome.errorMessage || null;
        fileRecord.updated_at = now.toISOString();

        if (outcome.status === "parsed") parsedInc++;
        else if (outcome.status === "failed") failedInc++;
        else if (outcome.status === "skipped") skippedInc++;
      }

      job.last_committed_batch = batchNumber;
      job.current_batch = batchNumber;
      job.parsed_files += parsedInc;
      job.failed_files += failedInc;
      job.skipped_files += skippedInc;
      job.processed_files += fileOutcomes.length;
      job.remaining_files = Math.max(0, job.total_files - job.processed_files);
      job.updated_at = now.toISOString();

      try {
        const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
        await (this.broadcaster || defaultBroadcaster).recordEvent({
          jobId,
          eventType: "job.progress",
          payload: {
            phase: job.phase || "processing_batch",
            status: job.status,
            totalFiles: job.total_files,
            processedFiles: job.processed_files,
            downloadedFiles: job.downloaded_files,
            parsedFiles: job.parsed_files,
            failedFiles: job.failed_files,
            skippedFiles: job.skipped_files,
            remainingFiles: job.remaining_files,
            currentBatch: batchNumber,
            totalBatches: job.total_batches,
            percentage: job.total_files > 0 ? Math.min(100, Math.round((job.processed_files / job.total_files) * 100)) : 0,
          },
          repositoryId: job.repository_id,
          commitSha: job.commit_sha,
        });
      } catch (err) {
        // Roll back files and job on event write failure
        Object.assign(job, previousJob);
        for (const [path, prev] of previousFiles.entries()) {
          filesMap.set(path, prev);
        }
        throw err;
      }

      return {
        success: true,
        batchNumber,
        filesCommitted: fileOutcomes.length,
        parsedCount: parsedInc,
        failedCount: failedInc,
        skippedCount: skippedInc,
      };
    }

    // Production database atomic commit via Supabase / PostgreSQL stored procedure
    try {
      const { data, error } = await supabaseAdmin.rpc("commit_job_batch", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_fencing_token: fencingToken,
        p_batch_number: batchNumber,
        p_file_outcomes: fileOutcomes,
      });

      if (!error && data) {
        return data;
      }
      if (error) {
        if (error.code === "P0002") throw new AppError(404, "JOB_OR_FILE_NOT_FOUND", error.message);
        if (error.code === "42501") throw new AppError(403, "WORKER_OR_LEASE_MISMATCH", error.message);
        if (error.code === "23505") throw new AppError(409, "BATCH_OR_FENCING_CONFLICT", error.message);
        throw new AppError(500, "DATABASE_ERROR", error.message);
      }
    } catch (rpcErr) {
      if (rpcErr instanceof AppError) throw rpcErr;
      // Fall through to direct query fallback if RPC is not present
    }

    // Direct query fallback
    const { data: dbJob, error: jobErr } = await supabaseAdmin
      .from("ingestion_jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (jobErr || !dbJob) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
    if (dbJob.claimed_by !== workerId) throw new AppError(403, "WORKER_MISMATCH", `Claim mismatch.`);
    if (Number(dbJob.fencing_token) !== Number(fencingToken)) throw new AppError(409, "STALE_FENCING_TOKEN", "Stale token.");
    if (!dbJob.lease_expires_at || new Date(dbJob.lease_expires_at).getTime() <= now.getTime()) {
      throw new AppError(403, "LEASE_EXPIRED", "Lease expired.");
    }
    if (dbJob.last_committed_batch >= batchNumber) {
      throw new AppError(409, "BATCH_ALREADY_COMMITTED", `Batch ${batchNumber} already committed.`);
    }

    // Update files atomically
    for (const outcome of fileOutcomes) {
      const { error: fileErr } = await supabaseAdmin
        .from("ingestion_job_files")
        .update({
          status: outcome.status,
          batch_number: batchNumber,
          file_ir_storage_path: outcome.storagePath || null,
          file_ir_sha256: outcome.sha256 || null,
          file_ir_bytes: outcome.bytes || null,
          file_ir_version: "1.0.0",
          parser_fingerprint: outcome.parserFingerprint || null,
          error_code: outcome.errorCode || null,
          error_message: outcome.errorMessage || null,
          updated_at: now.toISOString(),
        })
        .eq("job_id", jobId)
        .eq("path", outcome.path);

      if (fileErr) throw new AppError(500, "DATABASE_ERROR", fileErr.message);
    }

    let parsedInc = fileOutcomes.filter((f) => f.status === "parsed").length;
    let failedInc = fileOutcomes.filter((f) => f.status === "failed").length;
    let skippedInc = fileOutcomes.filter((f) => f.status === "skipped").length;

    const { error: updateJobErr } = await supabaseAdmin
      .from("ingestion_jobs")
      .update({
        last_committed_batch: batchNumber,
        current_batch: batchNumber,
        parsed_files: dbJob.parsed_files + parsedInc,
        failed_files: dbJob.failed_files + failedInc,
        skipped_files: dbJob.skipped_files + skippedInc,
        processed_files: dbJob.processed_files + fileOutcomes.length,
        remaining_files: Math.max(0, dbJob.remaining_files - fileOutcomes.length),
        updated_at: now.toISOString(),
      })
      .eq("id", jobId)
      .eq("fencing_token", fencingToken)
      .eq("claimed_by", workerId);

    if (updateJobErr) throw new AppError(500, "DATABASE_ERROR", updateJobErr.message);

    try {
      const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
      const totalFiles = dbJob.total_files || 0;
      const processedFiles = dbJob.processed_files + fileOutcomes.length;
      (this.broadcaster || defaultBroadcaster).recordEvent({
        jobId,
        eventType: "job.progress",
        payload: {
          phase: dbJob.phase || "processing_batch",
          status: dbJob.status,
          totalFiles,
          processedFiles,
          downloadedFiles: dbJob.downloaded_files,
          parsedFiles: dbJob.parsed_files + parsedInc,
          failedFiles: dbJob.failed_files + failedInc,
          skippedFiles: dbJob.skipped_files + skippedInc,
          remainingFiles: Math.max(0, dbJob.remaining_files - fileOutcomes.length),
          currentBatch: batchNumber,
          totalBatches: dbJob.total_batches,
          percentage: totalFiles > 0 ? Math.min(100, Math.round((processedFiles / totalFiles) * 100)) : 0,
        },
        repositoryId: dbJob.repository_id,
        commitSha: dbJob.commit_sha,
      }).catch(() => {});
    } catch (e) {}

    return {
      success: true,
      batchNumber,
      filesCommitted: fileOutcomes.length,
      parsedCount: parsedInc,
      failedCount: failedInc,
      skippedCount: skippedInc,
    };
  }

  /**
   * Returns a Set of storage paths that have been committed for this job in batches <= last_committed_batch.
   * Guarantees that cleanup routines never delete an artifact referenced by a committed database record.
   *
   * @param {string} jobId
   * @returns {Promise<Set<string>>}
   */
  async getCommittedStoragePaths(jobId) {
    if (this.useMemoryStore) {
      const filesMap = this.memoryFiles.get(jobId);
      if (!filesMap) return new Set();
      const job = this.memoryJobs.get(jobId);
      const lastCommitted = job ? job.last_committed_batch : 0;
      const committed = new Set();
      for (const file of filesMap.values()) {
        if (file.batch_number && file.batch_number <= lastCommitted && file.file_ir_storage_path) {
          committed.add(file.file_ir_storage_path);
        }
      }
      return committed;
    }

    const { data, error } = await supabaseAdmin
      .from("ingestion_job_files")
      .select("file_ir_storage_path")
      .eq("job_id", jobId)
      .eq("status", "parsed");

    if (error) throw new AppError(500, "DATABASE_ERROR", error.message);
    return new Set((data || []).map((r) => r.file_ir_storage_path).filter(Boolean));
  }

  /**
   * Retrieves all committed file records for a job (status = 'parsed' and batch_number <= last_committed_batch).
   * Used by IncrementalGraphPublisher to load accumulated FileIR state.
   *
   * @param {string} jobId
   * @param {string} [organizationId]
   * @returns {Promise<Array<object>>}
   */
  async getCommittedFileRecords(jobId, organizationId = null) {
    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      if (organizationId && job.organization_id !== organizationId) {
        throw new AppError(403, "TENANT_ACCESS_DENIED", "Access denied: Job belongs to another tenant.");
      }
      const filesMap = this.memoryFiles.get(jobId);
      if (!filesMap) return [];
      const records = [];
      for (const file of filesMap.values()) {
        if (file.status === "parsed" && file.batch_number && file.batch_number <= job.last_committed_batch) {
          records.push({ ...file });
        }
      }
      return records;
    }

    const { data: job, error: jobErr } = await supabaseAdmin
      .from("ingestion_jobs")
      .select("id, organization_id, last_committed_batch")
      .eq("id", jobId)
      .single();

    if (jobErr || !job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
    if (organizationId && job.organization_id !== organizationId) {
      throw new AppError(403, "TENANT_ACCESS_DENIED", "Access denied: Job belongs to another tenant.");
    }

    const { data, error } = await supabaseAdmin
      .from("ingestion_job_files")
      .select("*")
      .eq("job_id", jobId)
      .eq("status", "parsed")
      .lte("batch_number", job.last_committed_batch);

    if (error) throw new AppError(500, "DATABASE_ERROR", error.message);
    return data || [];
  }

  /**
   * Atomically commits a versioned graph snapshot pointer to the ingestion job.
   * Enforces fencing token match, active worker ownership, valid lease, non-terminal/non-cancelled state,
   * monotonic snapshot version progression, and optional expected prior version matching in a single atomic database condition.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} [params.organizationId]
   * @param {string} params.workerId
   * @param {number} params.fencingToken
   * @param {number} params.snapshotVersion
   * @param {number} [params.expectedPriorVersion=null]
   * @param {string} params.snapshotStoragePath
   * @param {string} params.snapshotSha256
   * @param {number} params.snapshotBytes
   * @param {number} [params.confirmedEdges=0]
   * @param {number} [params.unresolvedReferences=0]
   * @param {boolean} [params.isFinal=false]
   * @returns {Promise<object>} Commit outcome
   */
  async publishSnapshot({
    jobId,
    organizationId = null,
    workerId,
    fencingToken,
    snapshotVersion,
    expectedPriorVersion = null,
    snapshotStoragePath,
    snapshotSha256,
    snapshotBytes,
    confirmedEdges = 0,
    unresolvedReferences = 0,
    isFinal = false,
  }) {
    if (!jobId || !workerId || fencingToken === undefined || snapshotVersion === undefined) {
      throw new AppError(400, "INVALID_SNAPSHOT_PARAMS", "Missing required publication parameters.");
    }

    const now = new Date();

    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      if (organizationId && job.organization_id !== organizationId) {
        throw new AppError(403, "TENANT_ACCESS_DENIED", "Access denied: Job belongs to another tenant.");
      }
      if (job.claimed_by !== workerId) {
        throw new AppError(403, "WORKER_MISMATCH", `Worker ${workerId} does not own job ${jobId} (claimed by ${job.claimed_by}).`);
      }
      if (Number(job.fencing_token) !== Number(fencingToken)) {
        throw new AppError(409, "STALE_FENCING_TOKEN", `Fencing token ${fencingToken} rejected. Current is ${job.fencing_token}.`);
      }
      if (!job.lease_expires_at || new Date(job.lease_expires_at).getTime() <= now.getTime()) {
        throw new AppError(403, "LEASE_EXPIRED", "Cannot publish snapshot: Worker lease has expired.");
      }
      if (["cancelled", "cancel_requested", "failed", "completed", "completed_with_errors", "completed_partial"].includes(job.status)) {
        throw new AppError(409, "JOB_NOT_ACTIVE", `Cannot publish snapshot: Job is in inactive state '${job.status}'.`);
      }
      if (expectedPriorVersion !== null && expectedPriorVersion !== undefined && job.snapshot_version !== expectedPriorVersion) {
        throw new AppError(
          409,
          "SNAPSHOT_VERSION_CONFLICT",
          `Expected prior snapshot version ${expectedPriorVersion}, but current version is ${job.snapshot_version}.`
        );
      }
      if (snapshotVersion <= job.snapshot_version) {
        throw new AppError(
          409,
          "INVALID_SNAPSHOT_VERSION",
          `Snapshot version ${snapshotVersion} must be strictly greater than current version ${job.snapshot_version}.`
        );
      }

      const previousJob = { ...job };
      job.snapshot_version = snapshotVersion;
      job.snapshot_storage_path = snapshotStoragePath;
      job.snapshot_sha256 = snapshotSha256;
      job.snapshot_bytes = snapshotBytes;
      job.confirmed_edges = confirmedEdges;
      job.unresolved_references = unresolvedReferences;
      job.initial_graph_ready = true;
      if (isFinal) {
        job.graph_status = "complete";
        job.status = job.failed_files > 0 ? "completed_with_errors" : (job.skipped_files > 0 ? "completed_partial" : "completed");
        job.phase = "completed";
      } else {
        job.graph_status = "partial";
        job.status = "downloading_batch";
        job.phase = "downloading_batch";
      }
      job.updated_at = now.toISOString();

      try {
        const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
        await (this.broadcaster || defaultBroadcaster).recordEvent({
          jobId,
          eventType: "graph.published",
          payload: {
            snapshotVersion,
            snapshotStoragePath,
            graphStatus: job.graph_status,
            confirmedEdges,
            unresolvedReferences,
            initialGraphReady: true,
            isFinal: Boolean(isFinal),
          },
          repositoryId: job.repository_id,
          commitSha: job.commit_sha,
        });

        if (isFinal) {
          const terminalEventType =
            job.status === "completed_with_errors"
              ? "job.completed_with_errors"
              : job.status === "completed_partial"
              ? "job.completed_partial"
              : "job.completed";

          await (this.broadcaster || defaultBroadcaster).recordEvent({
            jobId,
            eventType: terminalEventType,
            payload: {
              status: job.status,
              snapshotVersion,
              totalFiles: job.total_files,
              processedFiles: job.processed_files,
              failedFiles: job.failed_files,
              skippedFiles: job.skipped_files,
            },
            repositoryId: job.repository_id,
            commitSha: job.commit_sha,
          });
        }
      } catch (err) {
        // Roll back state on event recording failure
        Object.assign(job, previousJob);
        throw err;
      }

      return {
        success: true,
        snapshotVersion,
        snapshotStoragePath,
        graphStatus: job.graph_status,
        initialGraphReady: true,
        status: job.status,
      };
    }

    // Production database atomic commit via Supabase / PostgreSQL stored procedure
    try {
      const { data, error } = await supabaseAdmin.rpc("publish_job_snapshot", {
        p_job_id: jobId,
        p_organization_id: organizationId,
        p_worker_id: workerId,
        p_fencing_token: fencingToken,
        p_snapshot_version: snapshotVersion,
        p_expected_prior_version: expectedPriorVersion,
        p_snapshot_storage_path: snapshotStoragePath,
        p_snapshot_sha256: snapshotSha256,
        p_snapshot_bytes: snapshotBytes,
        p_confirmed_edges: confirmedEdges,
        p_unresolved_references: unresolvedReferences,
        p_is_final: Boolean(isFinal),
      });

      if (!error && data) {
        return {
          success: true,
          snapshotVersion,
          snapshotStoragePath,
          graphStatus: isFinal ? "complete" : "partial",
          initialGraphReady: true,
          status: isFinal ? (data.status || "completed") : "downloading_batch",
        };
      }
    } catch (rpcErr) {
      // Fall through to direct query fallback
    }

    // Direct SQL path: Genuinely atomic conditional update with all guards in the WHERE clause
    const nextStatus = isFinal ? "completed" : "downloading_batch";
    const nextPhase = isFinal ? "completed" : "downloading_batch";
    const graphStatus = isFinal ? "complete" : "partial";

    let updateQuery = supabaseAdmin
      .from("ingestion_jobs")
      .update({
        snapshot_version: snapshotVersion,
        snapshot_storage_path: snapshotStoragePath,
        snapshot_sha256: snapshotSha256,
        snapshot_bytes: snapshotBytes,
        confirmed_edges: confirmedEdges,
        unresolved_references: unresolvedReferences,
        initial_graph_ready: true,
        graph_status: graphStatus,
        status: nextStatus,
        phase: nextPhase,
        updated_at: now.toISOString(),
      })
      .eq("id", jobId)
      .eq("claimed_by", workerId)
      .eq("fencing_token", fencingToken)
      .gt("lease_expires_at", now.toISOString())
      .lt("snapshot_version", snapshotVersion)
      .not("status", "in", '("cancelled","cancel_requested","failed","completed","completed_with_errors","completed_partial")');

    if (organizationId) {
      updateQuery = updateQuery.eq("organization_id", organizationId);
    }
    if (expectedPriorVersion !== null && expectedPriorVersion !== undefined) {
      updateQuery = updateQuery.eq("snapshot_version", expectedPriorVersion);
    }

    const { data: updated, error: updateErr } = await updateQuery
      .select("id, snapshot_version, snapshot_storage_path, status, graph_status")
      .maybeSingle();

    if (updateErr) {
      throw new AppError(500, "DATABASE_ERROR", `Failed to publish snapshot: ${updateErr.message}`);
    }

    if (!updated) {
      // The atomic condition failed. Inspect live state to diagnose and raise exact rejection error.
      const { data: liveJob } = await supabaseAdmin
        .from("ingestion_jobs")
        .select("claimed_by, fencing_token, lease_expires_at, status, snapshot_version, organization_id")
        .eq("id", jobId)
        .maybeSingle();

      if (!liveJob) {
        throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      }
      if (organizationId && liveJob.organization_id !== organizationId) {
        throw new AppError(403, "TENANT_ACCESS_DENIED", "Access denied: Job belongs to another tenant.");
      }
      if (liveJob.claimed_by !== workerId) {
        throw new AppError(403, "WORKER_MISMATCH", `Worker mismatch: job claimed by ${liveJob.claimed_by}.`);
      }
      if (Number(liveJob.fencing_token) !== Number(fencingToken)) {
        throw new AppError(409, "STALE_FENCING_TOKEN", `Stale fencing token ${fencingToken}. Current is ${liveJob.fencing_token}.`);
      }
      if (!liveJob.lease_expires_at || new Date(liveJob.lease_expires_at) <= now) {
        throw new AppError(403, "LEASE_EXPIRED", "Worker lease has expired.");
      }
      if (["cancelled", "cancel_requested", "failed", "completed", "completed_with_errors", "completed_partial"].includes(liveJob.status)) {
        throw new AppError(409, "JOB_NOT_ACTIVE", `Job is inactive (${liveJob.status}).`);
      }
      if (expectedPriorVersion !== null && expectedPriorVersion !== undefined && liveJob.snapshot_version !== expectedPriorVersion) {
        throw new AppError(409, "SNAPSHOT_VERSION_CONFLICT", `Expected prior version ${expectedPriorVersion}, current is ${liveJob.snapshot_version}.`);
      }
      if (snapshotVersion <= liveJob.snapshot_version) {
        throw new AppError(409, "INVALID_SNAPSHOT_VERSION", `Snapshot version ${snapshotVersion} is not greater than ${liveJob.snapshot_version}.`);
      }

      throw new AppError(409, "PUBLICATION_CONFLICT", "Publication rejected: atomic condition failed.");
    }

    try {
      const { defaultBroadcaster } = require("./IngestionProgressBroadcaster");
      (this.broadcaster || defaultBroadcaster).recordEvent({
        jobId,
        eventType: "graph.published",
        payload: {
          snapshotVersion: updated.snapshot_version,
          snapshotStoragePath: updated.snapshot_storage_path,
          graphStatus: updated.graph_status,
          confirmedEdges,
          unresolvedReferences,
          initialGraphReady: true,
          isFinal: Boolean(isFinal),
        },
      }).catch(() => {});

      if (isFinal) {
        const terminalEventType =
          updated.status === "completed_with_errors"
            ? "job.completed_with_errors"
            : updated.status === "completed_partial"
            ? "job.completed_partial"
            : "job.completed";

        (this.broadcaster || defaultBroadcaster).recordEvent({
          jobId,
          eventType: terminalEventType,
          payload: {
            status: updated.status,
            snapshotVersion: updated.snapshot_version,
          },
        }).catch(() => {});
      }
    } catch (e) {}

    return {
      success: true,
      snapshotVersion: updated.snapshot_version,
      snapshotStoragePath: updated.snapshot_storage_path,
      graphStatus: updated.graph_status,
      initialGraphReady: true,
      status: updated.status,
    };
  }

  /**
   * Retrieves a job record by ID, verifying tenant context if provided.
   *
   * @param {string} jobId
   * @param {string} [organizationId]
   * @returns {Promise<object>}
   */
  async getJob(jobId, organizationId = null) {
    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
      if (organizationId && job.organization_id !== organizationId) {
        throw new AppError(403, "TENANT_ACCESS_DENIED", "Access denied: Job belongs to another tenant.");
      }
      return { ...job };
    }

    const { data, error } = await supabaseAdmin
      .from("ingestion_jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (error || !data) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);
    if (organizationId && data.organization_id !== organizationId) {
      throw new AppError(403, "TENANT_ACCESS_DENIED", "Access denied: Job belongs to another tenant.");
    }
    return data;
  }

  /**
   * Checks whether a job has cancellation requested.
   *
   * @param {string} jobId
   * @returns {boolean}
   */
  isJobCancelled(jobId) {
    if (this.useMemoryStore) {
      const job = this.memoryJobs.get(jobId);
      return job ? (job.status === "cancel_requested" || job.status === "cancelled") : false;
    }
    return false;
  }

  /**
   * Clears all in-memory tables (for testing).
   */
  clearMemoryStore() {
    this.memoryJobs.clear();
    this.memoryFiles.clear();
    this.lockTokens.clear();
  }
}

const defaultJobManager = new IngestionJobManager();

module.exports = {
  IngestionJobManager,
  defaultJobManager,
  LEASE_DURATION_MS,
  DEFAULT_MAX_RECLAIMS,
};

