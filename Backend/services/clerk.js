const { clerkClient } = require("@clerk/express");
const { mapClerkError } = require("../lib/errors");
const { toIsoTimestamp } = require("../lib/validation");

function normalizeClerkUser(user) {
  if (!user || !user.id) return null;

  const primaryEmail =
    user.emailAddresses &&
    user.emailAddresses.find(
      (email) => email.id === user.primaryEmailAddressId
    );
  const email =
    (primaryEmail && primaryEmail.emailAddress) ||
    (user.emailAddresses && user.emailAddresses[0] &&
      user.emailAddresses[0].emailAddress) ||
    null;

  return {
    id: user.id,
    email: email ? email.toLowerCase() : null,
    first_name: user.firstName || null,
    last_name: user.lastName || null,
    username: user.username || null,
    image_url: user.imageUrl || null,
    source_updated_at: toIsoTimestamp(user.updatedAt),
  };
}

function normalizeClerkOrganization(organization) {
  if (!organization || !organization.id) return null;
  return {
    id: organization.id,
    name: organization.name || null,
    slug: organization.slug || null,
    image_url: organization.imageUrl || null,
    created_by: organization.createdBy || null,
    source_updated_at: toIsoTimestamp(organization.updatedAt),
  };
}

async function getClerkUser(userId) {
  try {
    const user = await clerkClient.users.getUser(userId);
    return normalizeClerkUser(user);
  } catch (error) {
    const mapped = mapClerkError(error);
    if (mapped.status === 404) return null;
    throw mapped;
  }
}

async function getClerkOrganization(organizationId) {
  try {
    const organization = await clerkClient.organizations.getOrganization({
      organizationId,
    });
    return normalizeClerkOrganization(organization);
  } catch (error) {
    const mapped = mapClerkError(error);
    if (mapped.status === 404) return null;
    throw mapped;
  }
}

async function deleteClerkUser(userId) {
  try {
    await clerkClient.users.deleteUser(userId);
    return true;
  } catch (error) {
    const mapped = mapClerkError(error);
    if (mapped.status === 404) return false;
    throw mapped;
  }
}

async function createClerkOrganization({ name, slug, createdBy }) {
  try {
    const organization = await clerkClient.organizations.createOrganization({
      name,
      slug: slug || undefined,
      createdBy,
    });
    return normalizeClerkOrganization(organization);
  } catch (error) {
    throw mapClerkError(error);
  }
}

async function createClerkInvitation({
  organizationId,
  emailAddress,
  role,
  inviterUserId,
}) {
  try {
    const invitation = await clerkClient.organizations.createOrganizationInvitation(
      {
        organizationId,
        emailAddress,
        role: role === "admin" ? "org:admin" : "org:member",
        inviterUserId,
      }
    );

    return {
      id: invitation.id,
      emailAddress: invitation.emailAddress,
      role: invitation.role === "org:admin" ? "admin" : "member",
      status: invitation.status,
      createdAt: invitation.createdAt
        ? toIsoTimestamp(invitation.createdAt)
        : null,
    };
  } catch (error) {
    throw mapClerkError(error);
  }
}

async function updateClerkMembership({ organizationId, userId, role }) {
  try {
    const membership =
      await clerkClient.organizations.updateOrganizationMembership({
        organizationId,
        userId,
        role: role === "admin" ? "org:admin" : "org:member",
      });

    return {
      organizationId,
      userId,
      role: membership.role === "org:admin" ? "admin" : "member",
      sourceUpdatedAt: toIsoTimestamp(membership.updatedAt),
    };
  } catch (error) {
    throw mapClerkError(error);
  }
}

async function deleteClerkMembership({ organizationId, userId }) {
  try {
    await clerkClient.organizations.deleteOrganizationMembership({
      organizationId,
      userId,
    });
    return true;
  } catch (error) {
    const mapped = mapClerkError(error);
    if (mapped.status === 404) return false;
    throw mapped;
  }
}

async function deleteClerkOrganization(organizationId) {
  try {
    await clerkClient.organizations.deleteOrganization(organizationId);
    return true;
  } catch (error) {
    const mapped = mapClerkError(error);
    if (mapped.status === 404) return false;
    throw mapped;
  }
}

module.exports = {
  normalizeClerkUser,
  normalizeClerkOrganization,
  getClerkUser,
  getClerkOrganization,
  deleteClerkUser,
  createClerkOrganization,
  createClerkInvitation,
  updateClerkMembership,
  deleteClerkMembership,
  deleteClerkOrganization,
};
