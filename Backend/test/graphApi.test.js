const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}

const { AppError } = require("../lib/errors");
const organizations = require("../services/organizations");
const { GraphSnapshotStore, defaultStore } = require("../services/graph/GraphSnapshotStore");
const { buildRepositoryGraph } = require("../services/graph/graphPipeline");
const {
  verifyRepositoryOwnership,
  registerAuthoritativeRepositoryOwnership,
  clearAuthoritativeRepositoryOwnership,
} = require("../services/repositoryAuth");
const {
  buildGraph,
  getGraphSummary,
  getNodes,
  getNodeDetails,
  getOutgoingEdges,
  getIncomingEdges,
  getNeighborhood,
  getEdgeEvidence,
  getUnresolvedReferences,
  getFileSubgraph,
} = require("../controllers/graphController");

const REPO_ID = "owner/my-app";
const COMMIT_SHA_A = "1111111111111111111111111111111111111111";
const COMMIT_SHA_B = "2222222222222222222222222222222222222222";

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

function createAuthedReq(params = {}, body = {}, query = {}, actor = null) {
  return {
    actor: actor || { userId: "user_test", orgId: "org_test" },
    params: { orgId: "org_test", repositoryId: encodeURIComponent(REPO_ID), ...params },
    body,
    query,
  };
}

// ============================================================================
// 1. GraphSnapshotStore: LRU Eviction, Memory Release & Active Revision
// ============================================================================
test("snapshotStore: cache eviction at configured limit releases memory and updates active revision", () => {
  const store = new GraphSnapshotStore({ maxEntries: 2 });

  function makeSnap(sha) {
    return {
      schemaVersion: "1.0.0",
      graphId: `snap_${sha}`,
      repository: { repositoryId: REPO_ID },
      revision: { commitSha: sha },
      builder: { version: "1.0.0", fileIrVersion: "1.0.0" },
      nodes: [{ id: `${REPO_ID}@${sha}:src/index.ts`, type: "file", name: "index.ts" }],
      edges: [],
      unresolvedReferences: [],
      statistics: { totalNodes: 1, totalEdges: 0 },
    };
  }

  // Insert Commit 1
  store.put(makeSnap("commit_1"));
  assert.equal(store.size(), 1);
  assert.ok(store.has({ repositoryId: REPO_ID, commitSha: "commit_1" }));

  // Insert Commit 2
  store.put(makeSnap("commit_2"));
  assert.equal(store.size(), 2);
  assert.ok(store.has({ repositoryId: REPO_ID, commitSha: "commit_2" }));

  // Insert Commit 3 -> Must trigger LRU eviction of commit_1
  store.put(makeSnap("commit_3"));
  assert.equal(store.size(), 2, "Cache size must be strictly bounded by maxEntries");

  // Evicted snapshot cannot be accessed
  assert.equal(
    store.has({ repositoryId: REPO_ID, commitSha: "commit_1" }),
    false,
    "Evicted snapshot commit_1 must no longer be present in cache"
  );
  assert.equal(store.get({ repositoryId: REPO_ID, commitSha: "commit_1" }), null);

  // Commits 2 and 3 remain accessible
  assert.ok(store.has({ repositoryId: REPO_ID, commitSha: "commit_2" }));
  assert.ok(store.has({ repositoryId: REPO_ID, commitSha: "commit_3" }));

  // Active revision points to commit_3
  const activeEntry = store.get({ repositoryId: REPO_ID });
  assert.equal(activeEntry.commitSha, "commit_3");
});

test("snapshotStore: requesting another commit never returns previous commit's graph", () => {
  const store = new GraphSnapshotStore({ maxEntries: 5 });

  const snapA = {
    schemaVersion: "1.0.0",
    graphId: "snap_A",
    repository: { repositoryId: REPO_ID },
    revision: { commitSha: COMMIT_SHA_A },
    builder: { version: "1.0.0" },
    nodes: [{ id: `${REPO_ID}@${COMMIT_SHA_A}:src/a.ts`, type: "file", name: "a.ts" }],
    edges: [],
    unresolvedReferences: [],
    statistics: { totalNodes: 1, totalEdges: 0 },
  };

  const snapB = {
    schemaVersion: "1.0.0",
    graphId: "snap_B",
    repository: { repositoryId: REPO_ID },
    revision: { commitSha: COMMIT_SHA_B },
    builder: { version: "1.0.0" },
    nodes: [{ id: `${REPO_ID}@${COMMIT_SHA_B}:src/b.ts`, type: "file", name: "b.ts" }],
    edges: [],
    unresolvedReferences: [],
    statistics: { totalNodes: 1, totalEdges: 0 },
  };

  store.put(snapA);
  store.put(snapB);

  // 1. Explicitly requesting COMMIT_SHA_A returns snapA
  const getA = store.get({ repositoryId: REPO_ID, commitSha: COMMIT_SHA_A });
  assert.equal(getA.commitSha, COMMIT_SHA_A);
  assert.equal(getA.snapshot.nodes[0].name, "a.ts");

  // 2. Explicitly requesting COMMIT_SHA_B returns snapB
  const getB = store.get({ repositoryId: REPO_ID, commitSha: COMMIT_SHA_B });
  assert.equal(getB.commitSha, COMMIT_SHA_B);
  assert.equal(getB.snapshot.nodes[0].name, "b.ts");

  // 3. Requesting non-existent commit NEVER returns snapA or snapB
  const nonExistent = store.get({ repositoryId: REPO_ID, commitSha: "9999999999999999999999999999999999999999" });
  assert.equal(nonExistent, null, "Must return null instead of falling back to other commits");
});

// ============================================================================
// 2. Authoritative Repository Ownership & Transfer (Independent of Cache)
// ============================================================================
test("repositoryAuth: authoritative ownership check is independent of cache and survives backend cache clearing", async () => {
  clearAuthoritativeRepositoryOwnership();
  defaultStore.clear();

  // 1. Authoritatively bind repository to org_alpha
  registerAuthoritativeRepositoryOwnership("alpha/service", "org_alpha");

  // Cache is completely empty (simulating backend restart or pre-build state)
  assert.equal(defaultStore.size(), 0);

  // Org Alpha passes authoritative ownership check even with empty cache
  const authRes = await verifyRepositoryOwnership("alpha/service", "org_alpha");
  assert.equal(authRes.organizationId, "org_alpha");

  // Org Beta is strictly rejected *before* any graph was ever built or cached
  await assert.rejects(
    async () => verifyRepositoryOwnership("alpha/service", "org_beta"),
    (err) => err instanceof AppError && err.status === 403 && err.code === "TENANT_ACCESS_DENIED"
  );
});

test("repositoryAuth: transferring repository immediately revokes access from old organization", async () => {
  clearAuthoritativeRepositoryOwnership();

  // Repository initially belongs to org_origin
  registerAuthoritativeRepositoryOwnership("corp/core-lib", "org_origin");
  const initial = await verifyRepositoryOwnership("corp/core-lib", "org_origin");
  assert.equal(initial.organizationId, "org_origin");

  // Repository transferred to org_target
  registerAuthoritativeRepositoryOwnership("corp/core-lib", "org_target");

  // Access immediately granted to org_target
  const transferred = await verifyRepositoryOwnership("corp/core-lib", "org_target");
  assert.equal(transferred.organizationId, "org_target");

  // Access immediately denied to old tenant org_origin
  await assert.rejects(
    async () => verifyRepositoryOwnership("corp/core-lib", "org_origin"),
    (err) => err instanceof AppError && err.status === 403 && err.code === "TENANT_ACCESS_DENIED"
  );
});

// ============================================================================
// 3. Multi-Tenant API Authorization & Cache Isolation
// ============================================================================
test("graphApi: user from organization A cannot access a repository belonging to organization B", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async (orgId) => {
    if (orgId === "org_a") return { role: "member" };
    throw new AppError(404, "NOT_FOUND", "Org not found");
  };

  try {
    const { res } = createResSpy();

    clearAuthoritativeRepositoryOwnership();
    registerAuthoritativeRepositoryOwnership("tenant-b/repo", "org_b");

    // User authenticated in "org_a" tries to access "tenant-b/repo"
    const req = {
      actor: { userId: "user_a", orgId: "org_a" },
      params: { orgId: "org_a", repositoryId: encodeURIComponent("tenant-b/repo") },
      query: {},
    };

    await assert.rejects(
      async () => getGraphSummary(req, res),
      (err) => err instanceof AppError && err.status === 403 && err.code === "TENANT_ACCESS_DENIED"
    );
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: user without repository access cannot access graph and unauthorized request does not trigger cache lookup", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => {
    throw new AppError(403, "FORBIDDEN", "User is not a member of this organization");
  };

  let cacheLookupTriggered = false;
  const originalGet = defaultStore.get;
  defaultStore.get = (...args) => {
    cacheLookupTriggered = true;
    return originalGet.apply(defaultStore, args);
  };

  try {
    const { res } = createResSpy();
    const req = {
      actor: { userId: "unauthorized_user", orgId: null },
      params: { orgId: "org_test", repositoryId: encodeURIComponent(REPO_ID) },
      query: {},
    };

    await assert.rejects(
      async () => getGraphSummary(req, res),
      (err) => err instanceof AppError && (err.status === 403 || err.status === 404)
    );

    // Cache lookup must NEVER be triggered on unauthorized request
    assert.equal(cacheLookupTriggered, false, "Unauthorized request must not trigger cache lookup");
  } finally {
    organizations.requireMembership = originalMembership;
    defaultStore.get = originalGet;
  }
});

// ============================================================================
// 4. FileIR Trust Boundary & Mixed Commit Rejection
// ============================================================================
test("graphApi: client-supplied untrusted FileIR cannot bypass server parsing pipeline", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { res } = createResSpy();

    const bypassReq = createAuthedReq({}, {
      commitSha: COMMIT_SHA_A,
      fileIRList: [
        {
          file: { path: "forged/malicious.ts" },
          symbols: [{ id: "sym_evil", name: "bypass", kind: "function" }],
        },
      ],
    });

    await assert.rejects(
      async () => buildGraph(bypassReq, res),
      (err) => err instanceof AppError && err.status === 400 && err.code === "UNTRUSTED_FILE_IR"
    );
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphPipeline: FileIR documents from mixed commits are rejected", async () => {
  const file1 = {
    file: { path: "src/a.ts", language: "typescript" },
    commitSha: COMMIT_SHA_A,
    repository: REPO_ID,
  };

  const file2 = {
    file: { path: "src/b.ts", language: "typescript" },
    commitSha: COMMIT_SHA_B, // Conflicting commit!
    repository: REPO_ID,
  };

  await assert.rejects(
    async () =>
      buildRepositoryGraph({
        repositoryId: REPO_ID,
        commitSha: COMMIT_SHA_A,
        fileIRList: [file1, file2],
      }),
    (err) => err instanceof AppError && err.status === 400 && err.code === "MIXED_COMMIT_FILE_IR"
  );
});

// ============================================================================
// 5. Server-Side Parsing Pipeline Integration & Graph Build
// ============================================================================
test("graphApi: buildGraph obtains FileIR strictly from server parsing pipeline and builds graph", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    defaultStore.clear();
    clearAuthoritativeRepositoryOwnership();
    const { state, res } = createResSpy();

    const rawFiles = [
      {
        path: "src/server.ts",
        language: "typescript",
        content: 'import { PORT } from "./config"; export function startServer() { return PORT; }',
        blobSha: "sha_server",
      },
      {
        path: "src/config.ts",
        language: "typescript",
        content: "export const PORT = 8080;",
        blobSha: "sha_config",
      },
    ];

    const req = createAuthedReq({}, {
      commitSha: COMMIT_SHA_A,
      files: rawFiles,
    });

    await buildGraph(req, res);

    assert.equal(state.statusCalled, 201);
    assert.equal(state.jsonCalled.success, true);
    assert.ok(state.jsonCalled.data.graphId);
    assert.ok(state.jsonCalled.data.cacheKey);
    assert.equal(state.jsonCalled.data.statistics.fileNodes, 2);
    assert.equal(state.jsonCalled.data.statistics.symbolNodes, 2);
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

// ============================================================================
// 6. Granular Endpoint Verification (Separate Test Blocks)
// ============================================================================
test("graphApi: getGraphSummary returns snapshot metadata and statistics", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state, res } = createResSpy();
    await getGraphSummary(createAuthedReq(), res);

    assert.equal(state.statusCalled, 200);
    assert.equal(state.jsonCalled.data.schemaVersion, "1.0.0");
    assert.equal(state.jsonCalled.data.repository.repositoryId, REPO_ID);
    assert.equal(state.jsonCalled.data.revision.commitSha, COMMIT_SHA_A);
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: getNodes returns paginated nodes with type and language filtering", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state, res } = createResSpy();
    await getNodes(createAuthedReq({}, {}, { type: "file", page: 1, pageSize: 10 }), res);

    assert.equal(state.statusCalled, 200);
    assert.equal(state.jsonCalled.data.total, 2);
    assert.equal(state.jsonCalled.data.nodes.length, 2);
    assert.equal(state.jsonCalled.data.nodes[0].type, "file");
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: getNodeDetails returns node by ID or 404 for missing node", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state, res } = createResSpy();
    const nodeId = `${REPO_ID}@${COMMIT_SHA_A}:src/server.ts`;

    await getNodeDetails(createAuthedReq({ nodeId: encodeURIComponent(nodeId) }), res);
    assert.equal(state.statusCalled, 200);
    assert.equal(state.jsonCalled.data.id, nodeId);

    // Missing node returns 404
    await assert.rejects(
      async () => getNodeDetails(createAuthedReq({ nodeId: encodeURIComponent("missing_node") }), res),
      (err) => err instanceof AppError && err.status === 404 && err.code === "NODE_NOT_FOUND"
    );
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: getOutgoingEdges and getIncomingEdges return directed edges", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state: outState, res: outRes } = createResSpy();
    const sourceNodeId = `${REPO_ID}@${COMMIT_SHA_A}:src/server.ts`;

    await getOutgoingEdges(createAuthedReq({ nodeId: encodeURIComponent(sourceNodeId) }), outRes);
    assert.equal(outState.statusCalled, 200);
    assert.ok(outState.jsonCalled.data.edges.length >= 1);

    const { state: inState, res: inRes } = createResSpy();
    const targetNodeId = `${REPO_ID}@${COMMIT_SHA_A}:src/config.ts`;

    await getIncomingEdges(createAuthedReq({ nodeId: encodeURIComponent(targetNodeId) }), inRes);
    assert.equal(inState.statusCalled, 200);
    assert.ok(inState.jsonCalled.data.edges.length >= 1);
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: getNeighborhood returns bounded graph around center node with maxDepth and maxNodes", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state, res } = createResSpy();
    const centerNodeId = `${REPO_ID}@${COMMIT_SHA_A}:src/server.ts`;

    await getNeighborhood(createAuthedReq({}, {}, { centerNodeId, maxDepth: 2, maxNodes: 10 }), res);
    assert.equal(state.statusCalled, 200);
    assert.equal(state.jsonCalled.data.rootNodeId, centerNodeId);
    assert.ok(state.jsonCalled.data.nodes.length >= 1);
    assert.ok(state.jsonCalled.data.edges.length >= 1);
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: getEdgeEvidence returns provenance for valid edge or 404", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state, res } = createResSpy();
    const sourceId = `${REPO_ID}@${COMMIT_SHA_A}:src/server.ts`;
    const targetId = `${REPO_ID}@${COMMIT_SHA_A}:src/config.ts`;
    const edgeId = `${sourceId} -[imports]-> ${targetId}`;

    await getEdgeEvidence(createAuthedReq({ edgeId: encodeURIComponent(edgeId) }), res);
    assert.equal(state.statusCalled, 200);
    assert.ok(state.jsonCalled.data.evidence.length >= 1);

    // Missing edge returns 404
    await assert.rejects(
      async () => getEdgeEvidence(createAuthedReq({ edgeId: encodeURIComponent("missing_edge") }), res),
      (err) => err instanceof AppError && err.status === 404 && err.code === "EDGE_NOT_FOUND"
    );
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: getFileSubgraph returns bounded file graph or 404", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state, res } = createResSpy();
    await getFileSubgraph(createAuthedReq({}, {}, { filePath: "src/server.ts" }), res);

    assert.equal(state.statusCalled, 200);
    assert.ok(state.jsonCalled.data.nodes.some((n) => n.path === "src/server.ts"));
    assert.ok(state.jsonCalled.data.nodes.some((n) => n.name === "startServer"));

    // Missing file returns 404
    await assert.rejects(
      async () => getFileSubgraph(createAuthedReq({}, {}, { filePath: "src/nonexistent.ts" }), res),
      (err) => err instanceof AppError && err.status === 404 && err.code === "FILE_NOT_FOUND"
    );
  } finally {
    organizations.requireMembership = originalMembership;
  }
});

test("graphApi: getUnresolvedReferences returns correctly filtered and paginated results", async () => {
  const originalMembership = organizations.requireMembership;
  organizations.requireMembership = async () => ({ role: "member" });

  try {
    const { state, res } = createResSpy();

    const rawFiles = [
      {
        path: "src/unres.ts",
        language: "typescript",
        content: 'import { Missing } from "./missing";',
        blobSha: "sha_unres",
      },
    ];

    const buildReq = createAuthedReq({}, {
      commitSha: COMMIT_SHA_A,
      files: rawFiles,
    });
    await buildGraph(buildReq, createResSpy().res);

    // Filter by status: "unresolved"
    await getUnresolvedReferences(createAuthedReq({}, {}, { status: "unresolved", page: 1, pageSize: 5 }), res);

    assert.equal(state.statusCalled, 200);
    assert.ok(state.jsonCalled.data.total >= 1);
    assert.equal(state.jsonCalled.data.items[0].status, "unresolved");
  } finally {
    organizations.requireMembership = originalMembership;
  }
});
