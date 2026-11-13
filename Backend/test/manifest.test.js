const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}

const { AppError } = require("../lib/errors");
const {
  verifyGithubRepository,
  resolveCommitAndRootTree,
  fetchGitTree,
  traverseTreeBounded,
  discoverRepositoryManifest,
} = require("../services/github");
const { generateManifest } = require("../services/manifest");
const { generateManifest: manifestController } = require("../controllers/repositoryController");

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

// ========================================================
// 1. SUCCESSFUL RECURSIVE TREE RESPONSE
// ========================================================
test("1. Successful recursive tree response returns normalized manifest", async () => {
  const mockFetch = async (url) => {
    if (url.includes("/commits/")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            sha: "commit_sha_123",
            commit: { tree: { sha: "tree_sha_456" } },
          };
        },
      };
    }
    if (url.includes("/git/trees/")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            sha: "tree_sha_456",
            truncated: false,
            tree: [
              { path: "src/index.js", type: "blob", size: 1200, mode: "100644", sha: "sha_index" },
              { path: "README.md", type: "blob", size: 500, mode: "100644", sha: "sha_readme" },
            ],
          };
        },
      };
    }
    if (url.includes("/repos/octocat/hello-world")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            name: "hello-world",
            full_name: "octocat/hello-world",
            private: false,
            default_branch: "main",
          };
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const manifest = await discoverRepositoryManifest("octocat", "hello-world", { fetchFn: mockFetch });

  assert.equal(manifest.repository, "octocat/hello-world");
  assert.equal(manifest.commitSha, "commit_sha_123");
  assert.equal(manifest.rootTreeSha, "tree_sha_456");
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.truncated, false);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].path, "src/index.js");
  assert.equal(manifest.files[0].extension, ".js");
  assert.equal(manifest.summary.totalFiles, 2);
  assert.equal(manifest.summary.totalBytes, 1700);
});

// ========================================================
// 2. FILES AND DIRECTORIES SEPARATION
// ========================================================
test("2. Files and directories are correctly distinguished and counted", () => {
  const treeEntries = [
    { path: "src", type: "tree", mode: "040000", sha: "tree_1" },
    { path: "src/components", type: "tree", mode: "040000", sha: "tree_2" },
    { path: "src/components/Button.jsx", type: "blob", mode: "100644", size: 450, sha: "blob_1" },
    { path: "package.json", type: "blob", mode: "100644", size: 300, sha: "blob_2" },
  ];

  const manifest = generateManifest({
    repository: "octocat/hello-world",
    commitSha: "c1",
    rootTreeSha: "t1",
    treeEntries,
  });

  assert.equal(manifest.summary.totalDirectories, 2);
  assert.equal(manifest.summary.totalFiles, 2);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files.some((f) => f.type === "tree"), false);
});

// ========================================================
// 3. EMPTY REPOSITORY
// ========================================================
test("3. Empty repository handling returns empty manifest", async () => {
  const mockFetch = async (url) => {
    if (url.includes("/commits/")) {
      return {
        status: 409,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return { message: "Git Repository is empty." };
        },
      };
    }
    if (url.includes("/repos/octocat/empty-repo")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            name: "empty-repo",
            full_name: "octocat/empty-repo",
            private: false,
            default_branch: "main",
          };
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const manifest = await discoverRepositoryManifest("octocat", "empty-repo", { fetchFn: mockFetch });

  assert.equal(manifest.status, "empty");
  assert.equal(manifest.commitSha, null);
  assert.equal(manifest.files.length, 0);
  assert.equal(manifest.summary.totalFiles, 0);
});

// ========================================================
// 4. SYMLINK ENTRY
// ========================================================
test("4. Symlink entry (mode 120000) is classified in excluded array", () => {
  const treeEntries = [
    { path: "current_link", type: "blob", mode: "120000", size: 12, sha: "symlink_sha" },
    { path: "src/main.js", type: "blob", mode: "100644", size: 100, sha: "main_sha" },
  ];

  const manifest = generateManifest({
    repository: "octocat/hello-world",
    commitSha: "c1",
    rootTreeSha: "t1",
    treeEntries,
  });

  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, "src/main.js");
  assert.equal(manifest.excluded.length, 1);
  assert.equal(manifest.excluded[0].path, "current_link");
  assert.equal(manifest.excluded[0].reason, "symlink");
});

// ========================================================
// 5. SUBMODULE ENTRY
// ========================================================
test("5. Submodule entry (type commit or mode 160000) is classified in excluded array", () => {
  const treeEntries = [
    { path: "submodules/lib", type: "commit", mode: "160000", sha: "submodule_sha" },
    { path: "src/index.js", type: "blob", mode: "100644", size: 250, sha: "blob_sha" },
  ];

  const manifest = generateManifest({
    repository: "octocat/hello-world",
    commitSha: "c1",
    rootTreeSha: "t1",
    treeEntries,
  });

  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.excluded.length, 1);
  assert.equal(manifest.excluded[0].path, "submodules/lib");
  assert.equal(manifest.excluded[0].reason, "submodule");
});

// ========================================================
// 6. MISSING FILE SIZE METADATA
// ========================================================
test("6. Missing file size metadata is handled safely without crashing", () => {
  const treeEntries = [
    { path: "src/no-size.js", type: "blob", mode: "100644", sha: "sha_nosize" },
  ];

  const manifest = generateManifest({
    repository: "octocat/hello-world",
    commitSha: "c1",
    rootTreeSha: "t1",
    treeEntries,
  });

  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].size, null);
  assert.equal(manifest.summary.totalBytes, 0);
});

// ========================================================
// 7. TRUNCATED RECURSIVE TREE DETECTION
// ========================================================
test("7. Truncated recursive tree response without fallback is marked partial", () => {
  const treeEntries = [
    { path: "src/file1.js", type: "blob", mode: "100644", size: 100, sha: "sha1" },
  ];

  const manifest = generateManifest({
    repository: "octocat/hello-world",
    commitSha: "c1",
    rootTreeSha: "t1",
    treeEntries,
    truncated: true,
  });

  assert.equal(manifest.truncated, true);
  assert.equal(manifest.status, "partial");
  assert.equal(manifest.summary.isTruncated, true);
});

// ========================================================
// 8. NON-RECURSIVE FALLBACK
// ========================================================
test("8. Non-recursive fallback executes and completes when recursive tree is truncated", async () => {
  const mockFetch = async (url) => {
    // 1. Commits endpoint
    if (url.includes("/commits/")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return { sha: "c_sha", commit: { tree: { sha: "root_tree_sha" } } };
        },
      };
    }
    // 2. Initial recursive tree (reports truncated)
    if (url.includes("/git/trees/root_tree_sha?recursive=1")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return { sha: "root_tree_sha", truncated: true, tree: [] };
        },
      };
    }
    // 3. Fallback non-recursive root
    if (url.includes("/git/trees/root_tree_sha")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            sha: "root_tree_sha",
            truncated: false,
            tree: [
              { path: "README.md", type: "blob", size: 50, mode: "100644", sha: "sha_r" },
              { path: "src", type: "tree", mode: "040000", sha: "sub_tree_sha" },
            ],
          };
        },
      };
    }
    // 4. Fallback non-recursive subtree
    if (url.includes("/git/trees/sub_tree_sha")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            sha: "sub_tree_sha",
            truncated: false,
            tree: [
              { path: "app.js", type: "blob", size: 200, mode: "100644", sha: "sha_app" },
            ],
          };
        },
      };
    }
    if (url.includes("/repos/octocat/hello-world")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return { name: "hello-world", full_name: "octocat/hello-world", private: false, default_branch: "main" };
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const manifest = await discoverRepositoryManifest("octocat", "hello-world", {
    fetchFn: mockFetch,
    budgets: { maxTraversalRequests: 5 },
  });

  assert.equal(manifest.status, "complete");
  assert.equal(manifest.truncated, false);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files.some((f) => f.path === "src/app.js"), true);
});

// ========================================================
// 9. FALLBACK HITTING REQUEST LIMITS
// ========================================================
test("9. Fallback hitting request limit returns partial status with truncated flag", async () => {
  const mockFetch = async (url) => {
    if (url.includes("/git/trees/root_tree_sha")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            sha: "root_tree_sha",
            truncated: false,
            tree: [
              { path: "dir1", type: "tree", mode: "040000", sha: "tree_d1" },
              { path: "dir2", type: "tree", mode: "040000", sha: "tree_d2" },
            ],
          };
        },
      };
    }
    if (url.includes("/git/trees/tree_d1")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            sha: "tree_d1",
            truncated: false,
            tree: [{ path: "file1.js", type: "blob", size: 100, mode: "100644", sha: "s1" }],
          };
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  // Limit maxTraversalRequests to 1 (root request consumes the budget, dir1 and dir2 remain queued)
  const result = await traverseTreeBounded("octocat", "hello-world", "root_tree_sha", {
    fetchFn: mockFetch,
    maxTraversalRequests: 1,
  });

  assert.equal(result.truncated, true);
});

// ========================================================
// 10. GITHUB 404 AND 403 RESPONSES
// ========================================================
test("10. GitHub 404 and 403 responses map to REPOSITORY_NOT_FOUND", async () => {
  const mockFetch404 = async () => ({
    status: 404,
    headers: createMockHeaders(),
  });

  await assert.rejects(
    async () => fetchGitTree("octocat", "hello-world", "sha_missing", { fetchFn: mockFetch404 }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 404);
      assert.equal(err.code, "REPOSITORY_NOT_FOUND");
      return true;
    }
  );

  const mockFetch403 = async () => ({
    status: 403,
    headers: createMockHeaders(),
  });

  await assert.rejects(
    async () => fetchGitTree("octocat", "hello-world", "sha_forbidden", { fetchFn: mockFetch403 }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 404);
      assert.equal(err.code, "REPOSITORY_NOT_FOUND");
      return true;
    }
  );
});

// ========================================================
// 11. RATE LIMITING (403 / 429)
// ========================================================
test("11. GitHub rate limiting maps to GITHUB_RATE_LIMITED (429)", async () => {
  const mockFetchRateLimit = async () => ({
    status: 429,
    headers: createMockHeaders({
      "retry-after": "60",
    }),
  });

  await assert.rejects(
    async () => fetchGitTree("octocat", "hello-world", "sha_1", { fetchFn: mockFetchRateLimit }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 429);
      assert.equal(err.code, "GITHUB_RATE_LIMITED");
      assert.equal(err.retryAfterSeconds, 60);
      return true;
    }
  );
});

// ========================================================
// 12. NETWORK FAILURE AND TIMEOUT
// ========================================================
test("12. Network failure maps to 503 and timeout maps to 504", async () => {
  const mockFetchNetError = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    async () => fetchGitTree("octocat", "hello-world", "sha_1", { fetchFn: mockFetchNetError }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 503);
      assert.equal(err.code, "GITHUB_UNAVAILABLE");
      return true;
    }
  );

  const mockFetchTimeout = async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  await assert.rejects(
    async () => fetchGitTree("octocat", "hello-world", "sha_1", { fetchFn: mockFetchTimeout }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 504);
      assert.equal(err.code, "GITHUB_TIMEOUT");
      return true;
    }
  );
});

// ========================================================
// 13. INVALID OR UNEXPECTED API RESPONSE
// ========================================================
test("13. Invalid or non-JSON tree response maps to GITHUB_INVALID_RESPONSE (502)", async () => {
  const mockFetchInvalid = async () => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "text/html" }),
    async json() {
      throw new Error("Unexpected token < in JSON");
    },
  });

  await assert.rejects(
    async () => fetchGitTree("octocat", "hello-world", "sha_1", { fetchFn: mockFetchInvalid }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 502);
      assert.equal(err.code, "GITHUB_INVALID_RESPONSE");
      return true;
    }
  );
});

// ========================================================
// 14. REPOSITORY AUTHORIZATION REJECTION
// ========================================================
test("14. Repository authorization rejection for unauthenticated and missing org", async () => {
  const reqUnauth = {
    actor: null,
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };
  const res = {};

  await assert.rejects(
    async () => manifestController(reqUnauth, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 401);
      assert.equal(err.code, "UNAUTHENTICATED");
      return true;
    }
  );

  const reqNoOrg = {
    actor: { userId: "user_123", orgId: null },
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };

  await assert.rejects(
    async () => manifestController(reqNoOrg, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 403);
      assert.equal(err.code, "NO_ACTIVE_ORGANIZATION");
      return true;
    }
  );
});

// ========================================================
// 15. CONFIRM THAT NO BLOB CONTENT IS DOWNLOADED
// ========================================================
test("15. Confirms that no blob contents are ever downloaded", async () => {
  const calledUrls = [];

  const mockFetch = async (url) => {
    calledUrls.push(url);

    if (url.includes("/commits/")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return { sha: "c_sha", commit: { tree: { sha: "tree_sha" } } };
        },
      };
    }
    if (url.includes("/git/trees/")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return {
            sha: "tree_sha",
            truncated: false,
            tree: [
              { path: "src/app.js", type: "blob", size: 500, mode: "100644", sha: "blob_sha_1" },
            ],
          };
        },
      };
    }
    if (url.includes("/repos/octocat/hello-world")) {
      return {
        status: 200,
        headers: createMockHeaders({ "content-type": "application/json" }),
        async json() {
          return { name: "hello-world", full_name: "octocat/hello-world", private: false, default_branch: "main" };
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await discoverRepositoryManifest("octocat", "hello-world", { fetchFn: mockFetch });

  // Verify all URLs were metadata only
  for (const url of calledUrls) {
    assert.equal(url.includes("/git/blobs/"), false, `Forbidden blob content URL called: ${url}`);
    assert.equal(url.includes("/raw/"), false, `Forbidden raw content URL called: ${url}`);
    assert.equal(url.includes("/tarball/"), false, `Forbidden archive URL called: ${url}`);
    assert.equal(url.includes("/zipball/"), false, `Forbidden archive URL called: ${url}`);
  }
  assert.equal(calledUrls.length, 3);
});

