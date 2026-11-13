const { Webhook } = require("svix");
const { config } = require("../config/env");
const { AppError, isAppError } = require("../lib/errors");
const {
  validateClerkId,
  toIsoTimestamp,
  normalizeClerkRole,
} = require("../lib/validation");
const { upsertUserFromWebhook, deleteUserAndCascade } = require("../services/user");
const {
  upsertOrganizationFromWebhook,
  upsertMembershipFromWebhook,
  softDeleteOrganizationFromWebhook,
  softDeleteMembershipFromWebhook,
} = require("../services/organizations");
const {
  claimWebhookEvent,
  markProcessed,
  markIgnored,
  markFailed,
  markTerminalFailure,
} = require("../services/webhookEvents");

const IGNORED_EVENTS = new Set([
  "session.created",
  "session.ended",
  "session.removed",
  "session.revoked",
]);

function getPrimaryEmail(data) {
  const primary =
    data.email_addresses &&
    data.email_addresses.find(
      (email) => email.id === data.primary_email_address_id
    );
  return (
    (primary && primary.email_address) ||
    (data.email_addresses &&
      data.email_addresses[0] &&
      data.email_addresses[0].email_address) ||
    (data.external_accounts &&
      data.external_accounts[0] &&
      data.external_accounts[0].email_address) ||
    (data.primary_email_address && data.primary_email_address.email_address) ||
    null
  );
}

function getUserPayload(data, eventCreatedAt) {
  const email = getPrimaryEmail(data);
  const firstName =
    data.first_name ||
    (data.external_accounts &&
      data.external_accounts[0] &&
      data.external_accounts[0].first_name) ||
    null;
  const lastName =
    data.last_name ||
    (data.external_accounts &&
      data.external_accounts[0] &&
      data.external_accounts[0].last_name) ||
    null;
  const username =
    data.username ||
    (data.external_accounts &&
      data.external_accounts[0] &&
      data.external_accounts[0].username) ||
    (email ? email.split("@")[0] : null);

  return {
    id: data.id,
    email,
    first_name: firstName,
    last_name: lastName,
    username,
    image_url: data.image_url || data.profile_image_url || null,
    source_updated_at: toIsoTimestamp(
      data.updated_at || data.created_at || eventCreatedAt
    ),
  };
}

function getMembershipIds(data) {
  return {
    organizationId:
      (data.organization && data.organization.id) || data.organization_id,
    userId:
      (data.public_user_data && data.public_user_data.user_id) ||
      (data.public_user_data && data.public_user_data.userId) ||
      data.user_id ||
      (data.user && data.user.id),
    role: normalizeClerkRole(data.role, "member"),
  };
}

async function recordTerminalFailure({ id, type, eventCreatedAt, code }) {
  try {
    const claim = await claimWebhookEvent({
      id,
      type,
      eventCreatedAt,
    });
    if (claim.claimed) await markTerminalFailure(id, code);
  } catch (error) {
    console.error("Failed to record rejected webhook:", error.code || "UNKNOWN");
  }
}

async function handleClerkWebhook(req, res) {
  if (!config.clerkWebhookSecret) {
    console.error("CLERK_WEBHOOK_SECRET is not configured.");
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL", message: "Webhook is not configured." },
    });
  }

  const svixId = req.headers["svix-id"];
  const svixTimestamp = req.headers["svix-timestamp"];
  const svixSignature = req.headers["svix-signature"];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Missing Svix headers." },
    });
  }

  const payloadString = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);

  const webhook = new Webhook(config.clerkWebhookSecret);

  try {
    webhook.verify(payloadString, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch (error) {
    // Never log the signature, secret, or payload.
    console.warn(`Rejected webhook ${svixId}: invalid signature`);
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid webhook signature." },
    });
  }

  let event;
  try {
    event = JSON.parse(payloadString);
  } catch (error) {
    await recordTerminalFailure({
      id: svixId,
      type: "malformed",
      eventCreatedAt: new Date().toISOString(),
      code: "MALFORMED_JSON",
    });
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Malformed webhook body." },
    });
  }

  const eventType =
    typeof event.type === "string" && event.type ? event.type : "unknown";
  const eventCreatedAt = toIsoTimestamp(
    event.created_at || (event.data && event.data.updated_at)
  );

  let claim;
  try {
    claim = await claimWebhookEvent({
      id: svixId,
      type: eventType,
      eventCreatedAt,
    });
  } catch (error) {
    console.error(`Webhook ledger claim failed for ${svixId}:`, error.code);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL", message: "Webhook processing failed." },
    });
  }

  if (!claim.claimed) {
    return res.status(200).json({ success: true, received: true });
  }

  try {
    const data = event.data || {};
    const sourceUpdatedAt = toIsoTimestamp(
      data.updated_at || data.created_at || eventCreatedAt
    );

    switch (eventType) {
      case "user.created":
      case "user.updated": {
        const userId = validateClerkId(data.id, "user id");
        await upsertUserFromWebhook(
          getUserPayload({ ...data, id: userId }, eventCreatedAt)
        );
        break;
      }

      case "user.deleted": {
        const userId = validateClerkId(data.id, "user id");
        await deleteUserAndCascade(userId, eventCreatedAt);
        break;
      }

      case "organization.created":
      case "organization.updated": {
        const organizationId = validateClerkId(data.id, "organization id");
        await upsertOrganizationFromWebhook({
          id: organizationId,
          name: data.name,
          slug: data.slug || null,
          image_url: data.image_url || null,
          created_by: data.created_by || null,
          source_updated_at: sourceUpdatedAt,
        });
        break;
      }

      case "organization.deleted": {
        const organizationId = validateClerkId(data.id, "organization id");
        await softDeleteOrganizationFromWebhook(
          organizationId,
          eventCreatedAt
        );
        break;
      }

      case "organizationMembership.created":
      case "organizationMembership.updated": {
        const ids = getMembershipIds(data);
        const organizationId = validateClerkId(
          ids.organizationId,
          "organization id"
        );
        const userId = validateClerkId(ids.userId, "user id");
        await upsertMembershipFromWebhook({
          organization_id: organizationId,
          user_id: userId,
          role: ids.role,
          source_updated_at: sourceUpdatedAt,
        });
        break;
      }

      case "organizationMembership.deleted": {
        const ids = getMembershipIds(data);
        const organizationId = validateClerkId(
          ids.organizationId,
          "organization id"
        );
        const userId = validateClerkId(ids.userId, "user id");
        await softDeleteMembershipFromWebhook(
          organizationId,
          userId,
          eventCreatedAt
        );
        break;
      }

      default: {
        await markIgnored(
          svixId,
          IGNORED_EVENTS.has(eventType) ? "IGNORED_EVENT" : "UNSUPPORTED_EVENT"
        );
        return res.status(200).json({ success: true, received: true });
      }
    }

    await markProcessed(svixId);
    return res.status(200).json({ success: true, received: true });
  } catch (error) {
    if (isAppError(error) && !error.retryable && error.status < 500) {
      await markTerminalFailure(svixId, error.code || "PERMANENT_FAILURE");
      return res.status(error.status).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
    }

    await markFailed(svixId, isAppError(error) ? error.code : "TRANSIENT_FAILURE");
    console.error(
      `Webhook ${svixId} failed transiently:`,
      isAppError(error) ? error.code : error.code || "TRANSIENT_FAILURE"
    );
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL", message: "Webhook processing failed." },
    });
  }
}

module.exports = { handleClerkWebhook };
