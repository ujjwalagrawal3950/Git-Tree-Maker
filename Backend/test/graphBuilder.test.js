const test = require("node:test");
const assert = require("node:assert/strict");

const { GraphBuilder } = require("../services/graph/GraphBuilder");
const { EDGE_SEMANTICS } = require("../services/graph/identity");
const { NORMALIZED_STATUSES } = require("../services/graph/evidenceNormalizer");

const REPO = "facebook/react";
const COMMIT_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function createMockFileIR(filePath, language, symbols = [], options = {}) {
  return {
    schemaVersion: "1.0.0",
    file: {
      path: filePath,
      blobSha: options.blobSha || "abc123sha",
      language,
    },
    status: options.status || "complete",
    metrics: { lines: options.lines || 100 },
    symbols,
    diagnostics: options.diagnostics || [],
  };
}

test("graphBuilder: builds canonical snapshot with file and symbol nodes", () => {
  const builder = new GraphBuilder();

  const fileA = createMockFileIR("src/index.ts", "typescript", [
    {
      id: "sym_0",
      name: "App",
      qualifiedName: "App",
      kind: "class",
      location: { start: { line: 5, column: 0 }, end: { line: 20, column: 1 } },
    },
    {
      id: "sym_1",
      name: "render",
      qualifiedName: "App.render",
      kind: "method",
      parentSymbolId: "sym_0",
      location: { start: { line: 10, column: 2 }, end: { line: 15, column: 3 } },
    },
  ]);

  const fileB = createMockFileIR("src/utils.ts", "typescript", [
    {
      id: "sym_0",
      name: "formatDate",
      qualifiedName: "formatDate",
      kind: "function",
      location: { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } },
    },
  ]);

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
  });

  assert.equal(snapshot.schemaVersion, "1.0.0");
  assert.equal(snapshot.repository.repositoryId, REPO);
  assert.equal(snapshot.revision.commitSha, COMMIT_SHA);

  // Nodes: 2 file nodes + 3 symbol nodes = 5 nodes
  assert.equal(snapshot.nodes.length, 5);
  assert.equal(snapshot.statistics.fileNodes, 2);
  assert.equal(snapshot.statistics.symbolNodes, 3);

  // Containment Edges:
  // src/index.ts -> App (contains)
  // App -> render (member_of)
  // src/utils.ts -> formatDate (contains)
  assert.equal(snapshot.edges.length, 3);
  const containsEdges = snapshot.edges.filter((e) => e.type === EDGE_SEMANTICS.CONTAINS);
  const memberEdges = snapshot.edges.filter((e) => e.type === EDGE_SEMANTICS.MEMBER_OF);
  assert.equal(containsEdges.length, 2);
  assert.equal(memberEdges.length, 1);
});

test("graphBuilder: aggregates confirmed import edges and deduplicates multiple evidence items", () => {
  const builder = new GraphBuilder();

  const fileA = createMockFileIR("src/main.ts", "typescript");
  const fileB = createMockFileIR("src/helper.ts", "typescript");

  const evidence1 = {
    id: "ev_imp_1",
    category: "dependency",
    sourceFile: "src/main.ts",
    sourceFactId: "imp_1",
    sourceLocation: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
    resolver: { name: "JavaScriptModuleResolver", version: "1.0.0", rule: "relative_exact" },
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true, confidence: "high" },
    target: { resolvedPath: "src/helper.ts", rawSpecifier: "./helper" },
  };

  const evidence2 = {
    id: "ev_imp_2",
    category: "dependency",
    sourceFile: "src/main.ts",
    sourceFactId: "imp_2",
    sourceLocation: { start: { line: 2, column: 0 }, end: { line: 2, column: 30 } },
    resolver: { name: "JavaScriptModuleResolver", version: "1.0.0", rule: "relative_exact" },
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true, confidence: "high" },
    target: { resolvedPath: "src/helper.ts", rawSpecifier: "./helper" },
  };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
    normalizedEvidenceList: [evidence1, evidence2],
  });

  // Single deduplicated edge between src/main.ts and src/helper.ts
  const importEdges = snapshot.edges.filter((e) => e.type === EDGE_SEMANTICS.IMPORTS);
  assert.equal(importEdges.length, 1);

  // Both evidence items are preserved under edge.evidence
  assert.equal(importEdges[0].evidence.length, 2);
  assert.equal(importEdges[0].evidence[0].id, "ev_imp_1");
  assert.equal(importEdges[0].evidence[1].id, "ev_imp_2");
});

test("graphBuilder: preserves unresolved and ambiguous references in unresolvedReferences without confirmed edges", () => {
  const builder = new GraphBuilder();

  const fileA = createMockFileIR("src/main.cpp", "cpp");

  const ambiguousEvidence = {
    id: "ev_ambig",
    category: "dependency",
    sourceFile: "src/main.cpp",
    sourceFactId: "inc_0",
    sourceLocation: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
    resolver: { name: "CppIncludeResolver", version: "1.0.0", rule: "ambiguous_match" },
    status: { original: "ambiguous", normalized: NORMALIZED_STATUSES.AMBIGUOUS, isConfirmed: false, confidence: "low" },
    target: { resolvedPath: null, rawSpecifier: "types.h", candidates: ["a/types.h", "b/types.h"] },
  };

  const unresolvedEvidence = {
    id: "ev_unres",
    category: "dependency",
    sourceFile: "src/main.cpp",
    sourceFactId: "inc_1",
    sourceLocation: { start: { line: 2, column: 0 }, end: { line: 2, column: 25 } },
    resolver: { name: "CppIncludeResolver", version: "1.0.0", rule: "not_found" },
    status: { original: "unresolved", normalized: NORMALIZED_STATUSES.UNRESOLVED, isConfirmed: false, confidence: "none" },
    target: { resolvedPath: null, rawSpecifier: "missing.h" },
  };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA],
    normalizedEvidenceList: [ambiguousEvidence, unresolvedEvidence],
  });

  // No confirmed edges created for ambiguous/unresolved items
  assert.equal(snapshot.edges.length, 0);

  // Preserved in unresolvedReferences array
  assert.equal(snapshot.unresolvedReferences.length, 2);
  assert.equal(snapshot.statistics.ambiguousCount, 1);
  assert.equal(snapshot.statistics.unresolvedCount, 1);
  assert.deepEqual(snapshot.unresolvedReferences[0].candidates, ["a/types.h", "b/types.h"]);
});

test("graphBuilder: permutation invariance guarantees 100% byte-for-byte serialization determinism", () => {
  const builder = new GraphBuilder();

  const file1 = createMockFileIR("src/a.ts", "typescript", [{ id: "sym_0", name: "Alpha", kind: "class" }]);
  const file2 = createMockFileIR("src/b.ts", "typescript", [{ id: "sym_0", name: "Beta", kind: "class" }]);
  const file3 = createMockFileIR("src/c.ts", "typescript", [{ id: "sym_0", name: "Gamma", kind: "class" }]);

  const ev1 = {
    id: "ev_1",
    sourceFile: "src/a.ts",
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true },
    target: { resolvedPath: "src/b.ts" },
  };
  const ev2 = {
    id: "ev_2",
    sourceFile: "src/b.ts",
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true },
    target: { resolvedPath: "src/c.ts" },
  };

  // Run 1: Normal order
  const snapshot1 = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [file1, file2, file3],
    normalizedEvidenceList: [ev1, ev2],
  });

  // Run 2: Shuffled order
  const snapshot2 = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [file3, file1, file2],
    normalizedEvidenceList: [ev2, ev1],
  });

  const json1 = JSON.stringify(snapshot1);
  const json2 = JSON.stringify(snapshot2);

  assert.equal(json1, json2, "Shuffled inputs must produce identical serialized JSON output");
});

