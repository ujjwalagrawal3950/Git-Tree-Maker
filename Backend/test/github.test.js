const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}

const { validateGithubRepositoryUrl } = require("../lib/validation");
const { verifyGithubRepository } = require("../services/github");
const { verifyRepository } = require("../controllers/repositoryController");
const { AppError } = require("../lib/errors");

// Helper to mock Headers object
function createMockHeaders(headersObj = {}) {
  const normalized = {};
  for (const [k, v] of Object.entries(headersObj)) {
    normalized[k.toLowerCase()] = String(v);
  }
  return {
    get(name) {
      return normalized[name.toLowerCase()] || null;
    },
  };
}

// ==========================================
// 1. URL VALIDATION TESTS
// ==========================================

test("URL validator: accepts standard HTTPS repository URL", () => {
  const result = validateGithubRepositoryUrl("https://github.com/octocat/Hello-World");
  assert.equal(result.owner, "octocat");
  assert.equal(result.repo, "Hello-World");
  assert.equal(result.canonicalUrl, "https://github.com/octocat/Hello-World");
});

test("URL validator: accepts URL with trailing slash", () => {
  const result = validateGithubRepositoryUrl("https://github.com/octocat/Hello-World/");
  assert.equal(result.owner, "octocat");
  assert.equal(result.repo, "Hello-World");
  assert.equal(result.canonicalUrl, "https://github.com/octocat/Hello-World");
});

test("URL validator: accepts URL with .git suffix and normalizes it", () => {
  const result = validateGithubRepositoryUrl("https://github.com/octocat/Hello-World.git");
  assert.equal(result.owner, "octocat");
  assert.equal(result.repo, "Hello-World");
  assert.equal(result.canonicalUrl, "https://github.com/octocat/Hello-World");
});

test("URL validator: accepts repos with dots and hyphens", () => {
  const result = validateGithubRepositoryUrl("https://github.com/my-org/my.cool-repo_1");
  assert.equal(result.owner, "my-org");
  assert.equal(result.repo, "my.cool-repo_1");
});

test("URL validator: rejects invalid or dangerous inputs", () => {
  const invalidInputs = [
    "",
    "   ",
    "http://github.com/octocat/Hello-World", // non-HTTPS
    "https://github.com.attacker.example/octocat/Hello-World", // attacker host
    "https://notgithub.com/octocat/Hello-World", // wrong host
    "https://user:pass@github.com/octocat/Hello-World", // credentials
    "https://github.com/octocat", // missing repo
    "https://github.com/octocat/repo/extra/path", // extra path segments
    "https://github.com/octocat/repo?query=1", // query params
    "https://github.com/octocat/repo#readme", // fragment
    "https://github.com/octocat/../admin/repo", // path traversal
    "https://github.com/-badowner/repo", // invalid owner
    "https://github.com/owner/.", // invalid repo
    "https://github.com/owner/..", // invalid repo
    12345, // non-string
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => validateGithubRepositoryUrl(input),
      (err) => err instanceof AppError && err.code === "INVALID_GITHUB_URL",
      `Expected input "${input}" to throw INVALID_GITHUB_URL`
    );
  }
});

// ==========================================
// 2. GITHUB API SERVICE TESTS
// ==========================================

test("GitHub Service: public repository returns structured metadata", async () => {
  const mockFetch = async (url) => {
    assert.equal(url, "https://api.github.com/repos/octocat/Hello-World");
    return {
      status: 200,
      headers: createMockHeaders({ "content-type": "application/json" }),
      async json() {
        return {
          name: "Hello-World",
          full_name: "octocat/Hello-World",
          private: false,
          owner: { login: "octocat" },
          default_branch: "main",
          html_url: "https://github.com/octocat/Hello-World",
          description: "My first repository",
          extra_sensitive_field: "should_not_leak",
        };
      },
    };
  };

  const metadata = await verifyGithubRepository("octocat", "Hello-World", {
    fetchFn: mockFetch,
  });

  assert.deepEqual(metadata, {
    owner: "octocat",
    repo: "Hello-World",
    fullName: "octocat/Hello-World",
    isPrivate: false,
    defaultBranch: "main",
    htmlUrl: "https://github.com/octocat/Hello-World",
    description: "My first repository",
  });
  // Verify extra fields are excluded
  assert.equal(metadata.extra_sensitive_field, undefined);
});

test("GitHub Service: explicitly private repository is rejected", async () => {
  const mockFetch = async () => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "application/json" }),
    async json() {
      return {
        name: "Secret-Repo",
        full_name: "octocat/Secret-Repo",
        private: true,
        owner: { login: "octocat" },
      };
    },
  });

  await assert.rejects(
    async () => verifyGithubRepository("octocat", "Secret-Repo", { fetchFn: mockFetch }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 403);
      assert.equal(err.code, "PRIVATE_REPOSITORY");
      assert.equal(err.message, "Private repositories are not supported.");
      return true;
    }
  );
});

test("GitHub Service: 404 response maps to REPOSITORY_NOT_FOUND", async () => {
  const mockFetch = async () => ({
    status: 404,
    headers: createMockHeaders(),
  });

  await assert.rejects(
    async () => verifyGithubRepository("octocat", "Nonexistent", { fetchFn: mockFetch }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 404);
      assert.equal(err.code, "REPOSITORY_NOT_FOUND");
      return true;
    }
  );
});

test("GitHub Service: 403 / 429 rate limit response maps to GITHUB_RATE_LIMITED", async () => {
  const mockFetch = async () => ({
    status: 403,
    headers: createMockHeaders({
      "x-ratelimit-remaining": "0",
      "retry-after": "60",
    }),
  });

  await assert.rejects(
    async () => verifyGithubRepository("octocat", "Hello-World", { fetchFn: mockFetch }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 429);
      assert.equal(err.code, "GITHUB_RATE_LIMITED");
      assert.equal(err.retryAfterSeconds, 60);
      return true;
    }
  );
});

test("GitHub Service: 301 redirect response maps to REPOSITORY_MOVED", async () => {
  const mockFetch = async () => ({
    status: 301,
    headers: createMockHeaders({
      location: "https://api.github.com/repositories/12345",
    }),
  });

  await assert.rejects(
    async () => verifyGithubRepository("octocat", "Old-Name", { fetchFn: mockFetch }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 301);
      assert.equal(err.code, "REPOSITORY_MOVED");
      return true;
    }
  );
});

test("GitHub Service: network failure maps to GITHUB_UNAVAILABLE (503)", async () => {
  const mockFetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    async () => verifyGithubRepository("octocat", "Hello-World", { fetchFn: mockFetch }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 503);
      assert.equal(err.code, "GITHUB_UNAVAILABLE");
      return true;
    }
  );
});

test("GitHub Service: request timeout maps to GITHUB_TIMEOUT (504)", async () => {
  const mockFetch = async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  await assert.rejects(
    async () => verifyGithubRepository("octocat", "Hello-World", { fetchFn: mockFetch }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 504);
      assert.equal(err.code, "GITHUB_TIMEOUT");
      return true;
    }
  );
});

test("GitHub Service: invalid non-JSON API response maps to GITHUB_INVALID_RESPONSE (502)", async () => {
  const mockFetch = async () => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "text/html" }),
    async json() {
      throw new Error("Unexpected token < in JSON at position 0");
    },
  });

  await assert.rejects(
    async () => verifyGithubRepository("octocat", "Hello-World", { fetchFn: mockFetch }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 502);
      assert.equal(err.code, "GITHUB_INVALID_RESPONSE");
      return true;
    }
  );
});

// ==========================================
// 3. API CONTROLLER & AUTHORIZATION TESTS
// ==========================================

test("API Controller: unauthenticated request is rejected (401)", async () => {
  const req = {
    actor: null,
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };
  const res = {};

  await assert.rejects(
    async () => verifyRepository(req, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 401);
      assert.equal(err.code, "UNAUTHENTICATED");
      return true;
    }
  );
});

test("API Controller: missing active organization is rejected (403)", async () => {
  const req = {
    actor: { userId: "user_test_123", orgId: null },
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };
  const res = {};

  await assert.rejects(
    async () => verifyRepository(req, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 403);
      assert.equal(err.code, "NO_ACTIVE_ORGANIZATION");
      return true;
    }
  );
});

test("API Controller: organization context mismatch is rejected (403)", async () => {
  const req = {
    actor: { userId: "user_test_123", orgId: "org_actual_123" },
    body: { url: "https://github.com/octocat/Hello-World" },
    params: { orgId: "org_different_456" },
  };
  const res = {};

  await assert.rejects(
    async () => verifyRepository(req, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 403);
      assert.equal(err.code, "ORG_CONTEXT_MISMATCH");
      return true;
    }
  );
});

test("API Controller: successful verification returns metadata and creates NO database records or jobs", async () => {
  // Mock global fetch for controller execution
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://api.github.com/repos/facebook/react");
    return {
      status: 200,
      headers: createMockHeaders({ "content-type": "application/json" }),
      async json() {
        return {
          name: "react",
          full_name: "facebook/react",
          private: false,
          owner: { login: "facebook" },
          default_branch: "main",
          html_url: "https://github.com/facebook/react",
          description: "The library for web and native user interfaces.",
        };
      },
    };
  };

  try {
    // Mock requireMembership to succeed for this test user/org
    const organizations = require("../services/organizations");
    const originalRequireMembership = organizations.requireMembership;
    organizations.requireMembership = async (orgId, userId) => {
      assert.equal(orgId, "org_cartograph_1");
      assert.equal(userId, "user_developer_1");
      return { organizationId: orgId, userId, role: "member" };
    };

    let responseStatus = null;
    let responseBody = null;

    const req = {
      actor: { userId: "user_developer_1", orgId: "org_cartograph_1" },
      params: { orgId: "org_cartograph_1" },
      body: { url: "https://github.com/facebook/react" },
    };

    const res = {
      status(code) {
        responseStatus = code;
        return this;
      },
      json(data) {
        responseBody = data;
        return this;
      },
    };

    await verifyRepository(req, res);

    organizations.requireMembership = originalRequireMembership;

    assert.equal(responseStatus, 200);
    assert.equal(responseBody.success, true);
    assert.deepEqual(responseBody.data, {
      owner: "facebook",
      repo: "react",
      fullName: "facebook/react",
      isPrivate: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/facebook/react",
      description: "The library for web and native user interfaces.",
    });

    // Verify no jobs or side-effect records were created
    assert.equal(responseBody.jobId, undefined);
    assert.equal(responseBody.analysisId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ==========================================
// 4. END-TO-END EXPRESS ROUTE REGISTRATION TESTS
// ==========================================

test("Express App: POST /api/repositories/verify is protected by authentication (401)", async () => {
  const app = require("../app");
  const http = require("http");

  let statusCode = null;
  let responseData = "";

  const mockReq = new http.IncomingMessage();
  mockReq.method = "POST";
  mockReq.url = "/api/repositories/verify";
  mockReq.headers = {
    "content-type": "application/json",
  };
  mockReq.socket = { remoteAddress: "127.0.0.1" };

  const mockRes = new http.ServerResponse(mockReq);
  mockRes.headers = {};
  mockRes.setHeader = (k, v) => {
    mockRes.headers[k.toLowerCase()] = v;
  };
  mockRes.getHeader = (k) => mockRes.headers[k.toLowerCase()];
  mockRes.appendHeader = (k, v) => {
    mockRes.headers[k.toLowerCase()] = v;
  };
  mockRes.writeHead = (status) => {
    statusCode = status;
  };
  mockRes.end = (chunk) => {
    if (chunk) responseData += chunk;
    mockRes.emit("finish");
  };

  await new Promise((resolve) => {
    mockRes.on("finish", resolve);
    mockReq.push(JSON.stringify({ url: "https://github.com/octocat/Hello-World" }));
    mockReq.push(null);
    app.handle(mockReq, mockRes);
  });

  assert.equal(mockRes.statusCode, 401);
  const parsed = JSON.parse(responseData);
  assert.equal(parsed.success, false);
  assert.equal(parsed.error.code, "UNAUTHENTICATED");
});

test("Express App: POST /api/organizations/:orgId/repositories/verify is protected by authentication (401)", async () => {
  const app = require("../app");
  const http = require("http");

  let responseData = "";

  const mockReq = new http.IncomingMessage();
  mockReq.method = "POST";
  mockReq.url = "/api/organizations/org_123/repositories/verify";
  mockReq.headers = {
    "content-type": "application/json",
  };
  mockReq.socket = { remoteAddress: "127.0.0.1" };

  const mockRes = new http.ServerResponse(mockReq);
  mockRes.headers = {};
  mockRes.setHeader = (k, v) => {
    mockRes.headers[k.toLowerCase()] = v;
  };
  mockRes.getHeader = (k) => mockRes.headers[k.toLowerCase()];
  mockRes.appendHeader = (k, v) => {
    mockRes.headers[k.toLowerCase()] = v;
  };
  mockRes.end = (chunk) => {
    if (chunk) responseData += chunk;
    mockRes.emit("finish");
  };

  await new Promise((resolve) => {
    mockRes.on("finish", resolve);
    mockReq.push(JSON.stringify({ url: "https://github.com/octocat/Hello-World" }));
    mockReq.push(null);
    app.handle(mockReq, mockRes);
  });

  assert.equal(mockRes.statusCode, 401);
  const parsed = JSON.parse(responseData);
  assert.equal(parsed.success, false);
  assert.equal(parsed.error.code, "UNAUTHENTICATED");
});
