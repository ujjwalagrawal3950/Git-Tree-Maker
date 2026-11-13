const { supabaseAdmin } = require("../config/DbConnect");
const { mapSupabaseError } = require("../lib/errors");
const {
  validateProfileField,
  toIsoTimestamp,
} = require("../lib/validation");
const { getClerkUser } = require("./clerk");

function normalizeUserFields(input) {
  if (!input || typeof input.id !== "string" || !input.id) {
    throw new Error("A Clerk user ID is required.");
  }

  return {
    id: input.id,
    email: input.email ? String(input.email).trim().toLowerCase() : null,
    first_name: validateProfileField(input.first_name, "first_name"),
    last_name: validateProfileField(input.last_name, "last_name"),
    username: validateProfileField(input.username, "username"),
    image_url: validateProfileField(input.image_url, "image_url"),
    source_updated_at: toIsoTimestamp(input.source_updated_at),
  };
}

async function upsertUserFromWebhook(input) {
  const user = normalizeUserFields(input);
  const { data, error } = await supabaseAdmin.rpc("upsert_user_from_source", {
    p_id: user.id,
    p_email: user.email,
    p_first_name: user.first_name,
    p_last_name: user.last_name,
    p_username: user.username,
    p_image_url: user.image_url,
    p_source_updated_at: user.source_updated_at,
  });

  if (error) throw mapSupabaseError(error, "upsertUserFromWebhook");
  return data && !Array.isArray(data) ? data : data && data[0] ? data[0] : null;
}

async function getUserById(userId) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, "getUserById");
  return data;
}

async function getOrSyncUser(userId) {
  const existing = await getUserById(userId);
  if (existing) return existing;

  // Bounded webhook-race recovery: Clerk is the source of truth, and the
  // upsert is conditional on the tombstone/order checks in the database.
  const clerkUser = await getClerkUser(userId);
  if (!clerkUser) return null;

  await upsertUserFromWebhook(clerkUser);
  return getUserById(userId);
}

async function deleteUserAndCascade(userId, sourceUpdatedAt) {
  const { error } = await supabaseAdmin.rpc("delete_user_cascade", {
    p_user_id: userId,
    p_source_updated_at: toIsoTimestamp(sourceUpdatedAt),
  });

  if (error) throw mapSupabaseError(error, "deleteUserAndCascade");
}

function toUserResponse(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
    imageUrl: user.image_url,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

module.exports = {
  upsertUserFromWebhook,
  getUserById,
  getOrSyncUser,
  deleteUserAndCascade,
  toUserResponse,
};
