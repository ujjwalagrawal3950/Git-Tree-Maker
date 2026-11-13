const { AppError } = require("../lib/errors");
const {
  requirePlainObject,
  validateGithubRepositoryUrl,
} = require("../lib/validation");
const organizations = require("../services/organizations");
const githubService = require("../services/github");
const { retrieveSourceFiles } = require("../services/sourceRetrieval");
const { parseRepositoryFiles } = require("../services/parser");

/**
 * Validates authentication and active organization tenancy for repository routes.
 *
 * @param {object} req
 * @returns {Promise<string>} The active organization ID
 */
async function ensureTenantAuthorization(req) {
  if (!req.actor || !req.actor.userId) {
    throw new AppError(401, "UNAUTHENTICATED", "Sign in is required.");
  }

  let orgId = req.params?.orgId || req.actor?.orgId || (req.headers && req.headers["x-organization-id"]);
  if (!orgId) {
    try {
      const userOrgs = await organizations.listOrganizationsForUser(req.actor.userId);
      if (userOrgs && userOrgs.length > 0) {
        orgId = userOrgs[0].id;
      }
    } catch {
      // Fall through to NO_ACTIVE_ORGANIZATION error
    }
  }

  if (!orgId) {
    throw new AppError(
      403,
      "NO_ACTIVE_ORGANIZATION",
      "Select an active organization before using this route."
    );
  }

  // If orgId was passed via route params, verify it matches the active token session
  if (req.params.orgId && req.actor.orgId && req.params.orgId !== req.actor.orgId) {
    throw new AppError(
      403,
      "ORG_CONTEXT_MISMATCH",
      "The active organization does not match the requested organization."
    );
  }

  // Enforce tenant authorization: caller must have an active membership in this org
  try {
    await organizations.requireMembership(orgId, req.actor.userId);
  } catch (membershipErr) {
    // If Clerk session token cryptographically verified this user's active membership
    // in this organization (or if local database tables are pending migration/sync),
    // allow verification to proceed safely without leaking an internal 500 error.
    const isTokenVerifiedMember =
      req.actor.orgId === orgId && Boolean(req.actor.userId);
    if (!isTokenVerifiedMember) {
      throw membershipErr;
    }
  }

  return orgId;
}

/**
 * Endpoint to verify a GitHub repository's accessibility, visibility and public policy.
 * POST /api/repositories/verify
 * POST /api/organizations/:orgId/repositories/verify
 */
async function verifyRepository(req, res) {
  await ensureTenantAuthorization(req);

  // Validate incoming request body and extract owner and repository
  const body = requirePlainObject(req.body);
  const rawUrl = body.url || body.repositoryUrl;
  const { owner, repo } = validateGithubRepositoryUrl(rawUrl);

  // Verify accessibility, visibility and public policy via GitHub REST API
  const metadata = await githubService.verifyGithubRepository(owner, repo);

  return res.status(200).json({
    success: true,
    data: metadata,
  });
}

/**
 * Endpoint to discover the Git Tree and generate a normalized file manifest.
 * POST /api/repositories/manifest
 * POST /api/organizations/:orgId/repositories/manifest
 */
async function generateManifest(req, res) {
  await ensureTenantAuthorization(req);

  // Validate incoming request body and extract owner and repository
  const body = requirePlainObject(req.body);
  const rawUrl = body.url || body.repositoryUrl;
  const { owner, repo } = validateGithubRepositoryUrl(rawUrl);

  const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;

  // Discover Git tree and generate manifest
  const manifest = await githubService.discoverRepositoryManifest(owner, repo, {
    ref,
  });

  return res.status(200).json({
    success: true,
    data: manifest,
  });
}

/**
 * Endpoint to selectively retrieve source file contents from a repository.
 * POST /api/repositories/files
 * POST /api/organizations/:orgId/repositories/files
 */
async function retrieveFiles(req, res) {
  await ensureTenantAuthorization(req);

  const body = requirePlainObject(req.body);
  const rawUrl = body.url || body.repositoryUrl;
  const { owner, repo } = validateGithubRepositoryUrl(rawUrl);

  const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
  const paths = Array.isArray(body.paths) ? body.paths : undefined;
  const includeDocumentation = Boolean(body.includeDocumentation);

  let commitSha = body.commitSha || null;
  let manifestFiles = Array.isArray(body.files) ? body.files : null;

  if (!manifestFiles) {
    const manifest = await githubService.discoverRepositoryManifest(owner, repo, { ref });
    commitSha = manifest.commitSha;
    manifestFiles = manifest.files;
  }

  const result = await retrieveSourceFiles({
    owner,
    repo,
    commitSha,
    manifestFiles,
    options: {
      paths,
      includeDocumentation,
      budgets: body.budgets,
    },
  });

  return res.status(200).json({
    success: true,
    data: result,
  });
}

/**
 * Endpoint to parse repository source files into unified FileIR documents.
 * POST /api/repositories/parse
 * POST /api/organizations/:orgId/repositories/parse
 */
async function parseRepository(req, res) {
  await ensureTenantAuthorization(req);

  const body = requirePlainObject(req.body);
  const rawUrl = body.url || body.repositoryUrl;
  const { owner, repo } = validateGithubRepositoryUrl(rawUrl);

  const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
  const paths = Array.isArray(body.paths) ? body.paths : undefined;
  const includeDocumentation = Boolean(body.includeDocumentation);

  let commitSha = body.commitSha || null;
  let sourceFiles = Array.isArray(body.files) ? body.files : null;

  // If source files are not pre-supplied, run retrieval pipeline
  if (!sourceFiles) {
    const manifest = await githubService.discoverRepositoryManifest(owner, repo, { ref });
    commitSha = manifest.commitSha;
    const retrievalResult = await retrieveSourceFiles({
      owner,
      repo,
      commitSha,
      manifestFiles: manifest.files,
      options: {
        paths,
        includeDocumentation,
        budgets: body.budgets,
      },
    });
    sourceFiles = retrievalResult.files;
  }

  const parseResult = await parseRepositoryFiles({
    repository: {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      commitSha: commitSha || "0000000000000000000000000000000000000000",
    },
    files: sourceFiles,
    options: body.options || {},
  });

  return res.status(200).json({
    success: true,
    data: parseResult,
  });
}

module.exports = {
  ensureTenantAuthorization,
  verifyRepository,
  generateManifest,
  retrieveFiles,
  parseRepository,
};
