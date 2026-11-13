const {
  requirePlainObject,
  validateOrganizationName,
  validateSlug,
  validateClerkId,
  validateRole,
  normalizeEmail,
} = require("../lib/validation");
const {
  listOrganizationsForUser,
  getOrganizationForMember,
  listOrganizationMembers,
  requireMembership,
  createOrganization,
  inviteOrganizationMember,
  updateOrganizationMemberRole,
  removeOrganizationMember,
  deleteOrganization,
} = require("../services/organizations");

async function listOrganizations(req, res) {
  const organizations = await listOrganizationsForUser(req.actor.userId);
  return res.status(200).json({ success: true, data: organizations });
}

async function getOrganization(req, res) {
  const organization = await getOrganizationForMember(
    req.organizationId,
    req.actor.userId
  );
  return res.status(200).json({ success: true, data: organization });
}

async function listMembers(req, res) {
  const membership = await requireMembership(
    req.organizationId,
    req.actor.userId
  );
  const members = await listOrganizationMembers(
    req.organizationId,
    membership.role
  );
  return res.status(200).json({ success: true, data: members });
}

async function create(req, res) {
  const body = requirePlainObject(req.body);
  const name = validateOrganizationName(body.name);
  const slug = body.slug ? validateSlug(body.slug) : null;

  const organization = await createOrganization({
    name,
    slug,
    userId: req.actor.userId,
  });

  return res.status(201).json({ success: true, data: organization });
}

async function invite(req, res) {
  const body = requirePlainObject(req.body);
  const emailAddress = normalizeEmail(body.emailAddress);
  const role = body.role ? validateRole(body.role) : "member";

  const invitation = await inviteOrganizationMember({
    organizationId: req.organizationId,
    emailAddress,
    role,
    actorUserId: req.actor.userId,
  });

  return res.status(201).json({ success: true, data: invitation });
}

async function updateMember(req, res) {
  const targetUserId = validateClerkId(req.params.userId, "user id");
  const body = requirePlainObject(req.body);
  const role = validateRole(body.role);

  const membership = await updateOrganizationMemberRole({
    organizationId: req.organizationId,
    targetUserId,
    role,
    actorUserId: req.actor.userId,
  });

  return res.status(200).json({ success: true, data: membership });
}

async function removeMember(req, res) {
  const targetUserId = validateClerkId(req.params.userId, "user id");

  await removeOrganizationMember({
    organizationId: req.organizationId,
    targetUserId,
    actorUserId: req.actor.userId,
  });

  return res.status(204).send();
}

async function removeOrganization(req, res) {
  const body = requirePlainObject(req.body);
  const name = validateOrganizationName(body.name);

  await deleteOrganization({
    organizationId: req.organizationId,
    actorUserId: req.actor.userId,
    name,
  });

  return res.status(204).send();
}

module.exports = {
  listOrganizations,
  getOrganization,
  listMembers,
  create,
  invite,
  updateMember,
  removeMember,
  removeOrganization,
};
