/**
 * Cartograph Ingestion Progress & Lifecycle Routes (Gate 11F).
 */

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errors");
const {
  getJobProgress,
  createSseTicket,
  streamJobEvents,
  cancelJob,
} = require("../controllers/ingestionController");

const routes = express.Router();

// Authoritative Job Status & Progress
routes.get("/ingestion/jobs/:jobId", requireAuth, asyncHandler(getJobProgress));
routes.get("/organizations/:orgId/ingestion/jobs/:jobId", requireAuth, asyncHandler(getJobProgress));

// Short-lived, single-use ticket for native browser EventSource connections
routes.post("/ingestion/jobs/:jobId/events/ticket", requireAuth, asyncHandler(createSseTicket));
routes.post("/organizations/:orgId/ingestion/jobs/:jobId/events/ticket", requireAuth, asyncHandler(createSseTicket));

// Server-Sent Events stream (supports single-use ticket query param or session cookie / auth header)
routes.get("/ingestion/jobs/:jobId/events", asyncHandler(streamJobEvents));
routes.get("/organizations/:orgId/ingestion/jobs/:jobId/events", asyncHandler(streamJobEvents));

// Authorized, Idempotent Job Cancellation
routes.post("/ingestion/jobs/:jobId/cancel", requireAuth, asyncHandler(cancelJob));
routes.post("/organizations/:orgId/ingestion/jobs/:jobId/cancel", requireAuth, asyncHandler(cancelJob));

module.exports = routes;

