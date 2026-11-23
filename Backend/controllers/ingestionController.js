/**
 * Cartograph Real-Time Ingestion Progress & Lifecycle Controller (Gate 11F).
 *
 * Exposes authenticated, tenant-isolated endpoints for:
 * - Authoritative job status and progress queries.
 * - Server-Sent Events (SSE) real-time event streaming with Last-Event-ID replay.
 * - Short-lived, single-use ticket issuance for browser EventSource authentication.
 * - Idempotent, authorized job cancellation.
 */

const { AppError } = require("../lib/errors");
const { ensureTenantAuthorization } = require("./repositoryController");
const { verifyRepositoryOwnership } = require("../services/repositoryAuth");
const { defaultJobManager } = require("../services/ingestion/IngestionJobManager");
const { defaultBroadcaster } = require("../services/ingestion/IngestionProgressBroadcaster");

/**
 * Transforms an authoritative database job record into standard client progress format.
 *
 * @param {object} job
 * @returns {object} Formatted progress object
 */
function formatJobProgress(job) {
  if (!job) return null;

  const totalFiles = job.total_files || 0;
  const parsedFiles = job.parsed_files || 0;
  const failedFiles = job.failed_files || 0;
  const skippedFiles = job.skipped_files || 0;
  const processedFiles = totalFiles > 0 ? Math.min(totalFiles, parsedFiles + failedFiles + skippedFiles) : (job.processed_files || 0);
  const remainingFiles = totalFiles > 0 ? Math.max(0, totalFiles - processedFiles) : 0;
  const percentage = totalFiles > 0 ? Math.min(100, Math.max(0, Math.round((processedFiles / totalFiles) * 100))) : 0;
  const isTerminal = ["completed", "completed_with_errors", "completed_partial", "failed", "cancelled"].includes(job.status);
  const isCancelled = job.status === "cancelled";
  const isCancelRequested = job.status === "cancel_requested";

  return {
    id: job.id,
    repositoryId: job.repository_id,
    organizationId: job.organization_id,
    commitSha: job.commit_sha,
    mode: job.mode,
    ingestionStrategy: job.ingestion_strategy,
    status: job.status,
    phase: job.phase,
    totalFiles,
    processedFiles,
    downloadedFiles: job.downloaded_files || 0,
    parsedFiles,
    failedFiles,
    skippedFiles,
    remainingFiles,
    currentBatch: job.current_batch || 0,
    totalBatches: job.total_batches || 0,
    snapshotVersion: job.snapshot_version || 0,
    snapshotStoragePath: job.snapshot_storage_path || null,
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
}

/**
 * GET /api/ingestion/jobs/:jobId
 * Returns current authoritative job status and progress.
 */
async function getJobProgress(req, res) {
  const { jobId } = req.params;
  if (!jobId) throw new AppError(400, "MISSING_JOB_ID", "jobId route parameter is required.");

  const orgId = await ensureTenantAuthorization(req);
  const job = await defaultJobManager.getJob(jobId, orgId);

  // Verify caller's organization has access to this repository
  await verifyRepositoryOwnership(job.repository_id, orgId);

  res.status(200).json({
    success: true,
    data: {
      job: formatJobProgress(job),
    },
  });
}

/**
 * POST /api/ingestion/jobs/:jobId/events/ticket
 * Issues an authorized short-lived single-use ticket for native browser EventSource connections.
 */
async function createSseTicket(req, res) {
  const { jobId } = req.params;
  if (!jobId) throw new AppError(400, "MISSING_JOB_ID", "jobId route parameter is required.");

  const orgId = await ensureTenantAuthorization(req);
  const job = await defaultJobManager.getJob(jobId, orgId);

  await verifyRepositoryOwnership(job.repository_id, orgId);

  const ticketData = await defaultBroadcaster.createTicket({
    userId: req.actor.userId,
    orgId,
    jobId,
  });

  res.status(200).json({
    success: true,
    data: ticketData,
  });
}

/**
 * GET /api/ingestion/jobs/:jobId/events
 * Server-Sent Events stream delivering real-time progress, publication, and lifecycle events.
 */
async function streamJobEvents(req, res) {
  const { jobId } = req.params;
  if (!jobId) throw new AppError(400, "MISSING_JOB_ID", "jobId route parameter is required.");

  // 1. Authenticate via single-use ticket OR standard Clerk session (cookie / header)
  const ticketParam = req.query.ticket;
  // Redact ticket from req.query immediately to prevent sensitive token leakage in logs
  if (req.query && req.query.ticket) {
    req.query.ticket = defaultBroadcaster._redactTicket(req.query.ticket);
  }

  if (!req.actor || !req.actor.userId) {
    if (ticketParam) {
      const consumed = await defaultBroadcaster.consumeTicket(ticketParam, jobId);
      if (!consumed) {
        throw new AppError(401, "INVALID_SSE_TICKET", "The provided SSE ticket is invalid, expired, or already consumed.");
      }
      req.actor = {
        userId: consumed.userId,
        orgId: consumed.orgId,
      };
    } else {
      let auth;
      try {
        const { getAuth } = require("@clerk/express");
        auth = getAuth(req);
      } catch (e) {
        // ignore
      }
      if (auth && auth.userId) {
        req.actor = {
          userId: auth.userId,
          sessionId: auth.sessionId || null,
          orgId: auth.orgId || null,
          orgRole: auth.orgRole || null,
          orgSlug: auth.orgSlug || null,
        };
      }
    }
  }

  // 2. Enforce active organization tenancy
  const orgId = await ensureTenantAuthorization(req);

  // 3. Authoritatively fetch job and enforce tenant ownership
  const job = await defaultJobManager.getJob(jobId, orgId);
  await verifyRepositoryOwnership(job.repository_id, orgId);

  // 4. Delegate to broadcaster for SSE lifecycle (headers, replay, snapshot, heartbeat)
  await defaultBroadcaster.handleSseConnection({
    jobId,
    job,
    req,
    res,
  });
}

/**
 * POST /api/ingestion/jobs/:jobId/cancel
 * Safely and idempotently requests cancellation of an ingestion job.
 */
async function cancelJob(req, res) {
  const { jobId } = req.params;
  if (!jobId) throw new AppError(400, "MISSING_JOB_ID", "jobId route parameter is required.");

  const orgId = await ensureTenantAuthorization(req);
  const job = await defaultJobManager.getJob(jobId, orgId);

  await verifyRepositoryOwnership(job.repository_id, orgId);

  const result = await defaultJobManager.requestCancellation(jobId, orgId);

  res.status(200).json({
    success: true,
    data: {
      jobId,
      status: result.status,
      isCancelled: result.status === "cancelled",
      isCancelRequested: result.status === "cancel_requested",
    },
  });
}

module.exports = {
  formatJobProgress,
  getJobProgress,
  createSseTicket,
  streamJobEvents,
  cancelJob,
};
