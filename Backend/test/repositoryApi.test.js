const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY =
    "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}

const { verifyRepository } = require("../controllers/repositoryController");
const { AppError } = require("../lib/errors");
const organizations = require("../services/organizations");

// Phase 03 acceptance: API-level coverage for validation behaviour.
// The existing suite in github.test.js covers authorization outcomes
// (401/403) and the success path; these two cases complete the spec's
// API-level list: "invalid URL returns a stable client error" and
// "authenticated but unauthorized organization member is rejected".

function createResSpy() {
  const state = { statusCalled: null, jsonCalled: null };
  return {
    state,
    res: {
      status(code) {
        state.statusCalled = code;
        return this;
      },
      json(body) {
        state.jsonCalled = body;
        return this;
      },
    },
  };
}

test("API: invalid URL returns a stable 400 INVALID_GITHUB_URL and never contacts GitHub", async () => {
  const originalFetch = globalThis.fetch;
  const originalMembership = organizations.requireMembership;
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("network access must not happen for an invalid URL");
  };
  organizations.requireMembership = async () => ({
    organizationId: "org_api_test",
    userId: "user_api_test",
    role: "member",
  });

  const { state, res } = createResSpy();
  const req = {
    actor: { userId: "user_api_test", orgId: "org_api_test" },
    params: { orgId: "org_api_test" },
    body: { url: "https://github.com.attacker.example/octocat/Hello-World" },
  };

  try {
    await assert.rejects(
      async () => verifyRepository(req, res),
      (err) => {
        assert.equal(err instanceof AppError, true);
        assert.equal(err.status, 400);
        assert.equal(err.code, "INVALID_GITHUB_URL");
        assert.equal(err.message, "Enter a valid GitHub repository URL.");
        return true;
      }
    );

    // No outbound request, and no success response was written.
    assert.equal(fetchCalled, false);
    assert.equal(state.statusCalled, null);
    assert.equal(state.jsonCalled, null);
  } finally {
    globalThis.fetch = originalFetch;
    organizations.requireMembership = originalMembership;
  }
});

test("API: authenticated non-member of an organization is rejected with 404 NOT_FOUND", async () => {
  const originalMembership = organizations.requireMembership;

  // The caller's session does not claim this organization (orgId null), so the
  // token-verified membership fallback does not apply and the membership error
  // surfaces unchanged. 404 avoids confirming the organization exists.
  organizations.requireMembership = async () => {
    throw new AppError(
      404,
      "NOT_FOUND",
      "The requested organization was not found."
    );
  };

  const { state, res } = createResSpy();
  const req = {
    actor: { userId: "user_outsider", orgId: null },
    params: { orgId: "org_not_member" },
    body: { url: "https://github.com/octocat/Hello-World" },
  };

  try {
    await assert.rejects(
      async () => verifyRepository(req, res),
      (err) => {
        assert.equal(err instanceof AppError, true);
        assert.equal(err.status, 404);
        assert.equal(err.code, "NOT_FOUND");
        return true;
      }
    );

    // Rejected before any response, repository metadata, or record creation.
    assert.equal(state.statusCalled, null);
    assert.equal(state.jsonCalled, null);
  } finally {
    organizations.requireMembership = originalMembership;
  }
});
