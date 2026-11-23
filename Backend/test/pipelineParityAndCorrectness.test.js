process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildRepositoryGraph } = require("../services/graph/graphPipeline");
const { resolveAndBuildGraph } = require("../services/ingestion/IncrementalGraphPublisher");
const { GraphQueryService } = require("../services/graph/GraphQueryService");
const { GraphValidator } = require("../services/graph/GraphValidator");
const { retrieveSourceFiles } = require("../services/sourceRetrieval");

const REPO = "test/repo";
const COMMIT_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// ============================================================================
// 1. Full vs Incremental Pipeline Parity
// ============================================================================

test("Pipeline Parity: Re-exports produce identical confirmed edges in full and incremental pipelines", async () => {
  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/index.ts", language: "typescript" },
    imports: [],
    exports: [
      {
        id: "exp_1",
        exportedName: "*",
        source: "./components/Button",
        location: { start: { line: 1, column: 0 }, end: { line: 1, column: 32 } },
      },
    ],
    calls: [],
    symbols: [],
  };

  const fileB = {
    schemaVersion: "1.0.0",
    file: { path: "src/components/Button.tsx", language: "typescript" },
    imports: [],
    exports: [{ id: "exp_2", exportedName: "Button" }],
    calls: [],
    symbols: [{ id: "sym_btn", name: "Button", kind: "component" }],
  };

  // Full Pipeline
  const fullResult = await buildRepositoryGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
  });

  // Incremental Pipeline
  const incResult = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
    options: { snapshotVersion: 1, batchNumber: 1, isFinal: true },
  });

  assert.equal(fullResult.snapshot.edges.length, incResult.snapshot.edges.length);
  const fullEdge = fullResult.snapshot.edges.find((e) => e.type === "imports");
  const incEdge = incResult.snapshot.edges.find((e) => e.type === "imports");

  assert.ok(fullEdge, "Full pipeline must have re-export import edge");
  assert.ok(incEdge, "Incremental pipeline must have re-export import edge");
  assert.equal(fullEdge.source, incEdge.source);
  assert.equal(fullEdge.target, incEdge.target);
  assert.equal(fullEdge.evidence[0].languageMetadata.isReexport, true);
  assert.equal(incEdge.evidence[0].languageMetadata.isReexport, true);
});

test("Pipeline Parity: TypeScript path aliases resolve identically in full and incremental pipelines", async () => {
  const tsconfigContent = JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    },
  });

  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/app.ts", language: "typescript" },
    imports: [
      {
        id: "imp_alias",
        rawSource: "@/utils/math",
        location: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
      },
    ],
    exports: [],
    calls: [],
    symbols: [],
  };

  const fileB = {
    schemaVersion: "1.0.0",
    file: { path: "src/utils/math.ts", language: "typescript" },
    imports: [],
    exports: [],
    calls: [],
    symbols: [{ id: "sym_add", name: "add", kind: "function" }],
  };

  const options = {
    supportingFiles: { "tsconfig.json": tsconfigContent },
    manifest: ["src/app.ts", "src/utils/math.ts", "tsconfig.json"],
  };

  const fullResult = await buildRepositoryGraph(
    { repositoryId: REPO, commitSha: COMMIT_SHA, fileIRList: [fileA, fileB] },
    options
  );

  const incResult = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
    options,
  });

  const fullEdge = fullResult.snapshot.edges.find((e) => e.type === "imports");
  const incEdge = incResult.snapshot.edges.find((e) => e.type === "imports");

  assert.ok(fullEdge, "Full pipeline must resolve @/* alias");
  assert.ok(incEdge, "Incremental pipeline must resolve @/* alias");
  assert.equal(fullEdge.target, incEdge.target);
  assert.match(fullEdge.target, /src\/utils\/math\.ts/);
});

test("Pipeline Parity: Manifest target gating resolves unparsed manifest targets identically in both pipelines", async () => {
  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/main.js", language: "javascript" },
    imports: [
      {
        id: "imp_json",
        rawSource: "./schema.json",
        location: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
      },
    ],
    exports: [],
    calls: [],
    symbols: [],
  };

  const manifest = ["src/main.js", "src/schema.json"];

  const fullResult = await buildRepositoryGraph(
    { repositoryId: REPO, commitSha: COMMIT_SHA, fileIRList: [fileA] },
    { manifest }
  );

  const incResult = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA],
    options: { manifest },
  });

  const fullNode = fullResult.snapshot.nodes.find((n) => n.path === "src/schema.json");
  const incNode = incResult.snapshot.nodes.find((n) => n.path === "src/schema.json");
  assert.ok(fullNode, "Full pipeline must create reference_only node for manifest target");
  assert.ok(incNode, "Incremental pipeline must create reference_only node for manifest target");
  assert.equal(fullNode.metadata.status, "reference_only");
  assert.equal(incNode.metadata.status, "reference_only");

  const fullEdge = fullResult.snapshot.edges.find((e) => e.type === "imports");
  const incEdge = incResult.snapshot.edges.find((e) => e.type === "imports");
  assert.ok(fullEdge);
  assert.ok(incEdge);
  assert.equal(fullEdge.target, incEdge.target);
});

test("Pipeline Parity: Java wildcard resolution with typeReferences behaves identically in both pipelines", async () => {
  const javaConsumer = {
    schemaVersion: "1.0.0",
    file: { path: "src/main/java/com/example/app/App.java", language: "java" },
    imports: [
      {
        id: "imp_service_wildcard",
        rawSource: "com.example.service.*",
        location: { start: { line: 1, column: 0 }, end: { line: 1, column: 30 } },
      },
    ],
    exports: [],
    calls: [],
    symbols: [],
    typeReferences: [{ text: "UserService", context: "variable" }],
  };

  const javaTarget = {
    schemaVersion: "1.0.0",
    file: { path: "src/main/java/com/example/service/UserService.java", language: "java" },
    imports: [],
    exports: [],
    calls: [],
    symbols: [{ id: "sym_user_service", name: "UserService", kind: "class" }],
  };

  const fullResult = await buildRepositoryGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [javaConsumer, javaTarget],
  });

  const incResult = resolveAndBuildGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [javaConsumer, javaTarget],
  });

  const fullEdge = fullResult.snapshot.edges.find((e) => e.type === "imports");
  const incEdge = incResult.snapshot.edges.find((e) => e.type === "imports");

  assert.ok(fullEdge, "Full pipeline must link to UserService.java via unique typeReference match");
  assert.ok(incEdge, "Incremental pipeline must link to UserService.java via unique typeReference match");
  assert.match(fullEdge.target, /UserService\.java/);
  assert.match(incEdge.target, /UserService\.java/);
});

// ============================================================================
// 2. Graph Correctness Verification
// ============================================================================

test("Graph Correctness: Manifest presence ALONE never creates a dependency edge", async () => {
  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/isolatedA.js", language: "javascript" },
    imports: [],
    exports: [],
    calls: [],
    symbols: [{ id: "sym_a", name: "foo", kind: "function" }],
  };

  const fileB = {
    schemaVersion: "1.0.0",
    file: { path: "src/isolatedB.js", language: "javascript" },
    imports: [],
    exports: [],
    calls: [],
    symbols: [{ id: "sym_b", name: "bar", kind: "function" }],
  };

  // Provide a manifest with 10 files
  const manifest = [
    "src/isolatedA.js",
    "src/isolatedB.js",
    "src/config.json",
    "README.md",
    "docs/guide.md",
    "public/favicon.ico",
    "styles/main.css",
    "scripts/build.sh",
    "package.json",
    "tsconfig.json",
  ];

  const result = await buildRepositoryGraph(
    { repositoryId: REPO, commitSha: COMMIT_SHA, fileIRList: [fileA, fileB] },
    { manifest }
  );

  const snapshot = result.snapshot;
  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);

  // Exactly 0 imports or call edges must exist
  const depEdges = snapshot.edges.filter((e) => e.type === "imports" || e.type === "calls" || e.type === "includes");
  assert.equal(depEdges.length, 0, "Manifest presence alone must NEVER produce any dependency edges");
});

test("Graph Correctness: Conditional C/C++ metadata survives serialization and GraphQueryService queries", async () => {
  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/main.cpp", language: "cpp" },
    symbols: [],
  };
  const fileB = {
    schemaVersion: "1.0.0",
    file: { path: "include/platform.h", language: "c_cpp_header" },
    symbols: [],
  };

  const evidence = [
    {
      id: "ev_cond_include",
      category: "dependency",
      sourceFile: "src/main.cpp",
      target: { resolvedPath: "include/platform.h" },
      status: { isConfirmed: true, normalized: "internal_resolved" },
      resolver: { name: "CppIncludeResolver", version: "1.0.0" },
      languageMetadata: { isConditional: true, condition: "#ifdef _WIN32" },
    },
  ];

  const fullResult = await buildRepositoryGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
    normalizedEvidenceList: evidence,
  });

  const snapshot = fullResult.snapshot;

  // 1. Check in-memory snapshot
  const rawEdge = snapshot.edges.find((e) => e.type === "includes");
  assert.ok(rawEdge);
  assert.equal(rawEdge.semanticQualifier, "conditional");
  assert.equal(rawEdge.metadata?.condition, "#ifdef _WIN32");

  // 2. Check JSON serialization round-trip
  const serialized = JSON.stringify(snapshot);
  const rehydrated = JSON.parse(serialized);

  // 3. Check GraphQueryService query behavior
  const queryService = new GraphQueryService(rehydrated);
  const queryEdges = queryService.getEdges({ edgeType: "includes" });
  assert.equal(queryEdges.edges.length, 1);
  const queriedEdge = queryEdges.edges[0];
  assert.equal(queriedEdge.semanticQualifier, "conditional");
  assert.equal(queriedEdge.metadata?.condition, "#ifdef _WIN32");

  const evidenceRes = queryService.getEdgeEvidence(queriedEdge.id);
  assert.ok(evidenceRes);
  assert.equal(evidenceRes[0].languageMetadata.isConditional, true);
  assert.equal(evidenceRes[0].languageMetadata.condition, "#ifdef _WIN32");
});

test("Graph Correctness: Java wildcard imports without typeReferences or with ambiguous types NEVER create speculative edges", async () => {
  const javaConsumer = {
    schemaVersion: "1.0.0",
    file: { path: "src/main/java/com/example/app/App.java", language: "java" },
    imports: [
      {
        id: "imp_service_wildcard",
        rawSource: "com.example.service.*",
        location: { start: { line: 1, column: 0 }, end: { line: 1, column: 30 } },
      },
    ],
    exports: [],
    calls: [],
    symbols: [],
    // App uses BOTH UserService and OrderService (ambiguous across wildcard)
    typeReferences: [{ text: "UserService" }, { text: "OrderService" }],
  };

  const serviceA = {
    schemaVersion: "1.0.0",
    file: { path: "src/main/java/com/example/service/UserService.java", language: "java" },
    imports: [],
    exports: [],
    calls: [],
    symbols: [{ id: "sym_user", name: "UserService", kind: "class" }],
  };

  const serviceB = {
    schemaVersion: "1.0.0",
    file: { path: "src/main/java/com/example/service/OrderService.java", language: "java" },
    imports: [],
    exports: [],
    calls: [],
    symbols: [{ id: "sym_order", name: "OrderService", kind: "class" }],
  };

  const result = await buildRepositoryGraph({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [javaConsumer, serviceA, serviceB],
  });

  const snapshot = result.snapshot;
  const depEdges = snapshot.edges.filter((e) => e.type === "imports");

  // Must NOT create speculative edges to all candidate classes
  assert.equal(
    depEdges.length,
    0,
    "Ambiguous Java wildcard import must NEVER produce speculative edges to all classes"
  );

  // Must preserve the wildcard fact in unresolvedReferences
  const unres = snapshot.unresolvedReferences.find((u) => u.rawSpecifier === "com.example.service.*");
  assert.ok(unres, "Ambiguous wildcard import must be recorded in unresolvedReferences");
  assert.equal(unres.status, "wildcard");
});

// ============================================================================
// 3. Retrieval Completeness & Bounded Budget Verification
// ============================================================================

test("Retrieval Architecture: Synchronous retrieval intentionally caps at 50 files and marks partial without failure", async () => {
  // Generate 75 mock manifest files
  const mockManifestFiles = Array.from({ length: 75 }, (_, i) => ({
    path: `src/file_${i}.js`,
    sha: `sha_${i}`.padEnd(40, "0"),
    size: 50,
    mode: "100644",
  }));

  const mockFetch = async (url) => {
    const requestedSha = String(url).split("/").pop();
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        sha: requestedSha,
        content: Buffer.from("console.log('test');").toString("base64"),
        encoding: "base64",
        size: 20,
      }),
    };
  };

  const result = await retrieveSourceFiles({
    owner: "test",
    repo: "repo",
    manifestFiles: mockManifestFiles,
    options: { fetchFn: mockFetch },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.summary.isTruncated, true);
  assert.equal(result.files.length, 50, "Synchronous retrieval must strictly cap at 50 files for request safety");
  assert.equal(result.skipped.length, 25, "Remaining 25 files must be recorded as budget_exceeded");
  assert.equal(result.skipped[0].reason, "budget_exceeded");
});
