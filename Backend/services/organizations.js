const { supabaseAdmin } = require("../config/DbConnect");
const { AppError, mapSupabaseError } = require("../lib/errors");
const {
  normalizeClerkRole,
  validateClerkId,
  validateOrganizationName,
  validateProfileField,
  toIsoTimestamp,
} = require("../lib/validation");
const {
  createClerkOrganization,
  createClerkInvitation,
  updateClerkMembership,
  deleteClerkMembership,
  deleteClerkOrganization,
  getClerkOrganization,
} = require("./clerk");
const { getOrSyncUser } = require("./user");

function mapOrganization(row, role) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    imageUrl: row.image_url,
    role: role || "member",
    createdAt: row.created_at,
  };
}

function mapMembership(row) {
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getActiveMembership(organizationId, userId) {
  const { data, error } = await supabaseAdmin
    .from("organization_members")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, "getActiveMembership");
  return data;
}

async function getOrSyncOrganization(organizationId, userId, role = "member") {
  if (userId) {
    try {
      await getOrSyncUser(userId);
    } catch {
      // ignore
    }
  }

  const clerkOrg = await getClerkOrganization(organizationId);
  if (!clerkOrg) return null;

  try {
    await upsertOrganizationFromWebhook(clerkOrg);
  } catch {
    // ignore
  }

  if (userId) {
    try {
      await upsertMembershipFromWebhook({
        organization_id: organizationId,
        user_id: userId,
        role: role || "member",
        source_updated_at: clerkOrg.source_updated_at || new Date().toISOString(),
      });
    } catch {
      // ignore
    }
  }

  return getActiveMembership(organizationId, userId);
}

async function requireMembership(organizationId, userId) {
  let membership = await getActiveMembership(organizationId, userId);
  if (!membership) {
    try {
      membership = await getOrSyncOrganization(organizationId, userId);
    } catch {
      // ignore
    }
  }

  if (!membership) {
    // 404 avoids confirming that an organization the caller cannot see exists.
    throw new AppError(
      404,
      "NOT_FOUND",
      "The requested organization was not found."
    );
  }

  const { data: organization, error } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, "requireMembership");
  if (!organization) {
    throw new AppError(
      404,
      "NOT_FOUND",
      "The requested organization was not found."
    );
  }

  return membership;
}

function requireAdmin(membership) {
  if (!membership || membership.role !== "admin") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You do not have permission to perform this action."
    );
  }
}

async function getActiveAdminCount(organizationId) {
  const { count, error } = await supabaseAdmin
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("deleted_at", null);

  if (error) throw mapSupabaseError(error, "getActiveAdminCount");
  return count || 0;
}

async function assertNotLastAdmin(organizationId, targetRole) {
  if (targetRole !== "admin") return;
  const adminCount = await getActiveAdminCount(organizationId);
  if (adminCount <= 1) {
    throw new AppError(
      409,
      "LAST_ADMIN",
      "The organization must keep at least one active admin."
    );
  }
}

async function getOrganizationRow(organizationId) {
  const { data, error } = await supabaseAdmin
    .from("organizations")
    .select("*")
    .eq("id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw mapSupabaseError(error, "getOrganizationRow");
  return data;
}

async function listOrganizationsForUser(userId) {
  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId)
    .is("deleted_at", null);

  if (membershipError) {
    throw mapSupabaseError(membershipError, "listOrganizationsForUser");
  }
  if (!memberships || memberships.length === 0) return [];

  const ids = memberships.map((row) => row.organization_id);
  const { data: organizations, error: organizationError } = await supabaseAdmin
    .from("organizations")
    .select("*")
    .in("id", ids)
    .is("deleted_at", null)
    .order("name", { ascending: true });

  if (organizationError) {
    throw mapSupabaseError(organizationError, "listOrganizationsForUser");
  }

  const roleById = new Map(
    memberships.map((row) => [row.organization_id, row.role])
  );
  return (organizations || []).map((row) =>
    mapOrganization(row, roleById.get(row.id))
  );
}

async function getOrganizationForMember(organizationId, userId) {
  const membership = await requireMembership(organizationId, userId);
  const organization = await getOrganizationRow(organizationId);
  if (!organization) {
    throw new AppError(404, "NOT_FOUND", "The organization was not found.");
  }
  return mapOrganization(organization, membership.role);
}

async function listOrganizationMembers(organizationId, viewerRole) {
  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from("organization_members")
    .select("organization_id, user_id, role, created_at, updated_at")
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (membershipError) {
    throw mapSupabaseError(membershipError, "listOrganizationMembers");
  }

  const userIds = (memberships || []).map((row) => row.user_id);
  if (userIds.length === 0) return [];

  const { data: users, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, email, first_name, last_name, username, image_url")
    .in("id", userIds)
    .is("deleted_at", null);

  if (userError) {
    throw mapSupabaseError(userError, "listOrganizationMembers");
  }

  const userById = new Map((users || []).map((user) => [user.id, user]));
  const canSeeEmail = viewerRole === "admin";

  return (memberships || []).map((membership) => {
    const user = userById.get(membership.user_id) || {};
    return {
      userId: membership.user_id,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      username: user.username || null,
      imageUrl: user.image_url || null,
      role: membership.role,
      joinedAt: membership.created_at,
      ...(canSeeEmail ? { email: user.email || null } : {}),
    };
  });
}

async function upsertOrganizationFromWebhook(input) {
  const organizationId = validateClerkId(input.id, "organization id");
  const name = validateOrganizationName(input.name);
  const slug = input.slug ? String(input.slug).toLowerCase() : null;
  const imageUrl = validateProfileField(input.image_url, "image_url");
  const createdBy = input.created_by
    ? validateClerkId(input.created_by, "created_by")
    : null;
  const sourceUpdatedAt = toIsoTimestamp(input.source_updated_at);

  const { data, error } = await supabaseAdmin.rpc(
    "upsert_organization_from_source",
    {
      p_id: organizationId,
      p_name: name,
      p_slug: slug,
      p_image_url: imageUrl,
      p_created_by: createdBy,
      p_source_updated_at: sourceUpdatedAt,
    }
  );

  if (error) throw mapSupabaseError(error, "upsertOrganizationFromWebhook");
  return data && !Array.isArray(data) ? data : data && data[0] ? data[0] : null;
}

async function upsertMembershipFromWebhook(input) {
  const organizationId = validateClerkId(
    input.organization_id,
    "organization id"
  );
  const userId = validateClerkId(input.user_id, "user id");
  const role = normalizeClerkRole(input.role, "member");
  const sourceUpdatedAt = toIsoTimestamp(input.source_updated_at);

  const { data, error } = await supabaseAdmin.rpc(
    "upsert_organization_membership",
    {
      p_organization_id: organizationId,
      p_user_id: userId,
      p_role: role,
      p_source_updated_at: sourceUpdatedAt,
    }
  );

  if (error) throw mapSupabaseError(error, "upsertMembershipFromWebhook");
  return data && !Array.isArray(data) ? data : data && data[0] ? data[0] : null;
}

async function softDeleteOrganizationFromWebhook(organizationId, sourceUpdatedAt) {
  const { error } = await supabaseAdmin.rpc("soft_delete_organization", {
    p_organization_id: organizationId,
    p_source_updated_at: toIsoTimestamp(sourceUpdatedAt),
  });
  if (error) throw mapSupabaseError(error, "softDeleteOrganizationFromWebhook");
}

async function softDeleteMembershipFromWebhook(
  organizationId,
  userId,
  sourceUpdatedAt
) {
  const { error } = await supabaseAdmin.rpc(
    "soft_delete_organization_membership",
    {
      p_organization_id: organizationId,
      p_user_id: userId,
      p_source_updated_at: toIsoTimestamp(sourceUpdatedAt),
    }
  );
  if (error) throw mapSupabaseError(error, "softDeleteMembershipFromWebhook");
}

async function createOrganization({ name, slug, userId }) {
  // The organization mirror needs a local user row for created_by and the
  // initial admin membership. Recover a missed user.created webhook first.
  const localUser = await getOrSyncUser(userId);
  if (!localUser) {
    throw new AppError(404, "NOT_FOUND", "User profile not found.");
  }

  const organization = await createClerkOrganization({
    name,
    slug,
    createdBy: userId,
  });

  try {
    await upsertOrganizationFromWebhook(organization);
    await upsertMembershipFromWebhook({
      organization_id: organization.id,
      user_id: userId,
      role: "admin",
      source_updated_at: organization.source_updated_at,
    });
  } catch (error) {
    console.error(
      "Organization created in Clerk but local mirror failed:",
      error.code || "UNKNOWN"
    );
    throw new AppError(
      502,
      "MIRROR_PENDING",
      "The organization was created, but local synchronization is pending."
    );
  }

  return {
    ...mapOrganization(
      {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        image_url: organization.image_url,
        created_at: new Date().toISOString(),
      },
      "admin"
    ),
  };
}

async function inviteOrganizationMember({
  organizationId,
  emailAddress,
  role,
  actorUserId,
}) {
  const actorMembership = await requireMembership(organizationId, actorUserId);
  requireAdmin(actorMembership);

  return createClerkInvitation({
    organizationId,
    emailAddress,
    role,
    inviterUserId: actorUserId,
  });
}

async function updateOrganizationMemberRole({
  organizationId,
  targetUserId,
  role,
  actorUserId,
}) {
  const actorMembership = await requireMembership(organizationId, actorUserId);
  requireAdmin(actorMembership);

  const targetMembership = await requireMembership(organizationId, targetUserId);

  if (targetMembership.role === "admin" && role === "member") {
    await assertNotLastAdmin(organizationId, "admin");
  }

  const updated = await updateClerkMembership({
    organizationId,
    userId: targetUserId,
    role,
  });

  await upsertMembershipFromWebhook({
    organization_id: organizationId,
    user_id: targetUserId,
    role: updated.role,
    source_updated_at: updated.sourceUpdatedAt,
  });

  return {
    organizationId,
    userId: targetUserId,
    role: updated.role,
  };
}

async function removeOrganizationMember({
  organizationId,
  targetUserId,
  actorUserId,
}) {
  const actorMembership = await requireMembership(organizationId, actorUserId);
  const isSelf = actorUserId === targetUserId;

  if (!isSelf) {
    requireAdmin(actorMembership);
  }

  const targetMembership = await requireMembership(organizationId, targetUserId);

  if (targetMembership.role === "admin") {
    await assertNotLastAdmin(organizationId, "admin");
  }

  await deleteClerkMembership({ organizationId, userId: targetUserId });
  await softDeleteMembershipFromWebhook(
    organizationId,
    targetUserId,
    new Date().toISOString()
  );

  return true;
}

async function deleteOrganization({ organizationId, actorUserId, name }) {
  const actorMembership = await requireMembership(organizationId, actorUserId);
  requireAdmin(actorMembership);

  const organization = await getOrganizationRow(organizationId);
  if (!organization) {
    throw new AppError(404, "NOT_FOUND", "The organization was not found.");
  }
  if (name !== organization.name) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The confirmation name does not match the organization name."
    );
  }

  await deleteClerkOrganization(organizationId);
  await softDeleteOrganizationFromWebhook(
    organizationId,
    new Date().toISOString()
  );
}

module.exports = {
  getActiveMembership,
  requireMembership,
  getOrSyncOrganization,
  requireAdmin,
  listOrganizationsForUser,
  getOrganizationForMember,
  listOrganizationMembers,
  upsertOrganizationFromWebhook,
  upsertMembershipFromWebhook,
  softDeleteOrganizationFromWebhook,
  softDeleteMembershipFromWebhook,
  createOrganization,
  inviteOrganizationMember,
  updateOrganizationMemberRole,
  removeOrganizationMember,
  deleteOrganization,
  mapMembership,
};
