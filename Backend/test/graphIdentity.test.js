const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GRAPH_BUILDER_VERSION,
  FILE_IR_VERSION,
  EDGE_SEMANTICS,
  EDGE_SEMANTICS_DESCRIPTIONS,
  createFileNodeId,
  createSymbolNodeId,
  createExternalNodeId,
  createEdgeId,
  computeResolverFingerprint,
  createGraphSnapshotId,
  computeGraphCacheKey,
} = require("../services/graph/identity");

const {
  NORMALIZED_STATUSES,
  normalizeImportResolution,
  normalizeCallFact,
  normalizeInheritanceFact,
  normalizeResolverResults,
} = require("../services/graph/evidenceNormalizer");

const { JavaScriptModuleResolver } = require("../services/parser/resolvers/javascript/JavaScriptModuleResolver");
const { PythonImportResolver } = require("../services/parser/resolvers/python/PythonImportResolver");
const { JavaImportResolver } = require("../services/parser/resolvers/java/JavaImportResolver");
const { CppIncludeResolver } = require("../services/parser/resolvers/c_cpp/CppIncludeResolver");

const REPO = "facebook/react";
const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";

// ============================================================================
// 1. Same Symbol Name in Different Files
// ============================================================================
test("identity: same symbol name in different files yields distinct node IDs", () => {
  const fileA = createFileNodeId(REPO, SHA_A, "src/components/Button.tsx");
  const fileB = createFileNodeId(REPO, SHA_A, "src/components/Input.tsx");

  assert.notEqual(fileA, fileB);

  const symButtonRender = {
    id: "sym_0",
    name: "render",
    kind: "function",
    location: { start: { line: 10, column: 2 } },
  };

  const symInputRender = {
    id: "sym_0",
    name: "render",
    kind: "function",
    location: { start: { line: 10, column: 2 } },
  };

  const idA = createSymbolNodeId(fileA, symButtonRender);
  const idB = createSymbolNodeId(fileB, symInputRender);

  assert.notEqual(idA, idB);
  assert.equal(idA, `${fileA}#sym_0`);
  assert.equal(idB, `${fileB}#sym_0`);
});

// ============================================================================
// 2. Overloaded Functions (Different Signatures)
// ============================================================================
test("identity: overloaded functions in same file yield distinct deterministic node IDs", () => {
  const fileId = createFileNodeId(REPO, SHA_A, "src/math/vector.cpp");

  // Overload 1: add(int a, int b) at line 15
  const overload1 = {
    name: "add",
    qualifiedName: "Math::Vector::add",
    kind: "function",
    parameters: [{ type: "int", name: "a" }, { type: "int", name: "b" }],
    location: { start: { line: 15, column: 0 }, end: { line: 18, column: 1 } },
  };

  // Overload 2: add(double a, double b) at line 20
  const overload2 = {
    name: "add",
    qualifiedName: "Math::Vector::add",
    kind: "function",
    parameters: [{ type: "double", name: "a" }, { type: "double", name: "b" }],
    location: { start: { line: 20, column: 0 }, end: { line: 23, column: 1 } },
  };

  const id1 = createSymbolNodeId(fileId, overload1, { preferDeterministicCoordinates: true });
  const id2 = createSymbolNodeId(fileId, overload2, { preferDeterministicCoordinates: true });

  assert.notEqual(id1, id2);
  assert.ok(id1.includes("(int,int):15_0"));
  assert.ok(id2.includes("(double,double):20_0"));
});

// ============================================================================
// 3. Nested Symbols
// ============================================================================
test("identity: nested symbols preserve lexical and hierarchy distinction", () => {
  const fileId = createFileNodeId(REPO, SHA_A, "src/database/Connection.ts");

  const classSymbol = {
    id: "sym_0",
    name: "Connection",
    qualifiedName: "Database.Connection",
    kind: "class",
    location: { start: { line: 5, column: 0 } },
  };

  const methodSymbol = {
    id: "sym_1",
    name: "connect",
    qualifiedName: "Database.Connection.connect",
    kind: "method",
    parentSymbolId: "sym_0",
    location: { start: { line: 12, column: 4 } },
  };

  const standaloneConnect = {
    id: "sym_2",
    name: "connect",
    qualifiedName: "connect",
    kind: "function",
    parentSymbolId: null,
    location: { start: { line: 40, column: 0 } },
  };

  const classId = createSymbolNodeId(fileId, classSymbol);
  const methodId = createSymbolNodeId(fileId, methodSymbol);
  const standaloneId = createSymbolNodeId(fileId, standaloneConnect);

  assert.notEqual(classId, methodId);
  assert.notEqual(methodId, standaloneId);

  // Coordinates disambiguation also preserves hierarchy
  const methodDetId = createSymbolNodeId(fileId, methodSymbol, { preferDeterministicCoordinates: true });
  const standaloneDetId = createSymbolNodeId(fileId, standaloneConnect, { preferDeterministicCoordinates: true });

  assert.notEqual(methodDetId, standaloneDetId);
  assert.ok(methodDetId.includes("Database.Connection.connect"));
  assert.ok(standaloneDetId.includes("connect:40_0"));
});

// ============================================================================
// 4. Duplicate Qualified Names Disambiguated by Source Location
// ============================================================================
test("identity: duplicate qualified names disambiguated by source location coordinates", () => {
  const fileId = createFileNodeId(REPO, SHA_A, "src/scopes.cpp");

  // Block 1 local declaration
  const localA = {
    name: "result",
    qualifiedName: "process::result",
    kind: "variable",
    location: { start: { line: 25, column: 8 } },
  };

  // Block 2 local declaration with exact same qualifiedName and kind
  const localB = {
    name: "result",
    qualifiedName: "process::result",
    kind: "variable",
    location: { start: { line: 45, column: 8 } },
  };

  const idA = createSymbolNodeId(fileId, localA, { preferDeterministicCoordinates: true });
  const idB = createSymbolNodeId(fileId, localB, { preferDeterministicCoordinates: true });

  assert.notEqual(idA, idB);
  assert.ok(idA.endsWith(":25_8"));
  assert.ok(idB.endsWith(":45_8"));
});

// ============================================================================
// 5. Stable Identities for Identical Revision Inputs (Determinism)
// ============================================================================
test("identity: identical revision inputs produce exact stable identities", () => {
  const fileA = createFileNodeId(REPO, SHA_A, "src/index.ts");
  const fileB = createFileNodeId(REPO, SHA_A, "src/index.ts");
  assert.equal(fileA, fileB);

  const sym = {
    id: "sym_42",
    name: "main",
    kind: "function",
    parameters: [{ type: "string" }],
    location: { start: { line: 10, column: 0 } },
  };

  const symIdA = createSymbolNodeId(fileA, sym);
  const symIdB = createSymbolNodeId(fileB, sym);
  assert.equal(symIdA, symIdB);

  const cacheKeyA = computeGraphCacheKey({ repositoryId: REPO, commitSha: SHA_A });
  const cacheKeyB = computeGraphCacheKey({ repositoryId: REPO, commitSha: SHA_A });
  assert.equal(cacheKeyA, cacheKeyB);
});

// ============================================================================
// 6. Different Identities for Different Revisions (Commit SHA Sensitivity)
// ============================================================================
test("identity: different revisions yield distinct file node IDs, symbol IDs, and cache keys", () => {
  const fileRevA = createFileNodeId(REPO, SHA_A, "src/index.ts");
  const fileRevB = createFileNodeId(REPO, SHA_B, "src/index.ts");

  assert.notEqual(fileRevA, fileRevB);
  assert.ok(fileRevA.includes(SHA_A));
  assert.ok(fileRevB.includes(SHA_B));

  const sym = { id: "sym_0", name: "App", kind: "class" };
  const symRevA = createSymbolNodeId(fileRevA, sym);
  const symRevB = createSymbolNodeId(fileRevB, sym);
  assert.notEqual(symRevA, symRevB);

  const snapshotA = createGraphSnapshotId({ repositoryId: REPO, commitSha: SHA_A });
  const snapshotB = createGraphSnapshotId({ repositoryId: REPO, commitSha: SHA_B });
  assert.notEqual(snapshotA, snapshotB);

  const cacheKeyA = computeGraphCacheKey({ repositoryId: REPO, commitSha: SHA_A });
  const cacheKeyB = computeGraphCacheKey({ repositoryId: REPO, commitSha: SHA_B });
  assert.notEqual(cacheKeyA, cacheKeyB);
});

// ============================================================================
// 7. Resolver Status Normalization for JS/TS, Python, Java, and C/C++
// ============================================================================
test("normalizer: normalizes JavaScript/TypeScript resolver statuses", () => {
  const manifest = ["src/index.ts", "src/utils.ts"];
  const jsResolver = new JavaScriptModuleResolver({ manifest });

  // 1. Internal resolved
  const r1 = jsResolver.resolveSpecifier("src/index.ts", "./utils");
  const n1 = normalizeImportResolution(r1, { resolverName: "JavaScriptModuleResolver", sourceFile: "src/index.ts" });
  assert.equal(n1.status.original, "internal_resolved");
  assert.equal(n1.status.normalized, NORMALIZED_STATUSES.RESOLVED);
  assert.equal(n1.status.isConfirmed, true);
  assert.equal(n1.target.resolvedPath, "src/utils.ts");

  // 2. External package
  const r2 = jsResolver.resolveSpecifier("src/index.ts", "lodash");
  const n2 = normalizeImportResolution(r2, { resolverName: "JavaScriptModuleResolver", sourceFile: "src/index.ts" });
  assert.equal(n2.status.original, "external_package");
  assert.equal(n2.status.normalized, NORMALIZED_STATUSES.EXTERNAL_PACKAGE);
  assert.equal(n2.status.isConfirmed, false);
  assert.equal(n2.target.packageName, "lodash");

  // 3. Node builtin
  const r3 = jsResolver.resolveSpecifier("src/index.ts", "fs");
  const n3 = normalizeImportResolution(r3, { resolverName: "JavaScriptModuleResolver", sourceFile: "src/index.ts" });
  assert.equal(n3.status.original, "builtin");
  assert.equal(n3.status.normalized, NORMALIZED_STATUSES.STANDARD_LIBRARY);
  assert.equal(n3.status.isConfirmed, false);

  // 4. Unresolved
  const r4 = jsResolver.resolveSpecifier("src/index.ts", "./nonexistent");
  const n4 = normalizeImportResolution(r4, { resolverName: "JavaScriptModuleResolver", sourceFile: "src/index.ts" });
  assert.equal(n4.status.original, "unresolved");
  assert.equal(n4.status.normalized, NORMALIZED_STATUSES.UNRESOLVED);
  assert.equal(n4.status.isConfirmed, false);
});

test("normalizer: normalizes Python resolver statuses", () => {
  const manifest = ["app/__init__.py", "app/main.py", "app/models.py"];
  const pyResolver = new PythonImportResolver({ manifest });

  // 1. Internal resolved
  const r1 = pyResolver.resolveImport("app/main.py", ".models");
  const n1 = normalizeImportResolution(r1, { resolverName: "PythonImportResolver", sourceFile: "app/main.py" });
  assert.equal(n1.status.original, "internal_resolved");
  assert.equal(n1.status.normalized, NORMALIZED_STATUSES.RESOLVED);
  assert.equal(n1.status.isConfirmed, true);
  assert.equal(n1.target.resolvedPath, "app/models.py");

  // 2. Standard library
  const r2 = pyResolver.resolveImport("app/main.py", "os");
  const n2 = normalizeImportResolution(r2, { resolverName: "PythonImportResolver", sourceFile: "app/main.py" });
  assert.equal(n2.status.original, "standard_library");
  assert.equal(n2.status.normalized, NORMALIZED_STATUSES.STANDARD_LIBRARY);
  assert.equal(n2.status.isConfirmed, false);

  // 3. External package
  const r3 = pyResolver.resolveImport("app/main.py", "requests");
  const n3 = normalizeImportResolution(r3, { resolverName: "PythonImportResolver", sourceFile: "app/main.py" });
  assert.equal(n3.status.original, "external_package");
  assert.equal(n3.status.normalized, NORMALIZED_STATUSES.EXTERNAL_PACKAGE);
  assert.equal(n3.status.isConfirmed, false);
  assert.equal(n3.target.packageName, "requests");
});

test("normalizer: normalizes Java resolver statuses", () => {
  const manifest = [
    "src/main/java/com/example/app/Main.java",
    "src/main/java/com/example/service/UserService.java",
  ];
  const javaResolver = new JavaImportResolver({ manifest });

  // 1. Internal resolved
  const r1 = javaResolver.resolveImport(
    "src/main/java/com/example/app/Main.java",
    "com.example.service.UserService"
  );
  const n1 = normalizeImportResolution(r1, {
    resolverName: "JavaImportResolver",
    sourceFile: "src/main/java/com/example/app/Main.java",
  });
  assert.equal(n1.status.original, "internal_resolved");
  assert.equal(n1.status.normalized, NORMALIZED_STATUSES.RESOLVED);
  assert.equal(n1.status.isConfirmed, true);
  assert.equal(n1.target.resolvedPath, "src/main/java/com/example/service/UserService.java");

  // 2. Standard library
  const r2 = javaResolver.resolveImport("src/main/java/com/example/app/Main.java", "java.util.List");
  const n2 = normalizeImportResolution(r2, {
    resolverName: "JavaImportResolver",
    sourceFile: "src/main/java/com/example/app/Main.java",
  });
  assert.equal(n2.status.original, "standard_library");
  assert.equal(n2.status.normalized, NORMALIZED_STATUSES.STANDARD_LIBRARY);
  assert.equal(n2.status.isConfirmed, false);

  // 3. Wildcard
  const r3 = javaResolver.resolveImport("src/main/java/com/example/app/Main.java", "com.example.service.*");
  const n3 = normalizeImportResolution(r3, {
    resolverName: "JavaImportResolver",
    sourceFile: "src/main/java/com/example/app/Main.java",
  });
  assert.equal(n3.status.original, "wildcard");
  assert.equal(n3.status.normalized, NORMALIZED_STATUSES.WILDCARD);
  assert.equal(n3.status.isConfirmed, false);
});

test("normalizer: normalizes C/C++ resolver statuses", () => {
  const manifest = [
    "src/main.cpp",
    "src/helper.h",
    "include/utils/math.h",
  ];
  const cppResolver = new CppIncludeResolver({ manifest });

  // 1. Internal resolved
  const r1 = cppResolver.resolveInclude("src/main.cpp", "helper.h", { includeType: "quoted" });
  const n1 = normalizeImportResolution(r1, { resolverName: "CppIncludeResolver", sourceFile: "src/main.cpp" });
  assert.equal(n1.status.original, "internal_resolved");
  assert.equal(n1.status.normalized, NORMALIZED_STATUSES.RESOLVED);
  assert.equal(n1.status.isConfirmed, true);
  assert.equal(n1.target.resolvedPath, "src/helper.h");

  // 2. Standard library
  const r2 = cppResolver.resolveInclude("src/main.cpp", "vector", { includeType: "system" });
  const n2 = normalizeImportResolution(r2, { resolverName: "CppIncludeResolver", sourceFile: "src/main.cpp" });
  assert.equal(n2.status.original, "standard_library");
  assert.equal(n2.status.normalized, NORMALIZED_STATUSES.STANDARD_LIBRARY);
  assert.equal(n2.status.isConfirmed, false);

  // 3. Unsupported include (e.g. macro or malformed)
  const r3 = {
    status: "unsupported",
    resolvedPath: null,
    candidates: null,
    rule: "unsupported_computed_macro_include",
    evidence: { sourceFile: "src/main.cpp", location: { start: { line: 5, column: 0 } } },
  };
  const n3 = normalizeImportResolution(r3, { resolverName: "CppIncludeResolver" });
  assert.equal(n3.status.original, "unsupported");
  assert.equal(n3.status.normalized, NORMALIZED_STATUSES.UNSUPPORTED);
  assert.equal(n3.status.isConfirmed, false);
});

// ============================================================================
// 8. Ambiguous Candidates Remain Ambiguous
// ============================================================================
test("normalizer: ambiguous candidates remain ambiguous and retain candidates array", () => {
  const ambiguousRes = {
    id: "imp_ambig",
    rawSource: "common/types.h",
    status: "ambiguous",
    resolvedPath: null,
    candidates: ["sub_a/common/types.h", "sub_b/common/types.h"],
    rule: "multiple_manifest_candidates",
    evidence: {
      sourceFile: "src/main.cpp",
      location: { start: { line: 3, column: 0 }, end: { line: 3, column: 25 } },
      resolverVersion: "1.0.0",
    },
  };

  const norm = normalizeImportResolution(ambiguousRes, { resolverName: "CppIncludeResolver" });

  assert.equal(norm.status.original, "ambiguous");
  assert.equal(norm.status.normalized, NORMALIZED_STATUSES.AMBIGUOUS);
  assert.equal(norm.status.isConfirmed, false);
  assert.equal(norm.status.confidence, "low");
  assert.deepEqual(norm.target.candidates, ["sub_a/common/types.h", "sub_b/common/types.h"]);
  assert.equal(norm.target.resolvedPath, null);
});

// ============================================================================
// 9. Unresolved & Unsupported References Never Become Confirmed Evidence
// ============================================================================
test("normalizer: unresolved, dynamic, and call facts never become confirmed evidence", () => {
  // Unresolved import
  const unresolvedRes = {
    status: "unresolved",
    resolvedPath: null,
    candidates: null,
    rule: "not_found",
  };
  const normUnresolved = normalizeImportResolution(unresolvedRes);
  assert.equal(normUnresolved.status.isConfirmed, false);

  // Dynamic import
  const dynamicRes = {
    status: "dynamic",
    resolvedPath: null,
    candidates: null,
    rule: "computed_specifier",
  };
  const normDynamic = normalizeImportResolution(dynamicRes);
  assert.equal(normDynamic.status.isConfirmed, false);

  // Lexical function call site (Gate 10B prohibits speculative call resolution)
  const callFact = {
    id: "call_12",
    callee: "processData",
    enclosingSymbolId: "sym_0",
    argumentsCount: 2,
    location: { start: { line: 55, column: 4 }, end: { line: 55, column: 24 } },
  };
  const normCall = normalizeCallFact(callFact, "src/service.ts");
  assert.equal(normCall.category, "call");
  assert.equal(normCall.status.isConfirmed, false);
  assert.equal(normCall.status.normalized, NORMALIZED_STATUSES.UNCONFIRMED);
  assert.equal(normCall.target.resolvedPath, null);
  assert.equal(normCall.target.rawSpecifier, "processData");
  assert.equal(normCall.languageMetadata.enclosingSymbolId, "sym_0");
  assert.equal(normCall.languageMetadata.argumentsCount, 2);
});

// ============================================================================
// 10. Provenance Is Retained
// ============================================================================
test("normalizer: retains complete provenance across metadata, rule, and locations", () => {
  const javaRes = {
    id: "imp_7",
    rawSource: "com.example.repo.CustomEntity",
    status: "internal_resolved",
    resolvedPath: "src/main/java/com/example/repo/CustomEntity.java",
    resolvedSymbolId: "sym_10",
    resolvedSymbolName: "CustomEntity",
    rule: "fqn_manifest_match",
    packageName: "com.example.repo",
    evidence: {
      sourceFile: "src/main/java/com/example/service/EntityService.java",
      location: { start: { line: 4, column: 0 }, end: { line: 4, column: 45 } },
      resolverVersion: "1.0.0",
      resolverName: "JavaImportResolver",
      isStatic: false,
      isWildcard: false,
      fullyQualifiedName: "com.example.repo.CustomEntity",
    },
  };

  const norm = normalizeImportResolution(javaRes);

  assert.equal(norm.id, "ev_imp_7");
  assert.equal(norm.sourceFile, "src/main/java/com/example/service/EntityService.java");
  assert.equal(norm.sourceFactId, "imp_7");
  assert.deepEqual(norm.sourceLocation, { start: { line: 4, column: 0 }, end: { line: 4, column: 45 } });
  assert.equal(norm.resolver.name, "JavaImportResolver");
  assert.equal(norm.resolver.version, "1.0.0");
  assert.equal(norm.resolver.rule, "fqn_manifest_match");
  assert.equal(norm.target.resolvedSymbolId, "sym_10");
  assert.equal(norm.target.resolvedSymbolName, "CustomEntity");
  assert.equal(norm.languageMetadata.fullyQualifiedName, "com.example.repo.CustomEntity");
});

// ============================================================================
// 11. Edge Semantics and 5-Dimensional Cache Key
// ============================================================================
test("identity: edge semantics and 5-dimensional graph cache key verification", () => {
  // Edge semantics
  assert.equal(EDGE_SEMANTICS.CONTAINS, "contains");
  assert.equal(EDGE_SEMANTICS.MEMBER_OF, "member_of");
  assert.equal(EDGE_SEMANTICS.DEFINES, "defines");
  assert.ok(EDGE_SEMANTICS_DESCRIPTIONS[EDGE_SEMANTICS.CONTAINS]);
  assert.ok(EDGE_SEMANTICS_DESCRIPTIONS[EDGE_SEMANTICS.MEMBER_OF]);
  assert.ok(EDGE_SEMANTICS_DESCRIPTIONS[EDGE_SEMANTICS.DEFINES]);

  const fileNode = createFileNodeId(REPO, SHA_A, "src/math.cpp");
  const symDef = createSymbolNodeId(fileNode, { id: "sym_0", name: "add", kind: "function" });
  const edgeDefines = createEdgeId(fileNode, EDGE_SEMANTICS.DEFINES, symDef);
  assert.equal(edgeDefines, `${fileNode} -[defines]-> ${symDef}`);

  // 5-dimensional cache key
  const fingerprint = computeResolverFingerprint({
    js: "1.0.0",
    python: "1.0.0",
    java: "1.0.0",
    cpp: "1.0.0",
  });
  assert.ok(fingerprint.includes(`ir_${FILE_IR_VERSION}`));
  assert.ok(fingerprint.includes(`bld_${GRAPH_BUILDER_VERSION}`));
  assert.ok(fingerprint.includes("js_1.0.0"));
  assert.ok(fingerprint.includes("py_1.0.0"));
  assert.ok(fingerprint.includes("java_1.0.0"));
  assert.ok(fingerprint.includes("cpp_1.0.0"));

  const cacheKey = computeGraphCacheKey({
    repositoryId: REPO,
    commitSha: SHA_A,
    builderVersion: GRAPH_BUILDER_VERSION,
    fileIrVersion: FILE_IR_VERSION,
    resolverFingerprint: fingerprint,
  });

  assert.equal(
    cacheKey,
    `cartograph:graph:${REPO}:${SHA_A}:bld_${GRAPH_BUILDER_VERSION}:ir_${FILE_IR_VERSION}:rf_${fingerprint}`
  );
});

// ============================================================================
// 12. Batch Resolver Normalization
// ============================================================================
test("normalizer: normalizeResolverResults handles repository-level resolver outputs", () => {
  const repoOutput = {
    summary: { totalResolutions: 2, internalResolved: 1, unresolved: 1 },
    files: [
      {
        file: "src/a.ts",
        resolutions: [
          {
            id: "imp_0",
            rawSource: "./b",
            status: "internal_resolved",
            resolvedPath: "src/b.ts",
            rule: "relative_exact",
          },
          {
            id: "imp_1",
            rawSource: "./c",
            status: "unresolved",
            resolvedPath: null,
            rule: "not_found",
          },
        ],
      },
    ],
  };

  const results = normalizeResolverResults(repoOutput, { resolverName: "JavaScriptModuleResolver" });
  assert.equal(results.length, 2);
  assert.equal(results[0].sourceFile, "src/a.ts");
  assert.equal(results[0].status.isConfirmed, true);
  assert.equal(results[1].sourceFile, "src/a.ts");
  assert.equal(results[1].status.isConfirmed, false);
});
