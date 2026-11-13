const { getAuth } = require("@clerk/express");
const { AppError } = require("../lib/errors");

function requireAuth(req, res, next) {
  let auth;
  try {
    auth = getAuth(req);
  } catch (error) {
    return next(
      new AppError(401, "UNAUTHENTICATED", "Sign in is required.", {
        cause: error,
      })
    );
  }

  if (!auth || !auth.userId) {
    return next(new AppError(401, "UNAUTHENTICATED", "Sign in is required."));
  }

  // Identity comes only from the verified Clerk session.
  req.actor = {
    userId: auth.userId,
    sessionId: auth.sessionId || null,
    orgId: auth.orgId || null,
    orgRole: auth.orgRole || null,
    orgSlug: auth.orgSlug || null,
  };

  return next();
}

function requireOrgContext(req, res, next) {
  const routeOrgId = req.params.orgId;

  if (!req.actor || !req.actor.userId) {
    return next(new AppError(401, "UNAUTHENTICATED", "Sign in is required."));
  }
  if (!req.actor.orgId) {
    return next(
      new AppError(
        403,
        "NO_ACTIVE_ORGANIZATION",
        "Select an active organization before using this route."
      )
    );
  }
  if (req.actor.orgId !== routeOrgId) {
    return next(
      new AppError(
        403,
        "ORG_CONTEXT_MISMATCH",
        "The active organization does not match the requested organization."
      )
    );
  }

  req.organizationId = routeOrgId;
  return next();
}

module.exports = { requireAuth, requireOrgContext };
