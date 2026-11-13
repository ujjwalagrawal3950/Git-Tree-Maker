const express = require("express");
const { requireAuth, requireOrgContext } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errors");
const {
  listOrganizations,
  getOrganization,
  listMembers,
  create,
  invite,
  updateMember,
  removeMember,
  removeOrganization,
} = require("../controllers/organizationController");
const {
  verifyRepository,
  generateManifest,
  retrieveFiles,
  parseRepository,
} = require("../controllers/repositoryController");

const routes = express.Router();

routes.get("/organizations", requireAuth, asyncHandler(listOrganizations));
routes.post("/organizations", requireAuth, asyncHandler(create));

routes.get(
  "/organizations/:orgId",
  requireAuth,
  requireOrgContext,
  asyncHandler(getOrganization)
);
routes.delete(
  "/organizations/:orgId",
  requireAuth,
  requireOrgContext,
  asyncHandler(removeOrganization)
);

routes.get(
  "/organizations/:orgId/members",
  requireAuth,
  requireOrgContext,
  asyncHandler(listMembers)
);
routes.patch(
  "/organizations/:orgId/members/:userId",
  requireAuth,
  requireOrgContext,
  asyncHandler(updateMember)
);
routes.delete(
  "/organizations/:orgId/members/:userId",
  requireAuth,
  requireOrgContext,
  asyncHandler(removeMember)
);

routes.post(
  "/organizations/:orgId/invitations",
  requireAuth,
  requireOrgContext,
  asyncHandler(invite)
);

routes.post(
  "/organizations/:orgId/repositories/verify",
  requireAuth,
  requireOrgContext,
  asyncHandler(verifyRepository)
);

routes.post(
  "/organizations/:orgId/repositories/manifest",
  requireAuth,
  requireOrgContext,
  asyncHandler(generateManifest)
);

routes.post(
  "/organizations/:orgId/repositories/files",
  requireAuth,
  requireOrgContext,
  asyncHandler(retrieveFiles)
);

routes.post(
  "/organizations/:orgId/repositories/parse",
  requireAuth,
  requireOrgContext,
  asyncHandler(parseRepository)
);

module.exports = routes;
