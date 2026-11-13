const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}

const { AppError } = require("../lib/errors");
const { classifyFile } = require("../services/languageRegistry");
const {
  decodeAndValidateUtf8Blob,
  runBoundedPool,
  selectEligibleFiles,
  retrieveSourceFiles,
} = require("../services/sourceRetrieval");
const { fetchGitBlob } = require("../services/github");
const { retrieveFiles: retrieveFilesController } = require("../controllers/repositoryController");

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
// LANGUAGE REGISTRY & CLASSIFICATION TESTS
// ========================================================
test("Language Registry: recognizes all 15 specified source languages", () => {
  const testCases = [
    { path: "src/app.js", lang: "javascript" },
    { path: "src/app.jsx", lang: "javascript" },
    { path: "src/app.mjs", lang: "javascript" },
    { path: "src/app.cjs", lang: "javascript" },
    { path: "src/main.ts", lang: "typescript" },
    { path: "src/main.tsx", lang: "typescript" },
    { path: "src/main.mts", lang: "typescript" },
    { path: "src/main.cts", lang: "typescript" },
    { path: "scripts/run.py", lang: "python" },
    { path: "scripts/run.pyi", lang: "python" },
    { path: "src/Main.java", lang: "java" },
    { path: "native/impl.c", lang: "c" },
    { path: "native/engine.cpp", lang: "cpp" },
    { path: "native/engine.cc", lang: "cpp" },
    { path: "native/engine.cxx", lang: "cpp" },
    { path: "native/engine.hpp", lang: "cpp" },
    { path: "native/engine.hh", lang: "cpp" },
    { path: "native/engine.hxx", lang: "cpp" },
    { path: "server/main.go", lang: "go" },
    { path: "core/lib.rs", lang: "rust" },
    { path: "Program.cs", lang: "csharp" },
    { path: "index.php", lang: "php" },
    { path: "app.rb", lang: "ruby" },
    { path: "Main.kt", lang: "kotlin" },
    { path: "Script.kts", lang: "kotlin" },
    { path: "App.swift", lang: "swift" },
    { path: "lib/main.dart", lang: "dart" },
    { path: "core/Main.scala", lang: "scala" },
    { path: "core/Main.sc", lang: "scala" },
  ];

  for (const tc of testCases) {
    const res = classifyFile(tc.path);
    assert.equal(res.category, "source", `Expected category 'source' for ${tc.path}`);
    assert.equal(res.language, tc.lang, `Expected language '${tc.lang}' for ${tc.path}`);
    assert.equal(res.isSource, true);
    assert.equal(res.isEligible, true);
  }
});

test("Language Registry: classifies supporting files distinctly from source", () => {
  // Dependency manifests
  assert.equal(classifyFile("package.json").category, "dependency_manifest");
  assert.equal(classifyFile("requirements.txt").category, "dependency_manifest");
  assert.equal(classifyFile("Cargo.toml").category, "dependency_manifest");
  assert.equal(classifyFile("go.mod").category, "dependency_manifest");
  assert.equal(classifyFile("pom.xml").category, "dependency_manifest");

  // Configuration
  assert.equal(classifyFile("tsconfig.json").category, "configuration");
  assert.equal(classifyFile("pyproject.toml").category, "configuration");

  // Build
  assert.equal(classifyFile("CMakeLists.txt").category, "build");
  assert.equal(classifyFile("Makefile").category, "build");

  // Schema
  assert.equal(classifyFile("api.proto").category, "schema");
  assert.equal(classifyFile("schema.graphql").category, "schema");

  // Documentation (optional)
  const docDefault = classifyFile("README.md");
  assert.equal(docDefault.category, "documentation");
  assert.equal(docDefault.isEligible, false); // Disabled by default

  const docIncluded = classifyFile("README.md", { includeDocumentation: true });
  assert.equal(docIncluded.category, "documentation");
  assert.equal(docIncluded.isEligible, true);
});

// ========================================================
// 1. SUCCESSFUL BLOB RETRIEVAL
// ========================================================
test("1. Successful blob retrieval: fetches and returns blob metadata", async () => {
  const mockFetch = async (url) => {
    assert.equal(url.includes("/git/blobs/b_123"), true);
    return {
      status: 200,
      headers: createMockHeaders({ "content-type": "application/json" }),
      async json() {
        return {
          sha: "b_123",
          size: 13,
          content: Buffer.from("console.log()").toString("base64"),
          encoding: "base64",
        };
      },
    };
  };

  const blob = await fetchGitBlob("octocat", "hello-world", "b_123", { fetchFn: mockFetch });
  assert.equal(blob.sha, "b_123");
  assert.equal(blob.encoding, "base64");
});

// ========================================================
// 2. BASE64 DECODING (PRESERVING UTF-8 SOURCE)
// ========================================================
test("2. Base64 decoding preserves original UTF-8 source text and characters", () => {
  const original = `function greet() { return "Hello, 🌍 world! áéíóú"; }`;
  const base64 = Buffer.from(original, "utf8").toString("base64");

  const res = decodeAndValidateUtf8Blob(base64);
  assert.equal(res.isValid, true);
  assert.equal(res.content, original);
  assert.equal(res.byteLength, Buffer.byteLength(original, "utf8"));
});

// ========================================================
// 3. MULTIPLE FILE RETRIEVAL
// ========================================================
test("3. Multiple file retrieval preserves relative paths, languages, and SHAs", async () => {
  const manifestFiles = [
    { path: "src/index.ts", sha: "sha_ts", size: 50 },
    { path: "lib/engine.go", sha: "sha_go", size: 60 },
    { path: "package.json", sha: "sha_pkg", size: 40 },
  ];

  const mockFetch = async (url) => {
    let text = "code";
    const sha = url.split("/").pop();
    if (url.includes("sha_ts")) text = "const a: number = 1;";
    if (url.includes("sha_go")) text = "package main";
    if (url.includes("sha_pkg")) text = '{"name":"test"}';

    return {
      status: 200,
      headers: createMockHeaders({ "content-type": "application/json" }),
      async json() {
        return {
          sha,
          size: text.length,
          content: Buffer.from(text).toString("base64"),
          encoding: "base64",
        };
      },
    };
  };

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    commitSha: "c_sha_1",
    manifestFiles,
    options: { fetchFn: mockFetch },
  });

  assert.equal(result.status, "complete");
  assert.equal(result.files.length, 3);
  assert.equal(result.files[0].path, "src/index.ts");
  assert.equal(result.files[0].language, "typescript");
  assert.equal(result.files[1].path, "lib/engine.go");
  assert.equal(result.files[1].language, "go");
  assert.equal(result.files[2].path, "package.json");
  assert.equal(result.files[2].category, "dependency_manifest");
  assert.equal(result.summary.retrieved, 3);
});

// ========================================================
// 4. BOUNDED CONCURRENCY
// ========================================================
test("4. Bounded concurrency limits active in-flight requests", async () => {
  let activeWorkers = 0;
  let maxObservedActive = 0;

  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const concurrencyLimit = 3;

  await runBoundedPool(items, concurrencyLimit, async () => {
    activeWorkers++;
    maxObservedActive = Math.max(maxObservedActive, activeWorkers);
    await new Promise((r) => setTimeout(r, 10));
    activeWorkers--;
  });

  assert.equal(maxObservedActive <= concurrencyLimit, true, `Observed concurrency ${maxObservedActive} exceeded limit ${concurrencyLimit}`);
});

// ========================================================
// 5. INVALID BASE64
// ========================================================
test("5. Invalid Base64 content is rejected safely", () => {
  const invalidBase64 = "###not-valid-base64-characters@@@";
  const res = decodeAndValidateUtf8Blob(invalidBase64);
  assert.equal(res.isValid, false);
  assert.equal(res.reason, "invalid_base64");
});

// ========================================================
// 6. INVALID UTF-8 & LEGITIMATE UNICODE
// ========================================================
test("6. Binary content containing null bytes is rejected", () => {
  const binaryBuffer = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x00, 0x6f]); // "hell\0o"
  const base64 = binaryBuffer.toString("base64");

  const res = decodeAndValidateUtf8Blob(base64);
  assert.equal(res.isValid, false);
  assert.equal(res.reason, "binary_content");
});

test("6b. Strict UTF-8 decoder accepts legitimate U+FFFD characters but rejects malformed UTF-8 byte sequences", () => {
  // Legitimate code containing literal U+FFFD replacement char in a string literal
  const legitimateUnicodeWithReplacement = `const placeholder = "\uFFFD";`;
  const validBase64 = Buffer.from(legitimateUnicodeWithReplacement, "utf8").toString("base64");
  const resValid = decodeAndValidateUtf8Blob(validBase64);
  assert.equal(resValid.isValid, true);
  assert.equal(resValid.content, legitimateUnicodeWithReplacement);

  // Corrupt UTF-8 byte sequence: 0xC3 followed by an invalid continuation byte 0x28
  const invalidUtf8Buffer = Buffer.from([0x68, 0x65, 0xc3, 0x28, 0x6f]);
  const invalidBase64 = invalidUtf8Buffer.toString("base64");
  const resInvalid = decodeAndValidateUtf8Blob(invalidBase64);
  assert.equal(resInvalid.isValid, false);
  assert.equal(resInvalid.reason, "invalid_utf8");
});

// ========================================================
// 7. MISSING BLOB (404)
// ========================================================
test("7. Missing blob (404) is tracked in failed array without crashing", async () => {
  const manifestFiles = [
    { path: "src/missing.js", sha: "sha_missing", size: 100 },
  ];

  const mockFetch = async () => ({
    status: 404,
    headers: createMockHeaders(),
  });

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: { fetchFn: mockFetch },
  });

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].path, "src/missing.js");
  assert.equal(result.failed[0].reason, "REPOSITORY_NOT_FOUND");
  assert.equal(result.summary.failed, 1);
});

// ========================================================
// 8. GITHUB RATE LIMITING
// ========================================================
test("8. GitHub rate limiting maps to GITHUB_RATE_LIMITED (429)", async () => {
  const manifestFiles = [
    { path: "src/index.js", sha: "sha_index", size: 100 },
  ];

  const mockFetch = async () => ({
    status: 429,
    headers: createMockHeaders({ "retry-after": "60" }),
  });

  await assert.rejects(
    async () =>
      retrieveSourceFiles({
        owner: "octocat",
        repo: "hello-world",
        manifestFiles,
        options: { fetchFn: mockFetch },
      }),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 429);
      assert.equal(err.code, "GITHUB_RATE_LIMITED");
      return true;
    }
  );
});

// ========================================================
// 9. TIMEOUT HANDLING
// ========================================================
test("9. Request timeout is handled and tracked as failed", async () => {
  const manifestFiles = [
    { path: "src/timeout.js", sha: "sha_timeout", size: 100 },
  ];

  const mockFetch = async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: { fetchFn: mockFetch, budgets: { maxRetries: 0 } },
  });

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, "GITHUB_TIMEOUT");
});

// ========================================================
// 10. NETWORK ERRORS
// ========================================================
test("10. Network failure is handled safely and reported in failed files", async () => {
  const manifestFiles = [
    { path: "src/neterror.js", sha: "sha_net", size: 100 },
  ];

  const mockFetch = async () => {
    throw new TypeError("fetch failed");
  };

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: { fetchFn: mockFetch, budgets: { maxRetries: 0 } },
  });

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, "GITHUB_UNAVAILABLE");
});

// ========================================================
// 11. OVERSIZED FILES
// ========================================================
test("11. Oversized file exceeding individual limit is skipped", () => {
  const manifestFiles = [
    { path: "src/huge.js", sha: "sha_huge", size: 1500000 },
    { path: "src/normal.js", sha: "sha_normal", size: 1000 },
  ];

  const { eligible, skipped } = selectEligibleFiles(manifestFiles, {
    maxFileSizeBytes: 1000000,
  });

  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].path, "src/normal.js");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].path, "src/huge.js");
  assert.equal(skipped[0].reason, "oversized");
});

// ========================================================
// 12. TOTAL REPOSITORY BYTE LIMIT & PRE-RESERVATION
// ========================================================
test("12. Total repository byte limit enforcement sets status to partial", async () => {
  const manifestFiles = [
    { path: "src/f1.js", sha: "sha_1", size: 500 },
    { path: "src/f2.js", sha: "sha_2", size: 500 },
  ];

  const mockFetch = async (url) => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "application/json" }),
    async json() {
      return {
        sha: url.split("/").pop(),
        size: 500,
        content: Buffer.from("x".repeat(500)).toString("base64"),
        encoding: "base64",
      };
    },
  });

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: {
      fetchFn: mockFetch,
      budgets: { maxTotalBytes: 600 }, // Only enough for 1 file
    },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.files.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "total_bytes_limit_exceeded");
  assert.equal(result.summary.isTruncated, true);
});

test("12b. Concurrency pre-reservation prevents 5 simultaneous downloads from exceeding aggregate budget", async () => {
  let downloadAttempts = 0;

  // 5 files, each 500 KB (total 2.5 MB)
  const manifestFiles = [
    { path: "src/f1.js", sha: "sha_1", size: 500000 },
    { path: "src/f2.js", sha: "sha_2", size: 500000 },
    { path: "src/f3.js", sha: "sha_3", size: 500000 },
    { path: "src/f4.js", sha: "sha_4", size: 500000 },
    { path: "src/f5.js", sha: "sha_5", size: 500000 },
  ];

  const mockFetch = async (url) => {
    downloadAttempts++;
    return {
      status: 200,
      headers: createMockHeaders({ "content-type": "application/json" }),
      async json() {
        return {
          sha: url.split("/").pop(),
          size: 500000,
          content: Buffer.from("x".repeat(500000)).toString("base64"),
          encoding: "base64",
        };
      },
    };
  };

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: {
      fetchFn: mockFetch,
      budgets: {
        maxTotalBytes: 1200000, // Budget only fits 2 files (1,000,000 bytes)
        concurrency: 5,
      },
    },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.files.length, 2);
  assert.equal(downloadAttempts <= 2, true, `Expected at most 2 HTTP downloads, but saw ${downloadAttempts}`);
  assert.equal(result.summary.totalBytes, 1000000);
});

// ========================================================
// 13. MAXIMUM FILE COUNT LIMIT
// ========================================================
test("13. Maximum file count limit caps retrieval and marks partial", async () => {
  const manifestFiles = [
    { path: "src/f1.js", sha: "sha_1", size: 10 },
    { path: "src/f2.js", sha: "sha_2", size: 10 },
    { path: "src/f3.js", sha: "sha_3", size: 10 },
  ];

  const mockFetch = async (url) => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "application/json" }),
    async json() {
      return {
        sha: url.split("/").pop(),
        size: 10,
        content: Buffer.from("console.log()").toString("base64"),
        encoding: "base64",
      };
    },
  });

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: {
      fetchFn: mockFetch,
      budgets: { maxRetrievalFiles: 2 },
    },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.files.length, 2);
  assert.equal(result.skipped.some((s) => s.reason === "budget_exceeded"), true);
});

// ========================================================
// 14. RETRY BEHAVIOR
// ========================================================
test("14. Transient failures are retried with bounded attempts", async () => {
  let callCount = 0;
  const manifestFiles = [
    { path: "src/f1.js", sha: "sha_1", size: 20 },
  ];

  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return { status: 503, headers: createMockHeaders() };
    }
    return {
      status: 200,
      headers: createMockHeaders({ "content-type": "application/json" }),
      async json() {
        return {
          sha: "sha_1",
          size: 20,
          content: Buffer.from("recovered code").toString("base64"),
          encoding: "base64",
        };
      },
    };
  };

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: { fetchFn: mockFetch, budgets: { maxRetries: 1 } },
  });

  assert.equal(callCount, 2);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].content, "recovered code");
});

// ========================================================
// 15. PARTIAL RETRIEVAL REPORTING
// ========================================================
test("15. Partial retrieval clearly distinguishes complete vs partial", async () => {
  const manifestFiles = [
    { path: "src/f1.js", sha: "sha_1", size: 10 },
    { path: "src/f2.js", sha: "sha_2", size: 10 },
  ];

  const mockFetch = async (url) => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "application/json" }),
    async json() {
      return {
        sha: url.split("/").pop(),
        size: 10,
        content: Buffer.from("test").toString("base64"),
        encoding: "base64",
      };
    },
  });

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: {
      fetchFn: mockFetch,
      budgets: { maxRetrievalFiles: 1 },
    },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.summary.isTruncated, true);
  assert.equal(result.summary.retrieved, 1);
  assert.equal(result.summary.skipped, 1);
});

// ========================================================
// 16. AUTHENTICATION & ORGANIZATION AUTHORIZATION
// ========================================================
test("16. Authentication and organization authorization are enforced on retrieval route", async () => {
  const reqUnauth = {
    actor: null,
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };
  const res = {};

  await assert.rejects(
    async () => retrieveFilesController(reqUnauth, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 401);
      assert.equal(err.code, "UNAUTHENTICATED");
      return true;
    }
  );

  const reqNoOrg = {
    actor: { userId: "user_test", orgId: null },
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };

  await assert.rejects(
    async () => retrieveFilesController(reqNoOrg, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 403);
      assert.equal(err.code, "NO_ACTIVE_ORGANIZATION");
      return true;
    }
  );
});

// ========================================================
// 17. CONFIRM NO REPOSITORY CODE IS EXECUTED
// ========================================================
test("17. Confirms that retrieved source code is never executed, eval'd, or written to shell", async () => {
  let executed = false;
  const maliciousCode = `executed = true; globalThis.hacked = true;`;

  const manifestFiles = [
    { path: "src/malicious.js", sha: "sha_mal", size: maliciousCode.length },
  ];

  const mockFetch = async () => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "application/json" }),
    async json() {
      return {
        sha: "sha_mal",
        size: maliciousCode.length,
        content: Buffer.from(maliciousCode).toString("base64"),
        encoding: "base64",
      };
    },
  });

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: { fetchFn: mockFetch },
  });

  assert.equal(executed, false);
  assert.equal(globalThis.hacked, undefined);
  assert.equal(result.files[0].content, maliciousCode);
});

// ========================================================
// BLOB INTEGRITY VALIDATION
// ========================================================
test("Blob integrity: rejects response when returned blob SHA mismatches manifest", async () => {
  const manifestFiles = [
    { path: "src/tampered.js", sha: "expected_sha_123", size: 50 },
  ];

  const mockFetch = async () => ({
    status: 200,
    headers: createMockHeaders({ "content-type": "application/json" }),
    async json() {
      return {
        sha: "different_tampered_sha_999",
        size: 50,
        content: Buffer.from("console.log()").toString("base64"),
        encoding: "base64",
      };
    },
  });

  const result = await retrieveSourceFiles({
    owner: "octocat",
    repo: "hello-world",
    manifestFiles,
    options: { fetchFn: mockFetch },
  });

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, "blob_sha_mismatch");
  assert.equal(result.files.length, 0);
});
