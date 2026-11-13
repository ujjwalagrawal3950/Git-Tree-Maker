const test = require("node:test");
const assert = require("node:assert/strict");

const { GraphValidator } = require("../services/graph/GraphValidator");
const { GraphBuilder } = require("../services/graph/GraphBuilder");
const { createFileNodeId, createEdgeId, EDGE_SEMANTICS } = require("../services/graph/identity");
const { NORMALIZED_STATUSES } = require("../services/graph/evidenceNormalizer");

const REPO = "facebook/react";
const COMMIT_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

test("graphValidator: validates valid snapshot produced by GraphBuilder", () => {
  const builder = new GraphBuilder();
  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/index.ts", blobSha: "abc", language: "typescript" },
    symbols: [{ id: "sym_0", name: "Main", kind: "class" }],
  };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA],
  });

  const res = GraphValidator.validate(snapshot);
  assert.equal(res.isValid, true);
  assert.equal(res.errors.length, 0);
});

test("graphValidator: rejects dangling edges referencing non-existent nodes", () => {
  const builder = new GraphBuilder();
  const fileA = {
    schemaVersion: "1.0.0",
    file: { path: "src/index.ts", blobSha: "abc", language: "typescript" },
  };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA],
  });

  // Inject a dangling edge
  const sourceId = createFileNodeId(REPO, COMMIT_SHA, "src/index.ts");
  const missingTargetId = createFileNodeId(REPO, COMMIT_SHA, "src/nonexistent.ts");
  snapshot.edges.push({
    id: createEdgeId(sourceId, EDGE_SEMANTICS.IMPORTS, missingTargetId),
    source: sourceId,
    target: missingTargetId,
    type: EDGE_SEMANTICS.IMPORTS,
    evidence: [{ id: "ev_fake", status: { isConfirmed: true } }],
  });

  const res = GraphValidator.validate(snapshot);
  assert.equal(res.isValid, false);
  assert.ok(res.errors.some((err) => err.includes("Dangling edge: Target node")));
});

test("graphValidator: rejects edges missing required provenance evidence", () => {
  const builder = new GraphBuilder();
  const fileA = { schemaVersion: "1.0.0", file: { path: "src/a.ts", blobSha: "1", language: "typescript" } };
  const fileB = { schemaVersion: "1.0.0", file: { path: "src/b.ts", blobSha: "2", language: "typescript" } };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
  });

  const sourceId = createFileNodeId(REPO, COMMIT_SHA, "src/a.ts");
  const targetId = createFileNodeId(REPO, COMMIT_SHA, "src/b.ts");

  // Inject edge with empty evidence
  snapshot.edges.push({
    id: createEdgeId(sourceId, EDGE_SEMANTICS.IMPORTS, targetId),
    source: sourceId,
    target: targetId,
    type: EDGE_SEMANTICS.IMPORTS,
    evidence: [], // Empty evidence!
  });

  const res = GraphValidator.validate(snapshot);
  assert.equal(res.isValid, false);
  assert.ok(res.errors.some((err) => err.includes("missing required provenance evidence")));
});

test("graphValidator: rejects internal edge lacking confirmed evidence", () => {
  const builder = new GraphBuilder();
  const fileA = { schemaVersion: "1.0.0", file: { path: "src/a.ts", blobSha: "1", language: "typescript" } };
  const fileB = { schemaVersion: "1.0.0", file: { path: "src/b.ts", blobSha: "2", language: "typescript" } };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA, fileB],
  });

  const sourceId = createFileNodeId(REPO, COMMIT_SHA, "src/a.ts");
  const targetId = createFileNodeId(REPO, COMMIT_SHA, "src/b.ts");

  // Inject internal edge with unconfirmed evidence
  snapshot.edges.push({
    id: createEdgeId(sourceId, EDGE_SEMANTICS.IMPORTS, targetId),
    source: sourceId,
    target: targetId,
    type: EDGE_SEMANTICS.IMPORTS,
    evidence: [
      {
        id: "ev_unconf",
        status: { isConfirmed: false, normalized: NORMALIZED_STATUSES.UNRESOLVED },
      },
    ],
  });

  const res = GraphValidator.validate(snapshot);
  assert.equal(res.isValid, false);
  assert.ok(res.errors.some((err) => err.includes("lacks any confirmed evidence")));
});

test("graphValidator: detects cross-revision node leakage", () => {
  const builder = new GraphBuilder();
  const fileA = { schemaVersion: "1.0.0", file: { path: "src/a.ts", blobSha: "1", language: "typescript" } };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA],
  });

  // Inject a node from a different commit SHA
  const foreignSha = "9999999999999999999999999999999999999999";
  snapshot.nodes.push({
    id: createFileNodeId(REPO, foreignSha, "src/alien.ts"),
    type: "file",
    name: "alien.ts",
  });

  const res = GraphValidator.validate(snapshot);
  assert.equal(res.isValid, false);
  assert.ok(res.errors.some((err) => err.includes("Cross-revision node detected")));
});

test("graphValidator: detects duplicate node and edge IDs", () => {
  const builder = new GraphBuilder();
  const fileA = { schemaVersion: "1.0.0", file: { path: "src/a.ts", blobSha: "1", language: "typescript" } };

  const snapshot = builder.build({
    repositoryId: REPO,
    commitSha: COMMIT_SHA,
    fileIRList: [fileA],
  });

  // Duplicate the existing node
  snapshot.nodes.push({ ...snapshot.nodes[0] });

  const res = GraphValidator.validate(snapshot);
  assert.equal(res.isValid, false);
  assert.ok(res.errors.some((err) => err.includes("Duplicate node id detected")));
});

