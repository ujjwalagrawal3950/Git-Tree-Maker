const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EDGE_SEMANTICS,
  createFileNodeId,
  createEdgeId,
} = require("../services/graph/identity");
const {
  NORMALIZED_STATUSES,
  normalizeHttpResolution,
} = require("../services/graph/evidenceNormalizer");
const { GraphBuilder } = require("../services/graph/GraphBuilder");
const { GraphValidator } = require("../services/graph/GraphValidator");
const { GraphQueryService } = require("../services/graph/GraphQueryService");
const { buildRepositoryGraph } = require("../services/graph/graphPipeline");
const { HttpRouteResolver } = require("../services/parser/resolvers/HttpRouteResolver");

const REPO_ID = "test-org/cartograph-repo";
const COMMIT_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// Helper to create synthetic FileIR document
function createSyntheticFileIR({
  repositoryId = REPO_ID,
  commitSha = COMMIT_SHA,
  filePath,
  language = "javascript",
  imports = [],
  exports = [],
  calls = [],
  symbols = [],
  httpRequests = [],
  expressRoutes = [],
  expressMounts = [],
}) {
  const ir = {
    schemaVersion: "1.0.0",
    repository: repositoryId,
    commitSha,
    file: {
      path: filePath,
      language,
    },
    imports,
    exports,
    calls,
    symbols,
  };

  Object.defineProperty(ir, "httpRequests", {
    value: httpRequests,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(ir, "expressRoutes", {
    value: expressRoutes,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(ir, "expressMounts", {
    value: expressMounts,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return ir;
}

test("Stage 4 - 1. Confirmed exact HTTP edge creation (type === 'http_request')", () => {
  const clientFile = "src/api/authClient.js";
  const backendFile = "src/routes/authRoutes.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  const resolution = {
    id: "fetch_1_0_resolution",
    clientFileId: clientFile,
    clientFactId: "fetch_1_0",
    backendFileId: backendFile,
    backendRouteFactId: "express_route_1_0",
    httpMethod: "POST",
    rawClientEndpoint: "/api/login",
    normalizedClientPattern: "/api/login",
    originalRoutePath: "/login",
    composedRoutePath: "/api/login",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    clientLocation: { start: { line: 10, column: 4 }, end: { line: 10, column: 35 } },
    backendLocation: { start: { line: 15, column: 0 }, end: { line: 18, column: 2 } },
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
    candidates: [{ routeFactId: "express_route_1_0", backendFileId: backendFile }],
  };

  const normEv = normalizeHttpResolution(resolution);
  assert.equal(normEv.category, "http_request");
  assert.equal(normEv.status.isConfirmed, true);
  assert.equal(normEv.status.confidence, "high");

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  const httpEdges = snapshot.edges.filter((e) => e.type === EDGE_SEMANTICS.HTTP_REQUEST);
  assert.equal(httpEdges.length, 1);

  const edge = httpEdges[0];
  const expectedSource = createFileNodeId(REPO_ID, COMMIT_SHA, clientFile);
  const expectedTarget = createFileNodeId(REPO_ID, COMMIT_SHA, backendFile);

  assert.equal(edge.source, expectedSource);
  assert.equal(edge.target, expectedTarget);
  assert.equal(edge.type, "http_request");
  assert.equal(edge.semanticQualifier, "POST:/api/login");
  assert.equal(edge.metadata.classification, "confirmed_exact");
  assert.equal(edge.metadata.isPatternCompatible, false);
  assert.equal(edge.metadata.httpMethod, "POST");
  assert.equal(edge.metadata.composedRoutePath, "/api/login");
  assert.equal(edge.evidence.length, 1);
  assert.equal(edge.evidence[0].id, "ev_fetch_1_0_resolution");

  // Validate integrity
  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
  assert.deepEqual(validation.errors, []);
});

test("Stage 4 - 2. Pattern-compatible classification preservation", () => {
  const clientFile = "src/api/userClient.js";
  const backendFile = "src/routes/userRoutes.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  const resolution = {
    id: "fetch_param_resolution",
    clientFileId: clientFile,
    clientFactId: "fetch_2_0",
    backendFileId: backendFile,
    backendRouteFactId: "express_route_2_0",
    httpMethod: "GET",
    rawClientEndpoint: "/api/users/123",
    normalizedClientPattern: "/api/users/:userId",
    originalRoutePath: "/:id",
    composedRoutePath: "/api/users/:id",
    classification: "pattern_compatible",
    mountChain: [{ prefix: "/api/users", routerFileId: backendFile }],
    clientLocation: { start: { line: 22, column: 2 }, end: { line: 22, column: 40 } },
    backendLocation: { start: { line: 30, column: 0 }, end: { line: 35, column: 2 } },
    resolverVersion: "1.0.0",
    resolutionRule: "pattern_template_parameter_match",
    candidates: [{ routeFactId: "express_route_2_0", backendFileId: backendFile }],
  };

  const normEv = normalizeHttpResolution(resolution);
  assert.equal(normEv.status.classification, "pattern_compatible");
  assert.equal(normEv.status.isConfirmed, true);
  assert.equal(normEv.status.confidence, "medium");

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  const httpEdges = snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);

  const edge = httpEdges[0];
  assert.equal(edge.semanticQualifier, "GET:/api/users/:id:pattern");
  assert.equal(edge.metadata.classification, "pattern_compatible");
  assert.equal(edge.metadata.isPatternCompatible, true);
  assert.equal(edge.metadata.httpMethod, "GET");
  assert.equal(edge.metadata.composedRoutePath, "/api/users/:id");
  assert.equal(edge.evidence[0].status.classification, "pattern_compatible");

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 3. Ambiguous match exclusion from confirmed edges", () => {
  const clientFile = "src/api/dataClient.js";
  const backendFileA = "src/routes/dataRoutesA.js";
  const backendFileB = "src/routes/dataRoutesB.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFileA }),
    createSyntheticFileIR({ filePath: backendFileB }),
  ];

  const resolution = {
    id: "fetch_ambig_resolution",
    clientFileId: clientFile,
    clientFactId: "fetch_ambig",
    backendFileId: null,
    backendRouteFactId: null,
    httpMethod: "GET",
    rawClientEndpoint: "/api/data",
    normalizedClientPattern: "/api/data",
    originalRoutePath: null,
    composedRoutePath: null,
    classification: "ambiguous",
    mountChain: [],
    clientLocation: { start: { line: 5, column: 2 }, end: { line: 5, column: 25 } },
    backendLocation: null,
    resolverVersion: "1.0.0",
    resolutionRule: "ambiguous_multiple_exact_candidates",
    candidates: [
      { routeFactId: "route_a", backendFileId: backendFileA },
      { routeFactId: "route_b", backendFileId: backendFileB },
    ],
  };

  const normEv = normalizeHttpResolution(resolution);
  assert.equal(normEv.status.isConfirmed, false);
  assert.equal(normEv.status.normalized, NORMALIZED_STATUSES.AMBIGUOUS);

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  // Must not create any HTTP edge
  assert.equal(snapshot.edges.length, 0);

  // Must be in unresolvedReferences
  assert.equal(snapshot.unresolvedReferences.length, 1);
  const unres = snapshot.unresolvedReferences[0];
  assert.equal(unres.category, "http_request");
  assert.equal(unres.status, "ambiguous");
  assert.equal(unres.candidates.length, 2);

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 4. Unresolved match exclusion (routed to unresolvedReferences)", () => {
  const clientFile = "src/api/orphanClient.js";
  const fileIRList = [createSyntheticFileIR({ filePath: clientFile })];

  const resolution = {
    id: "fetch_unresolved_resolution",
    clientFileId: clientFile,
    clientFactId: "fetch_orphan",
    backendFileId: null,
    backendRouteFactId: null,
    httpMethod: "POST",
    rawClientEndpoint: "/api/does-not-exist",
    normalizedClientPattern: "/api/does-not-exist",
    originalRoutePath: null,
    composedRoutePath: null,
    classification: "unresolved",
    mountChain: [],
    clientLocation: { start: { line: 8, column: 0 }, end: { line: 8, column: 30 } },
    backendLocation: null,
    resolverVersion: "1.0.0",
    resolutionRule: "no_matching_route",
    candidates: [],
  };

  const normEv = normalizeHttpResolution(resolution);
  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  assert.equal(snapshot.edges.length, 0);
  assert.equal(snapshot.unresolvedReferences.length, 1);
  assert.equal(snapshot.unresolvedReferences[0].category, "http_request");
  assert.equal(snapshot.unresolvedReferences[0].status, "unresolved");

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 5. Unsupported match exclusion (routed to unresolvedReferences)", () => {
  const clientFile = "src/api/dynamicClient.js";
  const fileIRList = [createSyntheticFileIR({ filePath: clientFile })];

  const resolution = {
    id: "fetch_dyn_expr_resolution",
    clientFileId: clientFile,
    clientFactId: "fetch_dyn",
    backendFileId: null,
    backendRouteFactId: null,
    httpMethod: "GET",
    rawClientEndpoint: "window.location.href",
    normalizedClientPattern: null,
    originalRoutePath: null,
    composedRoutePath: null,
    classification: "unsupported",
    mountChain: [],
    clientLocation: { start: { line: 12, column: 0 }, end: { line: 12, column: 35 } },
    backendLocation: null,
    resolverVersion: "1.0.0",
    resolutionRule: "unsupported_dynamic_expression",
    candidates: [],
  };

  const normEv = normalizeHttpResolution(resolution);
  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  assert.equal(snapshot.edges.length, 0);
  assert.equal(snapshot.unresolvedReferences.length, 1);
  assert.equal(snapshot.unresolvedReferences[0].category, "http_request");
  assert.equal(snapshot.unresolvedReferences[0].status, "unsupported");

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 6. External endpoint exclusion (never creates internal edge)", () => {
  const clientFile = "src/api/paymentClient.js";
  const fileIRList = [createSyntheticFileIR({ filePath: clientFile })];

  const resolution = {
    id: "fetch_stripe_resolution",
    clientFileId: clientFile,
    clientFactId: "fetch_stripe",
    backendFileId: null,
    backendRouteFactId: null,
    httpMethod: "POST",
    rawClientEndpoint: "https://api.stripe.com/v1/charges",
    normalizedClientPattern: "https://api.stripe.com/v1/charges",
    originalRoutePath: null,
    composedRoutePath: null,
    classification: "external",
    mountChain: [],
    clientLocation: { start: { line: 15, column: 2 }, end: { line: 15, column: 55 } },
    backendLocation: null,
    resolverVersion: "1.0.0",
    resolutionRule: "external_url_exclusion",
    candidates: [],
  };

  const normEv = normalizeHttpResolution(resolution);
  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  // Must not create any internal edge, nor any imports edge
  assert.equal(snapshot.edges.length, 0);

  // Must be in unresolvedReferences with external status
  assert.equal(snapshot.unresolvedReferences.length, 1);
  assert.equal(snapshot.unresolvedReferences[0].category, "http_request");
  assert.equal(snapshot.unresolvedReferences[0].status, "external");

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 7. Deterministic HTTP edge IDs and byte-for-byte serialization determinism", () => {
  const clientFile = "src/api/auth.js";
  const backendFile = "src/routes/auth.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  const resolution = {
    id: "res_deterministic",
    clientFileId: clientFile,
    clientFactId: "fact_1",
    backendFileId: backendFile,
    backendRouteFactId: "route_1",
    httpMethod: "GET",
    rawClientEndpoint: "/api/check",
    normalizedClientPattern: "/api/check",
    originalRoutePath: "/check",
    composedRoutePath: "/api/check",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    clientLocation: { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } },
    backendLocation: { start: { line: 5, column: 0 }, end: { line: 5, column: 25 } },
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
    candidates: [],
  };

  const normEv = normalizeHttpResolution(resolution);

  const builder1 = new GraphBuilder();
  const snapshot1 = builder1.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  const builder2 = new GraphBuilder();
  const snapshot2 = builder2.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [...fileIRList].reverse(), // reversed order
    normalizedEvidenceList: [normEv],
  });

  assert.equal(snapshot1.edges[0].id, snapshot2.edges[0].id);
  assert.equal(JSON.stringify(snapshot1), JSON.stringify(snapshot2));
});

test("Stage 4 - 8. Duplicate resolver execution and edge deduplication", () => {
  const clientFile = "src/api/sessionClient.js";
  const backendFile = "src/routes/sessionRoutes.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  // Two distinct calls to the same endpoint from the same client file
  const res1 = {
    id: "call_line_10_res",
    clientFileId: clientFile,
    clientFactId: "call_10",
    backendFileId: backendFile,
    backendRouteFactId: "session_route",
    httpMethod: "POST",
    rawClientEndpoint: "/api/session",
    normalizedClientPattern: "/api/session",
    originalRoutePath: "/session",
    composedRoutePath: "/api/session",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    clientLocation: { start: { line: 10, column: 2 }, end: { line: 10, column: 30 } },
    backendLocation: { start: { line: 20, column: 0 }, end: { line: 25, column: 2 } },
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
    candidates: [],
  };

  const res2 = {
    id: "call_line_45_res",
    clientFileId: clientFile,
    clientFactId: "call_45",
    backendFileId: backendFile,
    backendRouteFactId: "session_route",
    httpMethod: "POST",
    rawClientEndpoint: "/api/session",
    normalizedClientPattern: "/api/session",
    originalRoutePath: "/session",
    composedRoutePath: "/api/session",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    clientLocation: { start: { line: 45, column: 2 }, end: { line: 45, column: 30 } },
    backendLocation: { start: { line: 20, column: 0 }, end: { line: 25, column: 2 } },
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
    candidates: [],
  };

  const ev1 = normalizeHttpResolution(res1);
  const ev2 = normalizeHttpResolution(res2);

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [ev1, ev2],
  });

  // Exactly 1 deduplicated edge
  assert.equal(snapshot.edges.length, 1);
  const edge = snapshot.edges[0];
  assert.equal(edge.type, "http_request");
  assert.equal(edge.semanticQualifier, "POST:/api/session");
  // Multiple supporting evidence items aggregated
  assert.equal(edge.evidence.length, 2);
  assert.equal(edge.evidence[0].id, "ev_call_line_10_res");
  assert.equal(edge.evidence[1].id, "ev_call_line_45_res");

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 9. Different HTTP methods produce distinguishable edges", () => {
  const clientFile = "src/api/usersClient.js";
  const backendFile = "src/routes/usersRoutes.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  const getRes = normalizeHttpResolution({
    id: "get_users_res",
    clientFileId: clientFile,
    clientFactId: "get_users",
    backendFileId: backendFile,
    backendRouteFactId: "route_get",
    httpMethod: "GET",
    rawClientEndpoint: "/api/users",
    normalizedClientPattern: "/api/users",
    originalRoutePath: "/users",
    composedRoutePath: "/api/users",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    clientLocation: { start: { line: 5, column: 0 }, end: { line: 5, column: 20 } },
    backendLocation: { start: { line: 10, column: 0 }, end: { line: 12, column: 2 } },
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
  });

  const postRes = normalizeHttpResolution({
    id: "post_users_res",
    clientFileId: clientFile,
    clientFactId: "post_users",
    backendFileId: backendFile,
    backendRouteFactId: "route_post",
    httpMethod: "POST",
    rawClientEndpoint: "/api/users",
    normalizedClientPattern: "/api/users",
    originalRoutePath: "/users",
    composedRoutePath: "/api/users",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    clientLocation: { start: { line: 15, column: 0 }, end: { line: 15, column: 20 } },
    backendLocation: { start: { line: 20, column: 0 }, end: { line: 22, column: 2 } },
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
  });

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [getRes, postRes],
  });

  // 2 distinct edges
  assert.equal(snapshot.edges.length, 2);
  const qualifiers = snapshot.edges.map((e) => e.semanticQualifier).sort();
  assert.deepEqual(qualifiers, ["GET:/api/users", "POST:/api/users"]);

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 10. Different endpoint patterns produce distinguishable edges", () => {
  const clientFile = "src/api/client.js";
  const backendFile = "src/routes/api.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  const evUsers = normalizeHttpResolution({
    id: "res_users",
    clientFileId: clientFile,
    clientFactId: "fact_users",
    backendFileId: backendFile,
    backendRouteFactId: "route_users",
    httpMethod: "GET",
    rawClientEndpoint: "/api/users",
    normalizedClientPattern: "/api/users",
    originalRoutePath: "/users",
    composedRoutePath: "/api/users",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
  });

  const evPosts = normalizeHttpResolution({
    id: "res_posts",
    clientFileId: clientFile,
    clientFactId: "fact_posts",
    backendFileId: backendFile,
    backendRouteFactId: "route_posts",
    httpMethod: "GET",
    rawClientEndpoint: "/api/posts",
    normalizedClientPattern: "/api/posts",
    originalRoutePath: "/posts",
    composedRoutePath: "/api/posts",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
  });

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [evUsers, evPosts],
  });

  assert.equal(snapshot.edges.length, 2);
  const qualifiers = snapshot.edges.map((e) => e.semanticQualifier).sort();
  assert.deepEqual(qualifiers, ["GET:/api/posts", "GET:/api/users"]);
});

test("Stage 4 - 11. Source and target manifest validation (missing target in manifest rejected)", () => {
  const clientFile = "src/api/client.js";
  const missingBackendFile = "src/routes/nonexistent.js";

  // Only clientFile is in fileIRList and manifest
  const fileIRList = [createSyntheticFileIR({ filePath: clientFile })];

  const ev = normalizeHttpResolution({
    id: "res_missing_backend",
    clientFileId: clientFile,
    clientFactId: "fact_ghost",
    backendFileId: missingBackendFile,
    backendRouteFactId: "route_ghost",
    httpMethod: "GET",
    rawClientEndpoint: "/api/ghost",
    normalizedClientPattern: "/api/ghost",
    originalRoutePath: "/ghost",
    composedRoutePath: "/api/ghost",
    classification: "confirmed_exact",
    mountChain: [],
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
  });

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    manifest: { files: [clientFile] }, // backend file missing from manifest
    normalizedEvidenceList: [ev],
  });

  // Edge MUST NOT be created because target is not in the revision
  assert.equal(snapshot.edges.length, 0);

  // Routed to unresolvedReferences
  assert.equal(snapshot.unresolvedReferences.length, 1);
  assert.equal(snapshot.unresolvedReferences[0].category, "http_request");

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 12. Invalid endpoint rejection (malformed inputs handled safely)", () => {
  const clientFile = "src/api/client.js";
  const fileIRList = [createSyntheticFileIR({ filePath: clientFile })];

  const builder = new GraphBuilder();

  // Null and malformed items should be skipped safely without crashing
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [
      null,
      undefined,
      {},
      { category: "http_request", status: { isConfirmed: false } },
    ],
  });

  assert.equal(snapshot.edges.length, 0);
  assert.equal(snapshot.nodes.length, 1);
  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 13. Evidence and mount-chain preservation in edge.evidence[0]", () => {
  const clientFile = "src/api/cartClient.js";
  const backendFile = "src/routes/cartRoutes.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  const mountChain = [
    { prefix: "/api", routerFileId: "src/app.js" },
    { prefix: "/v1", routerFileId: "src/routes/apiRouter.js" },
    { prefix: "/cart", routerFileId: backendFile },
  ];

  const res = {
    id: "cart_checkout_res",
    clientFileId: clientFile,
    clientFactId: "checkout_call",
    backendFileId: backendFile,
    backendRouteFactId: "route_checkout",
    httpMethod: "POST",
    rawClientEndpoint: "/api/v1/cart/checkout",
    normalizedClientPattern: "/api/v1/cart/checkout",
    originalRoutePath: "/checkout",
    composedRoutePath: "/api/v1/cart/checkout",
    classification: "confirmed_exact",
    mountChain,
    clientLocation: { start: { line: 14, column: 2 }, end: { line: 14, column: 42 } },
    backendLocation: { start: { line: 28, column: 0 }, end: { line: 32, column: 2 } },
    resolverVersion: "1.0.0",
    resolutionRule: "exact_literal_match",
    candidates: [{ routeFactId: "route_checkout", backendFileId: backendFile }],
  };

  const normEv = normalizeHttpResolution(res);
  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  const edge = snapshot.edges[0];
  assert.ok(edge);
  assert.deepEqual(edge.metadata.mountChain, mountChain);

  const evidenceItem = edge.evidence[0];
  assert.equal(evidenceItem.target.composedRoutePath, "/api/v1/cart/checkout");
  assert.equal(evidenceItem.target.originalRoutePath, "/checkout");
  assert.equal(evidenceItem.target.httpMethod, "POST");
  assert.deepEqual(evidenceItem.target.mountChain, mountChain);
  assert.deepEqual(evidenceItem.target.backendLocation, {
    start: { line: 28, column: 0 },
    end: { line: 32, column: 2 },
  });
});

test("Stage 4 - 14. Graph snapshot serialization and retrieval via GraphQueryService", () => {
  const clientFile = "src/api/profileClient.js";
  const backendFile = "src/routes/profileRoutes.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  const normEv = normalizeHttpResolution({
    id: "profile_res",
    clientFileId: clientFile,
    clientFactId: "fact_profile",
    backendFileId: backendFile,
    backendRouteFactId: "route_profile",
    httpMethod: "GET",
    rawClientEndpoint: "/api/profile",
    normalizedClientPattern: "/api/profile",
    originalRoutePath: "/profile",
    composedRoutePath: "/api/profile",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
  });

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [normEv],
  });

  // Verify JSON round-trip
  const jsonStr = JSON.stringify(snapshot);
  const deserialized = JSON.parse(jsonStr);

  const queryService = new GraphQueryService(deserialized);

  const clientNodeId = createFileNodeId(REPO_ID, COMMIT_SHA, clientFile);
  const backendNodeId = createFileNodeId(REPO_ID, COMMIT_SHA, backendFile);

  const clientNode = queryService.getNode(clientNodeId);
  assert.ok(clientNode);

  const outgoing = queryService.getOutgoingEdges(clientNodeId);
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].type, "http_request");
  assert.equal(outgoing[0].target, backendNodeId);

  const incoming = queryService.getIncomingEdges(backendNodeId);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].type, "http_request");
  assert.equal(incoming[0].source, clientNodeId);

  // Statistics verification
  assert.equal(deserialized.statistics.edgesByType.http_request, 1);
});

test("Stage 4 - 15. Existing imports and calls remain unchanged and unmixed", () => {
  const clientFile = "src/api/auth.js";
  const utilsFile = "src/utils/helpers.js";
  const backendFile = "src/routes/auth.js";

  const fileIRList = [
    createSyntheticFileIR({ filePath: clientFile }),
    createSyntheticFileIR({ filePath: utilsFile }),
    createSyntheticFileIR({ filePath: backendFile }),
  ];

  // 1. Static Import evidence: clientFile imports utilsFile
  const importEv = {
    id: "ev_imp_1",
    category: "dependency",
    sourceFile: clientFile,
    sourceFactId: "imp_1",
    sourceLocation: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
    resolver: { name: "JavaScriptModuleResolver", version: "1.0.0", rule: "relative_import" },
    status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true, confidence: "high" },
    target: { resolvedPath: utilsFile, rawSpecifier: "../utils/helpers" },
    languageMetadata: {},
  };

  // 2. Lexical Call fact: clientFile calls someLocalFn
  const callEv = {
    id: "ev_call_1",
    category: "call",
    sourceFile: clientFile,
    sourceFactId: "call_1",
    sourceLocation: { start: { line: 5, column: 2 }, end: { line: 5, column: 15 } },
    resolver: { name: "FileIRCallExtractor", version: "1.0.0", rule: "lexical_call_site" },
    status: { original: "unresolved", normalized: NORMALIZED_STATUSES.UNCONFIRMED, isConfirmed: false, confidence: "none" },
    target: { resolvedPath: null, rawSpecifier: "someLocalFn" },
    languageMetadata: {},
  };

  // 3. HTTP Request evidence: clientFile invokes backendFile endpoint
  const httpEv = normalizeHttpResolution({
    id: "http_login_res",
    clientFileId: clientFile,
    clientFactId: "fetch_login",
    backendFileId: backendFile,
    backendRouteFactId: "route_login",
    httpMethod: "POST",
    rawClientEndpoint: "/api/login",
    normalizedClientPattern: "/api/login",
    originalRoutePath: "/login",
    composedRoutePath: "/api/login",
    classification: "confirmed_exact",
    mountChain: [{ prefix: "/api", routerFileId: backendFile }],
  });

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
    normalizedEvidenceList: [importEv, callEv, httpEv],
  });

  // Verify edges: 1 import, 1 http_request
  assert.equal(snapshot.edges.length, 2);

  const importEdge = snapshot.edges.find((e) => e.type === EDGE_SEMANTICS.IMPORTS);
  assert.ok(importEdge);
  assert.equal(importEdge.type, "imports");
  assert.equal(importEdge.target, createFileNodeId(REPO_ID, COMMIT_SHA, utilsFile));

  const httpEdge = snapshot.edges.find((e) => e.type === EDGE_SEMANTICS.HTTP_REQUEST);
  assert.ok(httpEdge);
  assert.equal(httpEdge.type, "http_request");
  assert.equal(httpEdge.target, createFileNodeId(REPO_ID, COMMIT_SHA, backendFile));

  // Verify call fact is in unresolvedReferences, not promoting to edge
  const callUnresolved = snapshot.unresolvedReferences.find((u) => u.category === "call");
  assert.ok(callUnresolved);
  assert.equal(callUnresolved.rawSpecifier, "someLocalFn");

  // Statistics
  assert.equal(snapshot.statistics.edgesByType.imports, 1);
  assert.equal(snapshot.statistics.edgesByType.http_request, 1);
  assert.equal(snapshot.statistics.totalEdges, 2);

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
});

test("Stage 4 - 16. Existing folder aggregation handles HTTP edges correctly", async () => {
  // Test that folder aggregation in repositoryGraph logic cleanly aggregates http_request edges
  const { deriveDirectoryHierarchy } = await import("../../Frontend/src/lib/repositoryGraph.js");

  const repository = {
    repository: "acme/cartograph",
    commitSha: COMMIT_SHA,
    files: [
      { id: "f_frontend", path: "Frontend/src/api/auth.js" },
      { id: "f_backend", path: "Backend/routes/authRoutes.js" },
    ],
    edges: [
      {
        id: "edge_http_1",
        source: "f_frontend",
        target: "f_backend",
        type: "http_request",
        semanticQualifier: "POST:/api/login",
        evidence: [{ line: 12, raw: "fetch('/api/login', { method: 'POST' })" }],
      },
    ],
  };

  const hierarchy = deriveDirectoryHierarchy(repository);
  assert.equal(hierarchy.folderEdges.length, 1, "Must produce 1 top-level folder edge");
  assert.equal(hierarchy.folderEdges[0].source, "Frontend");
  assert.equal(hierarchy.folderEdges[0].target, "Backend");
  assert.equal(hierarchy.folderEdges[0].count, 1);
  assert.equal(hierarchy.folderEdges[0].underlyingEdges.length, 1);
  assert.equal(hierarchy.folderEdges[0].underlyingEdges[0].type, "http_request");
});

test("Stage 4 - 17. Full end-to-end integration via buildRepositoryGraph pipeline", async () => {
  const clientFile = "src/services/api.js";
  const backendFile = "server/routes/users.js";

  const clientHttpRequests = [
    {
      id: "fetch_users_fact",
      fileId: clientFile,
      index: 0,
      clientType: "fetch",
      clientMethod: "fetch",
      method: "GET",
      isMethodDynamic: false,
      rawMethod: "GET",
      url: "/api/users",
      rawUrl: "/api/users",
      staticPath: "/api/users",
      isDynamic: false,
      dynamicParts: [],
      template: null,
      isExternal: false,
      location: { start: { line: 12, column: 4 }, end: { line: 12, column: 25 } },
      urlLocation: { start: { line: 12, column: 10 }, end: { line: 12, column: 22 } },
      resolutionStatus: "extracted",
    },
  ];

  const backendExpressRoutes = [
    {
      id: "express_route_users_get",
      fileId: backendFile,
      index: 0,
      receiver: "router",
      receiverEvidence: "express_router_call",
      httpMethod: "GET",
      rawPath: "/users",
      routePath: "/users",
      isDynamic: false,
      dynamicParts: [],
      template: null,
      pathClassification: "static",
      handlers: [{ name: "getUsers", kind: "identifier" }],
      location: { start: { line: 5, column: 0 }, end: { line: 8, column: 2 } },
      pathLocation: { start: { line: 5, column: 11 }, end: { line: 5, column: 19 } },
    },
  ];

  const backendExpressMounts = [
    {
      id: "express_mount_api",
      fileId: "server/app.js",
      index: 0,
      receiver: "app",
      receiverEvidence: "express_app_call",
      mountPrefix: "/api",
      isPrefixDynamic: false,
      routerIdentifier: "usersRouter",
      importedModuleSpecifier: "./routes/users",
      importedFileId: backendFile,
      isLocalRouter: false,
      resolutionStatus: "resolved",
      location: { start: { line: 10, column: 0 }, end: { line: 10, column: 35 } },
    },
  ];

  const fileIRList = [
    createSyntheticFileIR({
      filePath: clientFile,
      httpRequests: clientHttpRequests,
    }),
    createSyntheticFileIR({
      filePath: backendFile,
      expressRoutes: backendExpressRoutes,
    }),
    createSyntheticFileIR({
      filePath: "server/app.js",
      expressMounts: backendExpressMounts,
    }),
  ];

  const result = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList,
  });

  assert.ok(result.snapshot);
  assert.ok(result.queryService);

  const snapshot = result.snapshot;
  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
  assert.deepEqual(validation.errors, []);

  // Verify HTTP edge was created automatically by pipeline
  const httpEdges = snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);
  assert.equal(httpEdges[0].semanticQualifier, "GET:/api/users");
  assert.equal(httpEdges[0].metadata.httpMethod, "GET");
  assert.equal(httpEdges[0].metadata.composedRoutePath, "/api/users");
  assert.equal(httpEdges[0].metadata.classification, "confirmed_exact");
});
