const test = require("node:test");
const assert = require("node:assert/strict");

const { GraphBuilder } = require("../services/graph/GraphBuilder");
const { GraphQueryService } = require("../services/graph/GraphQueryService");
const { createFileNodeId, createSymbolNodeId, createEdgeId, EDGE_SEMANTICS } = require("../services/graph/identity");
const { NORMALIZED_STATUSES } = require("../services/graph/evidenceNormalizer");

const REPO = "facebook/react";
const COMMIT_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function buildTestSnapshot() {
  const builder = new GraphBuilder();

  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/A.ts", language: "typescript" },
    symbols: [
      { id: "sym_A", name: "ClassA", kind: "class" },
      { id: "sym_A_run", name: "run", kind: "method", parentSymbolId: "sym_A" },
    ],
  };

  const fileB = {
    schemaVersion: "1.0.0",
    file: { path: "src/B.ts", language: "typescript" },
    symbols: [{ id: "sym_B", name: "ClassB", kind: "class" }],
  };

  const fileC = {
    schemaVersion: "1.0.0",
    file: { path: "src/C.ts", language: "typescript" },
    symbols: [{ id: "sym_C", name: "ClassC", kind: "class" }],
  };

  // Edges: A imports B, B imports C, C imports A (Cyclic graph!)
  const evAtoB = {
    id: "ev_ab",
    sourceFile: "src/A.ts",
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true },
    target: { resolvedPath: "src/B.ts" },
  };
  const evBtoC = {
    id: "ev_bc",
    sourceFile: "src/B.ts",
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true },
    target: { resolvedPath: "src/C.ts" },
  };
  const evCtoA = {
    id: "ev_ca",
    sourceFile: "src/C.ts",
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true },
    target: { resolvedPath: "src/A.ts" },
  };

  const unres = {
    id: "ev_unres",
    sourceFile: "src/A.ts",
    status: { original: "unresolved", normalized: NORMALIZED_STATUSES.UNRESOLVED, isConfirmed: false },
    target: { rawSpecifier: "nonexistent" },
  };

  return builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB, fileC],
    normalizedEvidenceList: [evAtoB, evBtoC, evCtoA, unres],
  });
}

test("graphQueryService: retrieves snapshot metadata and statistics", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const meta = queryService.getSnapshotMetadata();
  assert.equal(meta.schemaVersion, "1.0.0");
  assert.equal(meta.repository.repositoryId, REPO);
  assert.equal(meta.revision.commitSha, COMMIT_SHA);
  assert.equal(meta.statistics.fileNodes, 3);
  assert.equal(meta.statistics.symbolNodes, 4);
});

test("graphQueryService: getNode performs O(1) lookup", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const fileANodeId = createFileNodeId(REPO, COMMIT_SHA, "src/A.ts");
  const node = queryService.getNode(fileANodeId);

  assert.ok(node);
  assert.equal(node.id, fileANodeId);
  assert.equal(node.type, "file");
  assert.equal(node.path, "src/A.ts");

  assert.equal(queryService.getNode("nonexistent"), null);
});

test("graphQueryService: getNodes supports pagination and filtering", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  // Filter by type: file
  const fileNodes = queryService.getNodes({ type: "file", pageSize: 2, page: 1 });
  assert.equal(fileNodes.total, 3);
  assert.equal(fileNodes.nodes.length, 2);
  assert.equal(fileNodes.page, 1);
  assert.equal(fileNodes.totalPages, 2);

  // Filter by language
  const tsNodes = queryService.getNodes({ language: "typescript" });
  assert.equal(tsNodes.total, 7); // 3 files + 4 symbols

  // Filter by query substring
  const searchClass = queryService.getNodes({ query: "Class" });
  assert.equal(searchClass.total, 3); // ClassA, ClassB, ClassC
});

test("graphQueryService: getOutgoingEdges and getIncomingEdges retrieve directed edges", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const fileANodeId = createFileNodeId(REPO, COMMIT_SHA, "src/A.ts");
  const fileBNodeId = createFileNodeId(REPO, COMMIT_SHA, "src/B.ts");

  // Outgoing from A: A -> B (imports) + A -> ClassA (contains)
  const outgoingA = queryService.getOutgoingEdges(fileANodeId);
  assert.ok(outgoingA.length >= 2);

  const importOnlyA = queryService.getOutgoingEdges(fileANodeId, { edgeType: EDGE_SEMANTICS.IMPORTS });
  assert.equal(importOnlyA.length, 1);
  assert.equal(importOnlyA[0].target, fileBNodeId);

  // Incoming to B: A -> B
  const incomingB = queryService.getIncomingEdges(fileBNodeId, { edgeType: EDGE_SEMANTICS.IMPORTS });
  assert.equal(incomingB.length, 1);
  assert.equal(incomingB[0].source, fileANodeId);
});

test("graphQueryService: getNeighborhood handles cyclic graph without infinite loop", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const fileANodeId = createFileNodeId(REPO, COMMIT_SHA, "src/A.ts");

  // A -> B -> C -> A is cyclic!
  const neighborhood = queryService.getNeighborhood(fileANodeId, {
    maxDepth: 3,
    maxNodes: 20,
    edgeTypes: [EDGE_SEMANTICS.IMPORTS],
  });

  assert.equal(neighborhood.rootNodeId, fileANodeId);
  // Visited all 3 files without getting stuck in a cycle
  assert.equal(neighborhood.nodes.length, 3);
  assert.equal(neighborhood.edges.length, 3);
  assert.equal(neighborhood.truncated, false);
});

test("graphQueryService: getNeighborhood bounds maxNodes and reports truncation", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const fileANodeId = createFileNodeId(REPO, COMMIT_SHA, "src/A.ts");

  const capped = queryService.getNeighborhood(fileANodeId, {
    maxDepth: 3,
    maxNodes: 2, // Hard cap of 2 nodes
  });

  assert.equal(capped.nodes.length, 2);
  assert.equal(capped.truncated, true);
});

test("graphQueryService: getEdgeEvidence retrieves provenance records", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const fileANodeId = createFileNodeId(REPO, COMMIT_SHA, "src/A.ts");
  const fileBNodeId = createFileNodeId(REPO, COMMIT_SHA, "src/B.ts");
  const edgeId = createEdgeId(fileANodeId, EDGE_SEMANTICS.IMPORTS, fileBNodeId);

  const evidence = queryService.getEdgeEvidence(edgeId);
  assert.ok(Array.isArray(evidence));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].id, "ev_ab");
});

test("graphQueryService: getUnresolvedReferences supports pagination and status filtering", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const unres = queryService.getUnresolvedReferences({ status: NORMALIZED_STATUSES.UNRESOLVED });
  assert.equal(unres.total, 1);
  assert.equal(unres.items[0].id, "ev_unres");
});

test("graphQueryService: getFileSubgraph extracts file, symbols, and direct connections", () => {
  const snapshot = buildTestSnapshot();
  const queryService = new GraphQueryService(snapshot);

  const subgraph = queryService.getFileSubgraph("src/A.ts");
  assert.ok(subgraph);

  // Contains src/A.ts, ClassA, run, and connected files (src/B.ts, src/C.ts)
  assert.ok(subgraph.nodes.some((n) => n.path === "src/A.ts"));
  assert.ok(subgraph.nodes.some((n) => n.name === "ClassA"));
  assert.ok(subgraph.nodes.some((n) => n.name === "run"));
  assert.ok(subgraph.edges.length > 0);
});

