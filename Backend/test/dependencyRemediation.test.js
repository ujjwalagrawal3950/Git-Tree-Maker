const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildRepositoryGraph } = require("../services/graph/graphPipeline");
const { JavaImportResolver } = require("../services/parser/resolvers/java/JavaImportResolver");
const { JavaScriptModuleResolver } = require("../services/parser/resolvers/javascript/JavaScriptModuleResolver");
const { GraphBuilder } = require("../services/graph/GraphBuilder");
const { GraphValidator } = require("../services/graph/GraphValidator");

test("Stage 2 Remediation: JavaScript/TypeScript re-exports produce confirmed dependency edges", async () => {
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

  const result = await buildRepositoryGraph({
    repositoryId: "test/repo",
    commitSha: "a".repeat(40),
    fileIRList: [fileA, fileB],
  });

  const snapshot = result.snapshot;
  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);

  const importEdge = snapshot.edges.find((e) => e.type === "imports");
  assert.ok(importEdge, "Expected an imports edge from re-export");
  assert.match(importEdge.source, /src\/index\.ts/);
  assert.match(importEdge.target, /src\/components\/Button\.tsx/);
  assert.equal(importEdge.evidence[0].languageMetadata.isReexport, true);
});

test("Stage 2 Remediation: TypeScript path aliases resolve with supportingFiles tsconfig.json", () => {
  const tsconfigContent = JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
  });

  const manifest = [
    "src/components/Button.tsx",
    "src/utils/helpers.ts",
    "tsconfig.json",
  ];

  const resolver = new JavaScriptModuleResolver({
    manifest,
    supportingFiles: { "tsconfig.json": tsconfigContent },
  });

  const resolved = resolver.resolveSpecifier("src/components/Button.tsx", "@/utils/helpers");
  assert.equal(resolved.status, "internal_resolved");
  assert.equal(resolved.resolvedPath, "src/utils/helpers.ts");
});

test("Stage 2 Remediation: Manifest target gating confirms imports to manifest assets and unparsed files", async () => {
  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/main.js", language: "javascript" },
    imports: [
      {
        id: "imp_json",
        rawSource: "./data.json",
        location: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
      },
    ],
    exports: [],
    calls: [],
    symbols: [],
  };

  // Note: data.json is in repository manifest, but not in fileIRList (e.g. non-code or unparsed file)
  const manifest = [
    "src/main.js",
    "src/data.json",
  ];

  const result = await buildRepositoryGraph({
    repositoryId: "test/repo",
    commitSha: "b".repeat(40),
    fileIRList: [fileA],
  }, { manifest });

  const snapshot = result.snapshot;
  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);

  const jsonNode = snapshot.nodes.find((n) => n.path === "src/data.json");
  assert.ok(jsonNode, "Expected reference_only file node for src/data.json");
  assert.equal(jsonNode.metadata.status, "reference_only");

  const edge = snapshot.edges.find((e) => e.type === "imports");
  assert.ok(edge, "Expected confirmed edge from src/main.js to src/data.json");
  assert.match(edge.target, /src\/data\.json/);
});

test("Stage 2 Remediation: Java wildcard import links to unique typeReference candidate", () => {
  const manifest = [
    "src/main/java/com/example/service/UserService.java",
    "src/main/java/com/example/service/OrderService.java",
    "src/main/java/com/example/app/App.java",
  ];

  const resolver = new JavaImportResolver({ manifest });

  // 1. Unique match via typeReferences
  const singleMatch = resolver.resolveImport(
    "src/main/java/com/example/app/App.java",
    "com.example.service.*",
    {
      typeReferences: [{ text: "UserService", context: "variable" }],
    }
  );
  assert.equal(singleMatch.status, "internal_resolved");
  assert.equal(singleMatch.resolvedPath, "src/main/java/com/example/service/UserService.java");
  assert.equal(singleMatch.rule, "internal_package_wildcard_type_match");

  // 2. Multiple matches retain wildcard without creating arbitrary edge
  const multipleMatch = resolver.resolveImport(
    "src/main/java/com/example/app/App.java",
    "com.example.service.*",
    {
      typeReferences: [{ text: "UserService" }, { text: "OrderService" }],
    }
  );
  assert.equal(multipleMatch.status, "wildcard");
  assert.equal(multipleMatch.resolvedPath, null);
  assert.equal(multipleMatch.rule, "internal_package_wildcard_multiple_match");

  // 3. No match retains wildcard
  const noMatch = resolver.resolveImport(
    "src/main/java/com/example/app/App.java",
    "com.example.service.*",
    {
      typeReferences: [{ text: "UnrelatedClass" }],
    }
  );
  assert.equal(noMatch.status, "wildcard");
  assert.equal(noMatch.resolvedPath, null);
});

test("Stage 2 Remediation: C/C++ conditional include preserves semanticQualifier 'conditional'", () => {
  const builder = new GraphBuilder();

  const fileA = {
    file: { path: "src/main.cpp", language: "cpp" },
    symbols: [],
  };
  const fileB = {
    file: { path: "include/platform.h", language: "c_cpp_header" },
    symbols: [],
  };

  const evidence = [
    {
      id: "ev_cond_1",
      category: "dependency",
      sourceFile: "src/main.cpp",
      target: { resolvedPath: "include/platform.h" },
      status: { isConfirmed: true, normalized: "internal_resolved" },
      resolver: { name: "CppIncludeResolver", version: "1.0.0" },
      languageMetadata: { isConditional: true, condition: "defined(_WIN32)" },
    },
  ];

  const snapshot = builder.build({
    repositoryId: "test/repo",
    commitSha: "c".repeat(40),
    fileIRList: [fileA, fileB],
    normalizedEvidenceList: evidence,
  });

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);

  const edge = snapshot.edges.find((e) => e.type === "includes");
  assert.ok(edge);
  assert.equal(edge.semanticQualifier, "conditional");
  assert.equal(edge.metadata.condition, "defined(_WIN32)");
});

test("Stage 2 Remediation: GraphBuilder accurately records isPartial and completeness", () => {
  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: "test/repo",
    commitSha: "d".repeat(40),
    fileIRList: [],
    normalizedEvidenceList: [],
  }, { isPartial: true });

  assert.equal(snapshot.statistics.isPartial, true);
  assert.equal(snapshot.statistics.completeness, "partial");
});
