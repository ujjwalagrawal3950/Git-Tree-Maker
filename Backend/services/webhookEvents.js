const { supabaseAdmin } = require("../config/DbConnect");
const { config } = require("../config/env");
const { mapSupabaseError } = require("../lib/errors");

function safeErrorCode(code) {
  return (
    String(code || "UNKNOWN")
      .replace(/[^A-Z0-9_]/gi, "")
      .slice(0, 64) || "UNKNOWN"
  );
}

async function claimWebhookEvent({ id, type, eventCreatedAt }) {
  const { data, error } = await supabaseAdmin.rpc("claim_webhook_event", {
    p_id: id,
    p_type: type,
    p_event_created_at: eventCreatedAt,
    p_max_attempts: config.webhookMaxAttempts,
    p_stale_ms: config.webhookStaleMs,
  });

  if (error) throw mapSupabaseError(error, "claimWebhookEvent");

  const row = Array.isArray(data) ? data[0] : data;
  return {
    claimed: Boolean(row && row.claimed),
    status: (row && row.status) || "processing",
  };
}

async function markProcessed(id) {
  const { error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id);

  if (error) {
    console.error("Failed to mark webhook event processed:", error.code);
  }
}

async function markIgnored(id, reasonCode) {
  const { error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      status: "ignored",
      processed_at: new Date().toISOString(),
      last_error: safeErrorCode(reasonCode),
    })
    .eq("id", id);

  if (error) {
    console.error("Failed to mark webhook event ignored:", error.code);
  }
}

async function markFailed(id, reasonCode) {
  const { error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      status: "failed",
      processed_at: null,
      last_error: safeErrorCode(reasonCode),
    })
    .eq("id", id);

  if (error) {
    console.error("Failed to mark webhook event failed:", error.code);
  }
}

async function markTerminalFailure(id, reasonCode) {
  const { error } = await supabaseAdmin
    .from("webhook_events")
    .update({
      status: "failed",
      attempts: 999,
      processed_at: null,
      last_error: safeErrorCode(reasonCode),
    })
    .eq("id", id);

  if (error) {
    console.error("Failed to mark webhook event terminal:", error.code);
  }
}

module.exports = {
  claimWebhookEvent,
  markProcessed,
  markIgnored,
  markFailed,
  markTerminalFailure,
};
