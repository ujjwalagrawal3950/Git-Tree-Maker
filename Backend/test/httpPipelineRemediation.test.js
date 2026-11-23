const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { buildRepositoryGraph } = require("../services/graph/graphPipeline");
const { normalizeHttpResolution } = require("../services/graph/evidenceNormalizer");
const { GraphBuilder } = require("../services/graph/GraphBuilder");
const { GraphValidator } = require("../services/graph/GraphValidator");
const { GraphQueryService } = require("../services/graph/GraphQueryService");
const { GraphSnapshotStore } = require("../services/graph/GraphSnapshotStore");
const { JavaScriptModuleResolver } = require("../services/parser/resolvers/javascript/JavaScriptModuleResolver");
const { HttpRouteResolver } = require("../services/parser/resolvers/HttpRouteResolver");
const { createFileId, buildFileIR } = require("../services/parser/irBuilder");
const { createFileNodeId, createEdgeId, EDGE_SEMANTICS } = require("../services/graph/identity");

const REPO_ID = "test-org/pipeline-remediation";
const COMMIT_SHA = "a1b2c3d4e5f60000000000000000000000000000";

function createSyntheticFileIR({
  filePath,
  httpRequests = [],
  expressRoutes = [],
  expressMounts = [],
  imports = [],
  calls = [],
}) {
  const fileId = createFileId(REPO_ID, filePath);
  const ir = buildFileIR({
    repository: {
      owner: "test-org",
      name: "pipeline-remediation",
      fullName: REPO_ID,
      commitSha: COMMIT_SHA,
    },
    file: {
      fileId,
      path: filePath,
      language: "javascript",
      category: "source",
      content: "// synthetic source",
    },
    parser: {
      adapterId: "synthetic-js",
      adapterVersion: "1.0.0",
      engine: "test",
      engineVersion: "1.0.0",
      status: "complete",
    },
    imports,
    callSites: calls,
  });

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

// ============================================================================
// PART 1: ROUTER RESOLUTION
// ============================================================================

test("1. Resolve imported router module from its mount specifier in graphPipeline", async () => {
  const appFile = "src/app.js";
  const authRoutesFile = "src/routes/authRoutes.js";

  const appIR = createSyntheticFileIR({
    filePath: appFile,
    expressMounts: [
      {
        id: "mount_1",
        fileId: createFileId(REPO_ID, appFile),
        mountPrefix: "/api/auth",
        isPrefixDynamic: false,
        routerIdentifier: "authRouter",
        importedModuleSpecifier: "./routes/authRoutes",
        importedFileId: null, // intentionally null before pipeline resolution
        resolutionStatus: "unresolved",
      },
    ],
  });

  const authIR = createSyntheticFileIR({
    filePath: authRoutesFile,
    expressRoutes: [
      {
        id: "route_me",
        fileId: createFileId(REPO_ID, authRoutesFile),
        httpMethod: "GET",
        routePath: "/me",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const clientIR = createSyntheticFileIR({
    filePath: "src/client/api.js",
    httpRequests: [
      {
        id: "req_me",
        fileId: createFileId(REPO_ID, "src/client/api.js"),
        method: "GET",
        url: "/api/auth/me",
        staticPath: "/api/auth/me",
        isDynamic: false,
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [appIR, authIR, clientIR],
  }, {
    manifest: [appFile, authRoutesFile, "src/client/api.js"],
  });

  assert.ok(res.snapshot);
  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);
  assert.equal(httpEdges[0].metadata.composedRoutePath, "/api/auth/me");
  assert.equal(httpEdges[0].metadata.httpMethod, "GET");
});

test("2. Compose /api/auth with /me", async () => {
  const appFile = "server/index.js";
  const authFile = "server/routes/auth.js";

  const appIR = createSyntheticFileIR({
    filePath: appFile,
    expressMounts: [
      {
        id: "mount_auth",
        fileId: createFileId(REPO_ID, appFile),
        mountPrefix: "/api/auth",
        importedModuleSpecifier: "./routes/auth.js",
        importedFileId: null,
      },
    ],
  });

  const authIR = createSyntheticFileIR({
    filePath: authFile,
    expressRoutes: [
      {
        id: "route_me",
        fileId: createFileId(REPO_ID, authFile),
        httpMethod: "GET",
        routePath: "/me",
        isDynamic: false,
        pathClassification: "static",
      },
      {
        id: "route_logout",
        fileId: createFileId(REPO_ID, authFile),
        httpMethod: "POST",
        routePath: "/logout",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const clientIR = createSyntheticFileIR({
    filePath: "client/authSlice.js",
    httpRequests: [
      {
        id: "req_auth_me",
        fileId: createFileId(REPO_ID, "client/authSlice.js"),
        method: "GET",
        url: "/api/auth/me",
        staticPath: "/api/auth/me",
        isDynamic: false,
      },
      {
        id: "req_auth_logout",
        fileId: createFileId(REPO_ID, "client/authSlice.js"),
        method: "POST",
        url: "/api/auth/logout",
        staticPath: "/api/auth/logout",
        isDynamic: false,
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [appIR, authIR, clientIR],
  }, {
    manifest: [appFile, authFile, "client/authSlice.js"],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 2);
  const paths = httpEdges.map((e) => e.metadata.composedRoutePath).sort();
  assert.deepEqual(paths, ["/api/auth/logout", "/api/auth/me"]);
});

test("3. Compose /api/boards with board routes", async () => {
  const appFile = "server/index.js";
  const boardsFile = "server/routes/boards.js";

  const appIR = createSyntheticFileIR({
    filePath: appFile,
    expressMounts: [
      {
        id: "mount_boards",
        fileId: createFileId(REPO_ID, appFile),
        mountPrefix: "/api/boards",
        importedModuleSpecifier: "./routes/boards.js",
        importedFileId: null,
      },
    ],
  });

  const boardsIR = createSyntheticFileIR({
    filePath: boardsFile,
    expressRoutes: [
      {
        id: "route_my_boards",
        fileId: createFileId(REPO_ID, boardsFile),
        httpMethod: "GET",
        routePath: "/my-boards",
        isDynamic: false,
        pathClassification: "static",
      },
      {
        id: "route_board_id",
        fileId: createFileId(REPO_ID, boardsFile),
        httpMethod: "GET",
        routePath: "/:id",
        isDynamic: true,
        dynamicParts: ["id"],
        pathClassification: "parameterized",
      },
    ],
  });

  const clientIR = createSyntheticFileIR({
    filePath: "client/boardSlice.js",
    httpRequests: [
      {
        id: "req_my_boards",
        fileId: createFileId(REPO_ID, "client/boardSlice.js"),
        method: "GET",
        url: "/api/boards/my-boards",
        staticPath: "/api/boards/my-boards",
        isDynamic: false,
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [appIR, boardsIR, clientIR],
  }, {
    manifest: [appFile, boardsFile, "client/boardSlice.js"],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);
  assert.equal(httpEdges[0].metadata.composedRoutePath, "/api/boards/my-boards");
  assert.equal(httpEdges[0].metadata.classification, "confirmed_exact");
});

test("4. Compose /api/libraries with library routes", async () => {
  const appFile = "server/index.js";
  const libFile = "server/routes/libraries.js";

  const appIR = createSyntheticFileIR({
    filePath: appFile,
    expressMounts: [
      {
        id: "mount_libraries",
        fileId: createFileId(REPO_ID, appFile),
        mountPrefix: "/api/libraries",
        importedModuleSpecifier: "./routes/libraries.js",
        importedFileId: null,
      },
    ],
  });

  const libIR = createSyntheticFileIR({
    filePath: libFile,
    expressRoutes: [
      {
        id: "route_root",
        fileId: createFileId(REPO_ID, libFile),
        httpMethod: "POST",
        routePath: "/",
        isDynamic: false,
        pathClassification: "static",
      },
      {
        id: "route_download",
        fileId: createFileId(REPO_ID, libFile),
        httpMethod: "PATCH",
        routePath: "/:id/download",
        isDynamic: true,
        dynamicParts: ["id"],
        pathClassification: "parameterized",
      },
    ],
  });

  const clientIR = createSyntheticFileIR({
    filePath: "client/LibrariesPage.jsx",
    httpRequests: [
      {
        id: "req_create_lib",
        fileId: createFileId(REPO_ID, "client/LibrariesPage.jsx"),
        method: "POST",
        url: "/api/libraries",
        staticPath: "/api/libraries",
        isDynamic: false,
      },
      {
        id: "req_download_lib",
        fileId: createFileId(REPO_ID, "client/LibrariesPage.jsx"),
        method: "PATCH",
        url: "/api/libraries/123/download",
        staticPath: "/api/libraries/123/download",
        template: "/api/libraries/:id/download",
        isDynamic: true,
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [appIR, libIR, clientIR],
  }, {
    manifest: [appFile, libFile, "client/LibrariesPage.jsx"],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 2);
  const exact = httpEdges.find((e) => e.metadata.httpMethod === "POST");
  const pattern = httpEdges.find((e) => e.metadata.httpMethod === "PATCH");
  assert.ok(exact);
  assert.equal(exact.metadata.classification, "confirmed_exact");
  assert.equal(exact.metadata.composedRoutePath, "/api/libraries");
  assert.ok(pattern);
  assert.equal(pattern.metadata.classification, "pattern_compatible");
  assert.equal(pattern.metadata.composedRoutePath, "/api/libraries/:id/download");
});

test("5. Preserve nested router mount behavior (app -> apiRouter -> userRouter)", async () => {
  const appFile = "src/app.js";
  const apiRouterFile = "src/routes/api.js";
  const userRouterFile = "src/routes/users.js";

  const appIR = createSyntheticFileIR({
    filePath: appFile,
    expressMounts: [
      {
        id: "m_app_api",
        fileId: createFileId(REPO_ID, appFile),
        mountPrefix: "/api",
        importedModuleSpecifier: "./routes/api",
        importedFileId: null,
      },
    ],
  });

  const apiIR = createSyntheticFileIR({
    filePath: apiRouterFile,
    expressMounts: [
      {
        id: "m_api_users",
        fileId: createFileId(REPO_ID, apiRouterFile),
        mountPrefix: "/users",
        importedModuleSpecifier: "./users",
        importedFileId: null,
      },
    ],
  });

  const userIR = createSyntheticFileIR({
    filePath: userRouterFile,
    expressRoutes: [
      {
        id: "r_get_users",
        fileId: createFileId(REPO_ID, userRouterFile),
        httpMethod: "GET",
        routePath: "/list",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const clientIR = createSyntheticFileIR({
    filePath: "src/client.js",
    httpRequests: [
      {
        id: "req_users",
        fileId: createFileId(REPO_ID, "src/client.js"),
        method: "GET",
        url: "/api/users/list",
        staticPath: "/api/users/list",
        isDynamic: false,
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [appIR, apiIR, userIR, clientIR],
  }, {
    manifest: [appFile, apiRouterFile, userRouterFile, "src/client.js"],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);
  assert.equal(httpEdges[0].metadata.composedRoutePath, "/api/users/list");
});

test("6. Preserve ambiguous and unresolved module resolution", async () => {
  const appFile = "src/app.js";

  const appIR = createSyntheticFileIR({
    filePath: appFile,
    expressMounts: [
      {
        id: "m_non_existent",
        fileId: createFileId(REPO_ID, appFile),
        mountPrefix: "/api/missing",
        importedModuleSpecifier: "./routes/doesNotExist",
        importedFileId: null,
      },
    ],
  });

  const clientIR = createSyntheticFileIR({
    filePath: "src/client.js",
    httpRequests: [
      {
        id: "req_miss",
        fileId: createFileId(REPO_ID, "src/client.js"),
        method: "GET",
        url: "/api/missing/items",
        staticPath: "/api/missing/items",
        isDynamic: false,
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [appIR, clientIR],
  }, {
    manifest: [appFile, "src/client.js"],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 0); // No fabricated edge
  assert.equal(res.snapshot.unresolvedReferences.length, 1);
  assert.equal(res.snapshot.unresolvedReferences[0].category, "http_request");
});

// ============================================================================
// PART 2: PATH NORMALIZATION
// ============================================================================

test("7. Convert client FileIR identifier into its correct repository-relative path", () => {
  const clientFileId = createFileId(REPO_ID, "frontend/src/store/authSlice.jsx");
  const backendFileId = createFileId(REPO_ID, "backend/src/routes/auth.js");

  const fileIdToPathMap = new Map([
    [clientFileId, "frontend/src/store/authSlice.jsx"],
    [backendFileId, "backend/src/routes/auth.js"],
  ]);

  const resolution = {
    id: "res_auth_me",
    clientFileId,
    backendFileId,
    httpMethod: "GET",
    composedRoutePath: "/api/auth/me",
    classification: "confirmed_exact",
  };

  const normEv = normalizeHttpResolution(resolution, { fileIdToPathMap });
  assert.equal(normEv.sourceFile, "frontend/src/store/authSlice.jsx");
  assert.notEqual(normEv.sourceFile, clientFileId);
  assert.equal(normEv.target.resolvedPath, "backend/src/routes/auth.js");
  assert.equal(normEv.status.isConfirmed, true);
  // Preserved for debugging/provenance
  assert.equal(normEv.target.clientFileId, clientFileId);
  assert.equal(normEv.target.backendFileId, backendFileId);
});

test("8. Convert backend FileIR identifier into its correct repository-relative path", () => {
  const clientFileId = createFileId(REPO_ID, "src/client/users.ts");
  const backendFileId = createFileId(REPO_ID, "src/server/usersController.ts");

  const fileIdToPathMap = new Map([
    [clientFileId, "src/client/users.ts"],
    [backendFileId, "src/server/usersController.ts"],
  ]);

  const resolution = {
    id: "res_users",
    clientFileId,
    backendFileId,
    httpMethod: "GET",
    composedRoutePath: "/api/users",
    classification: "confirmed_exact",
  };

  const normEv = normalizeHttpResolution(resolution, { fileIdToPathMap });
  assert.equal(normEv.target.resolvedPath, "src/server/usersController.ts");
  assert.notEqual(normEv.target.resolvedPath, backendFileId);
  assert.equal(normEv.status.isConfirmed, true);
});

test("9. Reject unmapped client identifiers (fail safely to unconfirmed)", () => {
  const unmappedClientFileId = "file_unknown_frontend_unknown.js";
  const backendFileId = createFileId(REPO_ID, "src/routes/auth.js");

  const fileIdToPathMap = new Map([
    [backendFileId, "src/routes/auth.js"],
  ]);

  const resolution = {
    id: "res_orphan_client",
    clientFileId: unmappedClientFileId,
    backendFileId,
    httpMethod: "POST",
    composedRoutePath: "/api/login",
    classification: "confirmed_exact",
  };

  const normEv = normalizeHttpResolution(resolution, { fileIdToPathMap });
  // Cannot map client identifier to relative path: must fail safely
  assert.equal(normEv.sourceFile, null);
  assert.equal(normEv.status.isConfirmed, false);
  assert.equal(normEv.status.normalized, "unresolved");
});

test("10. Reject unmapped backend identifiers (fail safely to unconfirmed)", () => {
  const clientFileId = createFileId(REPO_ID, "src/client/api.js");
  const unmappedBackendFileId = "file_unknown_backend_unknown.js";

  const fileIdToPathMap = new Map([
    [clientFileId, "src/client/api.js"],
  ]);

  const resolution = {
    id: "res_orphan_backend",
    clientFileId,
    backendFileId: unmappedBackendFileId,
    httpMethod: "GET",
    composedRoutePath: "/api/status",
    classification: "confirmed_exact",
  };

  const normEv = normalizeHttpResolution(resolution, { fileIdToPathMap });
  assert.equal(normEv.target.resolvedPath, null);
  assert.equal(normEv.status.isConfirmed, false);
  assert.equal(normEv.status.normalized, "unresolved");
});

test("11. Confirm GraphBuilder creates valid canonical node IDs with normalized evidence", () => {
  const clientPath = "frontend/src/api.js";
  const backendPath = "backend/src/routes.js";

  const clientFileId = createFileId(REPO_ID, clientPath);
  const backendFileId = createFileId(REPO_ID, backendPath);

  const fileIdToPathMap = new Map([
    [clientFileId, clientPath],
    [backendFileId, backendPath],
  ]);

  const resolution = {
    id: "res_canonical_id",
    clientFileId,
    backendFileId,
    httpMethod: "GET",
    composedRoutePath: "/api/data",
    classification: "confirmed_exact",
  };

  const normEv = normalizeHttpResolution(resolution, { fileIdToPathMap });

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [
      createSyntheticFileIR({ filePath: clientPath }),
      createSyntheticFileIR({ filePath: backendPath }),
    ],
    normalizedEvidenceList: [normEv],
    manifest: [clientPath, backendPath],
  });

  const httpEdges = snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);
  const edge = httpEdges[0];

  const expectedSourceNode = createFileNodeId(REPO_ID, COMMIT_SHA, clientPath);
  const expectedTargetNode = createFileNodeId(REPO_ID, COMMIT_SHA, backendPath);

  assert.equal(edge.source, expectedSourceNode);
  assert.equal(edge.target, expectedTargetNode);
  assert.equal(edge.source.includes("file_"), false, "Node ID must never embed FileIR ID string");
  assert.equal(edge.target.includes("file_"), false, "Node ID must never embed FileIR ID string");
});

test("12. Confirm manifest validation succeeds for legitimate paths", () => {
  const clientPath = "src/client/feed.js";
  const backendPath = "src/routes/feed.js";

  const fileIdToPathMap = new Map([
    [createFileId(REPO_ID, clientPath), clientPath],
    [createFileId(REPO_ID, backendPath), backendPath],
  ]);

  const resolution = {
    id: "res_manifest",
    clientFileId: createFileId(REPO_ID, clientPath),
    backendFileId: createFileId(REPO_ID, backendPath),
    httpMethod: "GET",
    composedRoutePath: "/api/feed",
    classification: "confirmed_exact",
  };

  const normEv = normalizeHttpResolution(resolution, { fileIdToPathMap });

  const builder = new GraphBuilder();
  const snapshot = builder.build({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [
      createSyntheticFileIR({ filePath: clientPath }),
      createSyntheticFileIR({ filePath: backendPath }),
    ],
    normalizedEvidenceList: [normEv],
    manifest: [clientPath, backendPath],
  });

  const validation = GraphValidator.validate(snapshot);
  assert.equal(validation.isValid, true);
  assert.deepEqual(validation.errors, []);
  assert.equal(snapshot.unresolvedReferences.length, 0);
});

// ============================================================================
// PART 3: END-TO-END REGRESSION
// ============================================================================

test("13. Confirm exact HTTP edge publication", async () => {
  const clientPath = "src/store/userSlice.js";
  const backendPath = "server/routes/users.js";

  const clientIR = createSyntheticFileIR({
    filePath: clientPath,
    httpRequests: [
      {
        id: "req_exact_user",
        fileId: createFileId(REPO_ID, clientPath),
        method: "POST",
        url: "/api/users",
        staticPath: "/api/users",
        isDynamic: false,
      },
    ],
  });

  const backendIR = createSyntheticFileIR({
    filePath: backendPath,
    expressRoutes: [
      {
        id: "route_post_user",
        fileId: createFileId(REPO_ID, backendPath),
        httpMethod: "POST",
        routePath: "/api/users",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [clientIR, backendIR],
  }, {
    manifest: [clientPath, backendPath],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);
  assert.equal(httpEdges[0].metadata.classification, "confirmed_exact");
  assert.equal(httpEdges[0].metadata.isPatternCompatible, false);
  assert.equal(httpEdges[0].semanticQualifier, "POST:/api/users");
});

test("14. Confirm pattern-compatible classification remains distinct", async () => {
  const clientPath = "src/store/detailSlice.js";
  const backendPath = "server/routes/items.js";

  const clientIR = createSyntheticFileIR({
    filePath: clientPath,
    httpRequests: [
      {
        id: "req_pattern_item",
        fileId: createFileId(REPO_ID, clientPath),
        method: "GET",
        url: "/api/items/456",
        staticPath: "/api/items/456",
        template: "/api/items/:id",
        isDynamic: true,
      },
    ],
  });

  const backendIR = createSyntheticFileIR({
    filePath: backendPath,
    expressRoutes: [
      {
        id: "route_get_item",
        fileId: createFileId(REPO_ID, backendPath),
        httpMethod: "GET",
        routePath: "/api/items/:id",
        isDynamic: true,
        dynamicParts: ["id"],
        pathClassification: "parameterized",
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [clientIR, backendIR],
  }, {
    manifest: [clientPath, backendPath],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1);
  assert.equal(httpEdges[0].metadata.classification, "pattern_compatible");
  assert.equal(httpEdges[0].metadata.isPatternCompatible, true);
  assert.equal(httpEdges[0].semanticQualifier, "GET:/api/items/:id:pattern");
});

test("15. Confirm ambiguous references do not create confirmed edges", async () => {
  const clientPath = "src/client/ambig.js";
  const backendPath1 = "server/routes/v1.js";
  const backendPath2 = "server/routes/v2.js";

  const clientIR = createSyntheticFileIR({
    filePath: clientPath,
    httpRequests: [
      {
        id: "req_ambig",
        fileId: createFileId(REPO_ID, clientPath),
        method: "GET",
        url: "/api/search",
        staticPath: "/api/search",
        isDynamic: false,
      },
    ],
  });

  const backendIR1 = createSyntheticFileIR({
    filePath: backendPath1,
    expressRoutes: [
      {
        id: "r_v1_search",
        fileId: createFileId(REPO_ID, backendPath1),
        httpMethod: "GET",
        routePath: "/api/search",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const backendIR2 = createSyntheticFileIR({
    filePath: backendPath2,
    expressRoutes: [
      {
        id: "r_v2_search",
        fileId: createFileId(REPO_ID, backendPath2),
        httpMethod: "GET",
        routePath: "/api/search",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [clientIR, backendIR1, backendIR2],
  }, {
    manifest: [clientPath, backendPath1, backendPath2],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 0, "Ambiguous matches must never produce confirmed edges");
  assert.equal(res.snapshot.unresolvedReferences.length, 1);
  assert.equal(res.snapshot.unresolvedReferences[0].status, "ambiguous");
});

test("16. Confirm deterministic IDs and deduplication of multiple identical requests", async () => {
  const clientPath = "src/client/multi.js";
  const backendPath = "server/routes/multi.js";

  const clientIR = createSyntheticFileIR({
    filePath: clientPath,
    httpRequests: [
      {
        id: "req_dup_1",
        fileId: createFileId(REPO_ID, clientPath),
        method: "GET",
        url: "/api/ping",
        staticPath: "/api/ping",
        isDynamic: false,
      },
      {
        id: "req_dup_2",
        fileId: createFileId(REPO_ID, clientPath),
        method: "GET",
        url: "/api/ping",
        staticPath: "/api/ping",
        isDynamic: false,
      },
    ],
  });

  const backendIR = createSyntheticFileIR({
    filePath: backendPath,
    expressRoutes: [
      {
        id: "route_ping",
        fileId: createFileId(REPO_ID, backendPath),
        httpMethod: "GET",
        routePath: "/api/ping",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [clientIR, backendIR],
  }, {
    manifest: [clientPath, backendPath],
  });

  const httpEdges = res.snapshot.edges.filter((e) => e.type === "http_request");
  assert.equal(httpEdges.length, 1, "Duplicate requests between same files must deduplicate to 1 edge");
  assert.equal(httpEdges[0].evidence.length, 2, "Deduplicated edge must preserve both evidence records");
});

test("17. Confirm HTTP evidence survives snapshot serialization and retrieval", async () => {
  const clientPath = "src/client/store.js";
  const backendPath = "server/routes/api.js";

  const clientIR = createSyntheticFileIR({
    filePath: clientPath,
    httpRequests: [
      {
        id: "req_serialize",
        fileId: createFileId(REPO_ID, clientPath),
        method: "GET",
        url: "/api/config",
        staticPath: "/api/config",
        isDynamic: false,
      },
    ],
  });

  const backendIR = createSyntheticFileIR({
    filePath: backendPath,
    expressRoutes: [
      {
        id: "route_config",
        fileId: createFileId(REPO_ID, backendPath),
        httpMethod: "GET",
        routePath: "/api/config",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const store = new GraphSnapshotStore();
  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [clientIR, backendIR],
  }, {
    store,
    manifest: [clientPath, backendPath],
  });

  // Verify byte-level serialization / deserialization roundtrip
  const jsonStr = JSON.stringify(res.snapshot);
  const parsed = JSON.parse(jsonStr);

  const queryService = new GraphQueryService(parsed);
  assert.equal(queryService.edges.length, 1);
  const edge = queryService.edges[0];
  assert.equal(edge.type, "http_request");
  assert.equal(edge.metadata.composedRoutePath, "/api/config");
  assert.equal(edge.evidence.length, 1);
  assert.equal(edge.evidence[0].category, "http_request");
});

test("18. Confirm existing imports and calls remain unchanged alongside HTTP edges", async () => {
  const clientPath = "src/components/UserView.jsx";
  const sharedPath = "src/shared/types.js";
  const backendPath = "src/server/userRoutes.js";

  const clientIR = createSyntheticFileIR({
    filePath: clientPath,
    imports: [
      {
        id: "imp_shared",
        rawSource: "../shared/types",
      },
    ],
    calls: [
      {
        id: "call_format",
        calleeName: "formatUser",
        location: { start: { line: 12, column: 4 }, end: { line: 12, column: 20 } },
      },
    ],
    httpRequests: [
      {
        id: "req_get_user",
        fileId: createFileId(REPO_ID, clientPath),
        method: "GET",
        url: "/api/user",
        staticPath: "/api/user",
        isDynamic: false,
      },
    ],
  });

  const sharedIR = createSyntheticFileIR({
    filePath: sharedPath,
  });

  const backendIR = createSyntheticFileIR({
    filePath: backendPath,
    expressRoutes: [
      {
        id: "route_get_user",
        fileId: createFileId(REPO_ID, backendPath),
        httpMethod: "GET",
        routePath: "/api/user",
        isDynamic: false,
        pathClassification: "static",
      },
    ],
  });

  const res = await buildRepositoryGraph({
    repositoryId: REPO_ID,
    commitSha: COMMIT_SHA,
    fileIRList: [clientIR, sharedIR, backendIR],
  }, {
    manifest: [clientPath, sharedPath, backendPath],
  });

  const edges = res.snapshot.edges;
  const importEdges = edges.filter((e) => e.type === "imports");
  const httpEdges = edges.filter((e) => e.type === "http_request");

  assert.equal(importEdges.length, 1, "Imports edge must be preserved");
  assert.equal(httpEdges.length, 1, "HTTP request edge must be preserved");

  assert.equal(importEdges[0].source, createFileNodeId(REPO_ID, COMMIT_SHA, clientPath));
  assert.equal(importEdges[0].target, createFileNodeId(REPO_ID, COMMIT_SHA, sharedPath));

  assert.equal(httpEdges[0].source, createFileNodeId(REPO_ID, COMMIT_SHA, clientPath));
  assert.equal(httpEdges[0].target, createFileNodeId(REPO_ID, COMMIT_SHA, backendPath));

  // Call sites without unique symbol evidence remain safely tracked in unresolvedReferences
  const unresCalls = res.snapshot.unresolvedReferences.filter((u) => u.category === "call");
  assert.equal(unresCalls.length, 1, "Unconfirmed call fact must be preserved in unresolvedReferences");
  assert.equal(unresCalls[0].sourceFile, clientPath);
});
