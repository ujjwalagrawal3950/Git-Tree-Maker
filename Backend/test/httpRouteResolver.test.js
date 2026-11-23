const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HttpRouteResolver,
  normalizePath,
  joinPaths,
  splitSegments,
  matchPathStructural,
  composeBackendRoutes,
} = require("../services/parser/resolvers/HttpRouteResolver");

const { createSourceAST } = require("../services/parser/adapters/javascript/parserFactory");
const { extractHttpRequests } = require("../services/parser/adapters/javascript/httpRequestExtractor");
const {
  extractExpressRoutes,
  extractExpressMounts,
  extractExpressFacts,
} = require("../services/parser/adapters/javascript/expressRouteExtractor");
const { JavaScriptAdapter } = require("../services/parser/adapters/javascript/JavaScriptAdapter");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "google",
  name: "cartograph",
  fullName: "google/cartograph",
  commitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
};

// ============================================================================
// 1. EXACT LITERAL GET MATCH
// ============================================================================

test("HttpRouteResolver: 1. Exact literal GET match", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#http_0",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/api/users"`,
      staticPath: "/api/users",
      isDynamic: false,
      isExternal: false,
      location: { start: { line: 5, column: 10 }, end: { line: 5, column: 28 } },
    },
  ];

  const backendRoutes = [
    {
      id: "app#route_0",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "GET",
      routePath: "/api/users",
      rawPath: `"/api/users"`,
      isDynamic: false,
      pathClassification: "static",
      handlers: [{ name: "getUsers", isMiddleware: false }],
      location: { start: { line: 12, column: 0 }, end: { line: 12, column: 35 } },
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.confirmedExact, 1);
  assert.equal(res.resolutions.length, 1);

  const r = res.resolutions[0];
  assert.equal(r.classification, "confirmed_exact");
  assert.equal(r.backendFileId, "file_app_js");
  assert.equal(r.backendRouteFactId, "app#route_0");
  assert.equal(r.composedRoutePath, "/api/users");
  assert.equal(r.resolutionRule, "exact_literal_match");
});

// ============================================================================
// 2. EXACT LITERAL POST MATCH
// ============================================================================

test("HttpRouteResolver: 2. Exact literal POST match", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "auth#http_0",
      fileId: "file_auth_js",
      method: "POST",
      rawUrl: `"/api/auth/login"`,
      staticPath: "/api/auth/login",
      isDynamic: false,
      isExternal: false,
      location: { start: { line: 10, column: 4 }, end: { line: 10, column: 45 } },
    },
  ];

  const backendRoutes = [
    {
      id: "auth#route_0",
      fileId: "file_auth_routes_js",
      receiver: "authRouter",
      httpMethod: "POST",
      routePath: "/login",
      rawPath: `"/login"`,
      isDynamic: false,
      pathClassification: "static",
      handlers: [{ name: "loginUser", isMiddleware: false }],
      location: { start: { line: 8, column: 0 }, end: { line: 8, column: 40 } },
    },
  ];

  const backendMounts = [
    {
      id: "app#mount_0",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/api/auth",
      isPrefixDynamic: false,
      importedFileId: "file_auth_routes_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts });
  assert.equal(res.summary.confirmedExact, 1);

  const r = res.resolutions[0];
  assert.equal(r.classification, "confirmed_exact");
  assert.equal(r.composedRoutePath, "/api/auth/login");
  assert.equal(r.backendRouteFactId, "auth#route_0");
});

// ============================================================================
// 3. HTTP METHOD MISMATCH
// ============================================================================

test("HttpRouteResolver: 3. HTTP method mismatch produces unresolved status", () => {
  const resolver = new HttpRouteResolver();

  // Client attempts POST to an endpoint that only defines GET
  const clientRequests = [
    {
      id: "client#http_post",
      fileId: "file_client_js",
      method: "POST",
      rawUrl: `"/api/health"`,
      staticPath: "/api/health",
      isDynamic: false,
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "app#route_health",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "GET",
      routePath: "/api/health",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.unresolved, 1);
  assert.equal(res.resolutions[0].classification, "unresolved");
  assert.equal(res.resolutions[0].backendRouteFactId, null);
});

// ============================================================================
// 4. EXPRESS PARAMETERIZED ROUTE MATCHING
// ============================================================================

test("HttpRouteResolver: 4. Express parameterized route matching (literal client value -> :id)", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#http_user_123",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/api/users/123"`,
      staticPath: "/api/users/123",
      isDynamic: false,
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "user#route_param",
      fileId: "file_user_routes_js",
      receiver: "userRouter",
      httpMethod: "GET",
      routePath: "/users/:id",
      isDynamic: false,
      pathClassification: "parameterized",
      dynamicParts: ["id"],
    },
  ];

  const backendMounts = [
    {
      id: "app#mount_api",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/api",
      isPrefixDynamic: false,
      importedFileId: "file_user_routes_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts });
  assert.equal(res.summary.patternCompatible, 1);

  const r = res.resolutions[0];
  assert.equal(r.classification, "pattern_compatible");
  assert.equal(r.composedRoutePath, "/api/users/:id");
  assert.equal(r.backendRouteFactId, "user#route_param");
});

// ============================================================================
// 5. DYNAMIC FRONTEND TEMPLATE MATCHING
// ============================================================================

test("HttpRouteResolver: 5. Dynamic frontend template matching (${userId} -> :id)", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#http_template",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: "` /api/v1/users/${userId}/orders/${orderId} `",
      staticPath: null,
      template: "/api/v1/users/:userId/orders/:orderId",
      isDynamic: true,
      dynamicParts: ["userId", "orderId"],
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "route#orders",
      fileId: "file_routes_js",
      receiver: "router",
      httpMethod: "GET",
      routePath: "/users/:id/orders/:orderNum",
      isDynamic: false,
      pathClassification: "parameterized",
      dynamicParts: ["id", "orderNum"],
    },
  ];

  const backendMounts = [
    {
      id: "mount#v1",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/api/v1",
      isPrefixDynamic: false,
      importedFileId: "file_routes_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts });
  assert.equal(res.summary.patternCompatible, 1);

  const r = res.resolutions[0];
  assert.equal(r.classification, "pattern_compatible");
  assert.equal(r.composedRoutePath, "/api/v1/users/:id/orders/:orderNum");
  assert.equal(r.backendRouteFactId, "route#orders");
});

// ============================================================================
// 6. PATTERN-COMPATIBLE VERSUS EXACT CLASSIFICATION
// ============================================================================

test("HttpRouteResolver: 6. Pattern-compatible versus confirmed-exact classification boundary", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    // Static literal client call
    {
      id: "client#exact",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/api/docs"`,
      staticPath: "/api/docs",
      isDynamic: false,
      isExternal: false,
    },
    // Dynamic template client call
    {
      id: "client#dyn",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: "` /api/docs/${docId} `",
      staticPath: null,
      template: "/api/docs/:docId",
      isDynamic: true,
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "route#doc_exact",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "GET",
      routePath: "/api/docs",
      isDynamic: false,
      pathClassification: "static",
    },
    {
      id: "route#doc_param",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "GET",
      routePath: "/api/docs/:id",
      isDynamic: false,
      pathClassification: "parameterized",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.confirmedExact, 1);
  assert.equal(res.summary.patternCompatible, 1);

  assert.equal(res.resolutions[0].classification, "confirmed_exact");
  assert.equal(res.resolutions[0].backendRouteFactId, "route#doc_exact");

  assert.equal(res.resolutions[1].classification, "pattern_compatible");
  assert.equal(res.resolutions[1].backendRouteFactId, "route#doc_param");
});

// ============================================================================
// 7. QUERY STRING AND TRAILING SLASH NORMALIZATION
// ============================================================================

test("HttpRouteResolver: 7. Query string and trailing slash normalization", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#query_slash",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/api/reports/?status=active&sort=desc#anchor"`,
      staticPath: "/api/reports",
      isDynamic: false,
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "route#reports",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "GET",
      routePath: "/api/reports/", // Backend declared with trailing slash
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.confirmedExact, 1);
  assert.equal(res.resolutions[0].classification, "confirmed_exact");
  assert.equal(res.resolutions[0].composedRoutePath, "/api/reports");
});

// ============================================================================
// 8. ROUTER MOUNT PREFIX COMPOSITION
// ============================================================================

test("HttpRouteResolver: 8. Router mount prefix composition (app.use('/api', authRouter))", () => {
  const allRoutes = [
    {
      id: "route#login",
      fileId: "file_auth_js",
      receiver: "authRouter",
      httpMethod: "POST",
      routePath: "/login",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const allMounts = [
    {
      id: "mount#api",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/api",
      importedFileId: "file_auth_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
  ];

  const composed = composeBackendRoutes(allRoutes, allMounts);
  assert.equal(composed.length, 1);
  assert.equal(composed[0].composedRoutePath, "/api/login");
  assert.equal(composed[0].mountChain.length, 1);
  assert.equal(composed[0].mountChain[0].mountPrefix, "/api");
});

// ============================================================================
// 9. NESTED ROUTER MOUNTS ACROSS FILES
// ============================================================================

test("HttpRouteResolver: 9. Nested router mounts across multiple files (app -> apiRouter -> userRouter)", () => {
  const allRoutes = [
    {
      id: "route#user_detail",
      fileId: "file_user_js",
      receiver: "userRouter",
      httpMethod: "GET",
      routePath: "/:userId",
      isDynamic: false,
      pathClassification: "parameterized",
    },
  ];

  const allMounts = [
    // app.js: app.use('/api', apiRouter)
    {
      id: "mount#app_api",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/api",
      importedFileId: "file_api_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
    // apiRoutes.js: apiRouter.use('/users', userRouter)
    {
      id: "mount#api_user",
      fileId: "file_api_js",
      receiver: "apiRouter",
      mountPrefix: "/users",
      importedFileId: "file_user_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
  ];

  const composed = composeBackendRoutes(allRoutes, allMounts);
  assert.equal(composed.length, 1);
  assert.equal(composed[0].composedRoutePath, "/api/users/:userId");
  assert.equal(composed[0].mountChain.length, 2);
  assert.equal(composed[0].mountChain[0].id, "mount#app_api");
  assert.equal(composed[0].mountChain[1].id, "mount#api_user");
});

// ============================================================================
// 10. MULTIPLE PREFIXES FOR ONE ROUTER
// ============================================================================

test("HttpRouteResolver: 10. Multiple mounts of same router with different prefixes", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#v1",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/v1/data"`,
      staticPath: "/v1/data",
      isDynamic: false,
      isExternal: false,
    },
    {
      id: "client#v2",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/v2/data"`,
      staticPath: "/v2/data",
      isDynamic: false,
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "route#data",
      fileId: "file_data_router_js",
      receiver: "dataRouter",
      httpMethod: "GET",
      routePath: "/data",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const backendMounts = [
    {
      id: "mount#v1",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/v1",
      importedFileId: "file_data_router_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
    {
      id: "mount#v2",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/v2",
      importedFileId: "file_data_router_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts });
  assert.equal(res.summary.confirmedExact, 2);
  assert.equal(res.resolutions[0].composedRoutePath, "/v1/data");
  assert.equal(res.resolutions[1].composedRoutePath, "/v2/data");
});

// ============================================================================
// 11. ROUTER.ALL() WILDCARD BEHAVIOR
// ============================================================================

test("HttpRouteResolver: 11. router.all() wildcard matches all supported HTTP methods", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    { id: "req#get", fileId: "file_c", method: "GET", staticPath: "/proxy/service", isDynamic: false, isExternal: false },
    { id: "req#post", fileId: "file_c", method: "POST", staticPath: "/proxy/service", isDynamic: false, isExternal: false },
    { id: "req#delete", fileId: "file_c", method: "DELETE", staticPath: "/proxy/service", isDynamic: false, isExternal: false },
  ];

  const backendRoutes = [
    {
      id: "route#proxy_all",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "ALL",
      routePath: "/proxy/service",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.confirmedExact, 3);
  res.resolutions.forEach((r) => {
    assert.equal(r.classification, "confirmed_exact");
    assert.equal(r.backendRouteFactId, "route#proxy_all");
    assert.equal(r.resolutionRule, "router_all_wildcard_exact");
  });
});

// ============================================================================
// 12. MULTIPLE MATCHING ROUTES PRODUCING AMBIGUITY
// ============================================================================

test("HttpRouteResolver: 12. Multiple matching routes producing ambiguity", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#ambiguous",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/api/users/123"`,
      staticPath: "/api/users/123",
      isDynamic: false,
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "route#user_id",
      fileId: "file_v1_js",
      receiver: "router",
      httpMethod: "GET",
      routePath: "/api/users/:id",
      isDynamic: false,
      pathClassification: "parameterized",
    },
    {
      id: "route#user_uuid",
      fileId: "file_v2_js",
      receiver: "router",
      httpMethod: "GET",
      routePath: "/api/users/:userId",
      isDynamic: false,
      pathClassification: "parameterized",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.ambiguous, 1);

  const r = res.resolutions[0];
  assert.equal(r.classification, "ambiguous");
  assert.equal(r.backendRouteFactId, null);
  assert.equal(r.candidates.length, 2);
});

// ============================================================================
// 13. NO MATCHING ROUTE PRODUCING UNRESOLVED STATUS
// ============================================================================

test("HttpRouteResolver: 13. No matching route producing unresolved status without fabricated endpoint", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#missing",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"/api/does/not/exist"`,
      staticPath: "/api/does/not/exist",
      isDynamic: false,
      isExternal: false,
    },
  ];

  const backendRoutes = [
    {
      id: "route#existing",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "GET",
      routePath: "/api/health",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.unresolved, 1);
  assert.equal(res.resolutions[0].classification, "unresolved");
  assert.equal(res.resolutions[0].backendFileId, null);
  assert.equal(res.resolutions[0].backendRouteFactId, null);
  assert.equal(res.resolutions[0].composedRoutePath, null);
});

// ============================================================================
// 14. EXTERNAL ENDPOINT EXCLUSION
// ============================================================================

test("HttpRouteResolver: 14. External endpoint exclusion (never matches internal Express routes)", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#external",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: `"https://api.github.com/users"`,
      staticPath: "/users",
      isDynamic: false,
      isExternal: true, // Absolute external URL
    },
  ];

  const backendRoutes = [
    {
      id: "route#internal_users",
      fileId: "file_app_js",
      receiver: "app",
      httpMethod: "GET",
      routePath: "/users",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  assert.equal(res.summary.external, 1);
  assert.equal(res.resolutions[0].classification, "external");
  assert.equal(res.resolutions[0].backendRouteFactId, null);
  assert.equal(res.resolutions[0].resolutionRule, "external_url_exclusion");
});

// ============================================================================
// 15. UNRESOLVED ROUTER IMPORTS
// ============================================================================

test("HttpRouteResolver: 15. Unresolved router imports do not produce false composed routes", () => {
  const allRoutes = [
    {
      id: "route#unmounted",
      fileId: "file_orphan_js",
      receiver: "router",
      httpMethod: "GET",
      routePath: "/orphan",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const allMounts = [
    {
      id: "mount#unresolved",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/api",
      importedFileId: null, // Unresolved import
      resolutionStatus: "unresolved",
    },
  ];

  const composed = composeBackendRoutes(allRoutes, allMounts);
  // Route exists only at its own declared root without mount prefix
  assert.equal(composed.length, 1);
  assert.equal(composed[0].composedRoutePath, "/orphan");
  assert.equal(composed[0].mountChain.length, 0);
});

// ============================================================================
// 16. DYNAMIC MOUNT PREFIX PRESERVATION
// ============================================================================

test("HttpRouteResolver: 16. Dynamic mount prefix preservation", () => {
  const allRoutes = [
    {
      id: "route#sub",
      fileId: "file_sub_js",
      receiver: "router",
      httpMethod: "GET",
      routePath: "/profile",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const allMounts = [
    {
      id: "mount#dyn",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: null,
      isPrefixDynamic: true,
      importedFileId: "file_sub_js",
      resolutionStatus: "dynamic_prefix",
    },
  ];

  const composed = composeBackendRoutes(allRoutes, allMounts);
  assert.equal(composed.length, 1);
  assert.equal(composed[0].composedRoutePath, null);
  assert.equal(composed[0].isDynamic, true);
  assert.equal(composed[0].hasDynamicPrefix, true);
});

// ============================================================================
// 17. CIRCULAR ROUTER MOUNT PROTECTION
// ============================================================================

test("HttpRouteResolver: 17. Circular router mount protection prevents infinite recursion", () => {
  const allRoutes = [
    {
      id: "route#a",
      fileId: "file_a_js",
      receiver: "routerA",
      httpMethod: "GET",
      routePath: "/ping",
      isDynamic: false,
      pathClassification: "static",
    },
  ];

  const allMounts = [
    {
      id: "mount#a_b",
      fileId: "file_a_js",
      receiver: "routerA",
      mountPrefix: "/b",
      importedFileId: "file_b_js",
      isLocalRouter: false,
    },
    {
      id: "mount#b_a",
      fileId: "file_b_js",
      receiver: "routerB",
      mountPrefix: "/a",
      importedFileId: "file_a_js",
      isLocalRouter: false,
    },
  ];

  // Must not throw RangeError: Maximum call stack size exceeded
  assert.doesNotThrow(() => {
    const composed = composeBackendRoutes(allRoutes, allMounts);
    assert.ok(Array.isArray(composed));
  });
});

// ============================================================================
// 18. UNSUPPORTED FRONTEND EXPRESSIONS
// ============================================================================

test("HttpRouteResolver: 18. Unsupported frontend expressions classified as unsupported", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#unsupported",
      fileId: "file_client_js",
      method: "GET",
      rawUrl: "getApiEndpoint()",
      staticPath: null,
      template: null,
      isDynamic: true,
      dynamicParts: ["getApiEndpoint()"],
      isExternal: false,
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes: [], backendMounts: [] });
  assert.equal(res.summary.unsupported, 1);
  assert.equal(res.resolutions[0].classification, "unsupported");
  assert.equal(res.resolutions[0].backendRouteFactId, null);
});

// ============================================================================
// 19. EVIDENCE AND SOURCE-LOCATION RETENTION
// ============================================================================

test("HttpRouteResolver: 19. Complete AST evidence and source-location retention", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    {
      id: "client#http_loc",
      fileId: "file_client_js",
      method: "POST",
      rawUrl: `"/api/auth/token"`,
      staticPath: "/api/auth/token",
      isDynamic: false,
      isExternal: false,
      location: { start: { line: 15, column: 4 }, end: { line: 15, column: 40 } },
    },
  ];

  const backendRoutes = [
    {
      id: "backend#route_loc",
      fileId: "file_auth_js",
      receiver: "router",
      httpMethod: "POST",
      routePath: "/token",
      isDynamic: false,
      pathClassification: "static",
      location: { start: { line: 22, column: 0 }, end: { line: 22, column: 55 } },
    },
  ];

  const backendMounts = [
    {
      id: "mount#auth_prefix",
      fileId: "file_app_js",
      receiver: "app",
      mountPrefix: "/api/auth",
      importedFileId: "file_auth_js",
      isLocalRouter: false,
      resolutionStatus: "resolved",
    },
  ];

  const res = resolver.resolve({ clientRequests, backendRoutes, backendMounts });
  const r = res.resolutions[0];

  assert.equal(r.clientFileId, "file_client_js");
  assert.equal(r.clientFactId, "client#http_loc");
  assert.equal(r.backendFileId, "file_auth_js");
  assert.equal(r.backendRouteFactId, "backend#route_loc");
  assert.equal(r.httpMethod, "POST");
  assert.equal(r.rawClientEndpoint, `"/api/auth/token"`);
  assert.equal(r.normalizedClientPattern, "/api/auth/token");
  assert.equal(r.originalRoutePath, "/token");
  assert.equal(r.composedRoutePath, "/api/auth/token");
  assert.equal(r.classification, "confirmed_exact");
  assert.equal(r.mountChain.length, 1);
  assert.equal(r.mountChain[0].id, "mount#auth_prefix");
  assert.deepEqual(r.clientLocation, { start: { line: 15, column: 4 }, end: { line: 15, column: 40 } });
  assert.deepEqual(r.backendLocation, { start: { line: 22, column: 0 }, end: { line: 22, column: 55 } });
  assert.equal(r.resolverVersion, "1.0.0");
  assert.equal(r.resolutionRule, "exact_literal_match");
});

// ============================================================================
// 20. DETERMINISTIC RESOLVER OUTPUT
// ============================================================================

test("HttpRouteResolver: 20. Deterministic resolver output ordering across multiple calls", () => {
  const resolver = new HttpRouteResolver();

  const clientRequests = [
    { id: "c#2", fileId: "file_z_js", index: 1, method: "GET", staticPath: "/b", isDynamic: false, isExternal: false },
    { id: "c#1", fileId: "file_a_js", index: 0, method: "GET", staticPath: "/a", isDynamic: false, isExternal: false },
  ];

  const backendRoutes = [
    { id: "r#b", fileId: "file_app_js", receiver: "app", httpMethod: "GET", routePath: "/b", isDynamic: false, pathClassification: "static" },
    { id: "r#a", fileId: "file_app_js", receiver: "app", httpMethod: "GET", routePath: "/a", isDynamic: false, pathClassification: "static" },
  ];

  const run1 = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });
  const run2 = resolver.resolve({ clientRequests, backendRoutes, backendMounts: [] });

  assert.deepEqual(run1, run2);
  assert.equal(run1.resolutions[0].clientFileId, "file_a_js");
  assert.equal(run1.resolutions[1].clientFileId, "file_z_js");
});

// ============================================================================
// 21. STAGE 1 AND STAGE 2 INTEGRATION COMPATIBILITY
// ============================================================================

test("HttpRouteResolver: 21. Full end-to-end integration with Stage 1 and Stage 2 adapters", async () => {
  const adapter = new JavaScriptAdapter();

  const frontendCode = `
    export async function fetchUsers() {
      return fetch("/api/v1/users");
    }
    export async function fetchUserById(id) {
      return fetch(\`/api/v1/users/\${id}\`);
    }
  `;

  const backendCode = `
    const express = require("express");
    const app = express();
    const router = express.Router();

    router.get("/users", listUsers);
    router.get("/users/:id", getUser);

    app.use("/api/v1", router);
  `;

  const frontendFile = {
    path: "src/frontend/api.js",
    content: frontendCode,
    repository: MOCK_REPO,
  };

  const backendFile = {
    path: "src/backend/server.js",
    content: backendCode,
    repository: MOCK_REPO,
  };

  const frontendIr = await adapter.parseFile(frontendFile);
  const backendIr = await adapter.parseFile(backendFile);

  // FileIR contract preserved
  assert.equal(validateFileIR(frontendIr).isValid, true);
  assert.equal(validateFileIR(backendIr).isValid, true);

  // Feed extracted facts from Stage 1 and Stage 2 into HttpRouteResolver
  const resolver = new HttpRouteResolver();
  const res = resolver.resolve({
    clientRequests: frontendIr.httpRequests,
    backendRoutes: backendIr.expressRoutes,
    backendMounts: backendIr.expressMounts,
  });

  assert.equal(res.summary.totalRequests, 2);
  assert.equal(res.summary.confirmedExact, 1);
  assert.equal(res.summary.patternCompatible, 1);

  // Exact match
  assert.equal(res.resolutions[0].classification, "confirmed_exact");
  assert.equal(res.resolutions[0].composedRoutePath, "/api/v1/users");

  // Pattern compatible match
  assert.equal(res.resolutions[1].classification, "pattern_compatible");
  assert.equal(res.resolutions[1].composedRoutePath, "/api/v1/users/:id");
});
