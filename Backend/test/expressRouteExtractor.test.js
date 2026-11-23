const test = require("node:test");
const assert = require("node:assert/strict");

const { createSourceAST } = require("../services/parser/adapters/javascript/parserFactory");
const { extractDeclarations } = require("../services/parser/adapters/javascript/declarationExtractor");
const {
  extractExpressRoutes,
  extractExpressMounts,
  extractExpressFacts,
  getExpressRouteFacts,
  expressFactStore,
} = require("../services/parser/adapters/javascript/expressRouteExtractor");
const { JavaScriptAdapter } = require("../services/parser/adapters/javascript/JavaScriptAdapter");
const { TypeScriptAdapter } = require("../services/parser/adapters/javascript/TypeScriptAdapter");
const { JavaScriptModuleResolver } = require("../services/parser/resolvers/javascript/JavaScriptModuleResolver");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "google",
  name: "cartograph",
  fullName: "google/cartograph",
  commitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
};

// ============================================================================
// 1. EXPRESS GET AND POST DECLARATIONS
// ============================================================================

test("expressRouteExtractor: 1. Express GET and POST declarations on router", () => {
  const code = `
    const express = require("express");
    const router = express.Router();

    router.get("/users", listUsers);
    router.post("/users", createUser);
  `;
  const fileId = "file_user_routes_js";
  const { sourceFile } = createSourceAST("src/routes/userRoutes.js", code);
  const routes = extractExpressRoutes(sourceFile, fileId);

  assert.equal(routes.length, 2);

  assert.equal(routes[0].httpMethod, "GET");
  assert.equal(routes[0].routePath, "/users");
  assert.equal(routes[0].receiver, "router");
  assert.equal(routes[0].receiverEvidence, "express_router_init");
  assert.equal(routes[0].isDynamic, false);
  assert.equal(routes[0].handlers.length, 1);
  assert.equal(routes[0].handlers[0].name, "listUsers");
  assert.equal(routes[0].handlers[0].isMiddleware, false);

  assert.equal(routes[1].httpMethod, "POST");
  assert.equal(routes[1].routePath, "/users");
  assert.equal(routes[1].handlers[0].name, "createUser");
});

// ============================================================================
// 2. PUT, PATCH, DELETE, HEAD AND OPTIONS
// ============================================================================

test("expressRouteExtractor: 2. PUT, PATCH, DELETE, HEAD and OPTIONS route methods", () => {
  const code = `
    const express = require("express");
    const routes = express.Router();

    routes.put("/items/:id", updateItem);
    routes.patch("/items/:id", patchItem);
    routes.delete("/items/:id", deleteItem);
    routes.head("/items/:id", headStatus);
    routes.options("/items/:id", handleOptions);
  `;
  const fileId = "file_items_routes_js";
  const { sourceFile } = createSourceAST("src/routes/itemsRoutes.js", code);
  const routes = extractExpressRoutes(sourceFile, fileId);

  assert.equal(routes.length, 5);

  const expectedMethods = ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  routes.forEach((r, idx) => {
    assert.equal(r.httpMethod, expectedMethods[idx]);
    assert.equal(r.routePath, "/items/:id");
    assert.equal(r.receiver, "routes");
    assert.equal(r.pathClassification, "parameterized");
    assert.deepEqual(r.dynamicParts, ["id"]);
  });
});

// ============================================================================
// 3. ROUTER.ALL() SEMANTICS
// ============================================================================

test("expressRouteExtractor: 3. router.all() captures ALL HTTP method semantics", () => {
  const code = `
    const express = require("express");
    const router = express.Router();

    router.all("/proxy/*", proxyHandler);
  `;
  const fileId = "file_proxy_routes_js";
  const { sourceFile } = createSourceAST("src/routes/proxy.js", code);
  const routes = extractExpressRoutes(sourceFile, fileId);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].httpMethod, "ALL");
  assert.equal(routes[0].routePath, "/proxy/*");
  assert.equal(routes[0].handlers[0].name, "proxyHandler");
});

// ============================================================================
// 4. APP.METHOD() DECLARATIONS
// ============================================================================

test("expressRouteExtractor: 4. app.METHOD() declarations on express application instance", () => {
  const code = `
    const express = require("express");
    const app = express();

    app.get("/api/health", (req, res) => res.json({ ok: true }));
    app.post("/api/webhooks/clerk", clerkLimiter, handleWebhook);
  `;
  const fileId = "file_app_js";
  const { sourceFile } = createSourceAST("src/app.js", code);
  const routes = extractExpressRoutes(sourceFile, fileId);

  assert.equal(routes.length, 2);

  assert.equal(routes[0].receiver, "app");
  assert.equal(routes[0].receiverEvidence, "express_app_init");
  assert.equal(routes[0].httpMethod, "GET");
  assert.equal(routes[0].routePath, "/api/health");
  assert.equal(routes[0].handlers[0].name, "anonymous");

  assert.equal(routes[1].receiver, "app");
  assert.equal(routes[1].httpMethod, "POST");
  assert.equal(routes[1].routePath, "/api/webhooks/clerk");
  assert.equal(routes[1].handlers.length, 2);
  assert.equal(routes[1].handlers[0].name, "clerkLimiter");
  assert.equal(routes[1].handlers[0].isMiddleware, true);
  assert.equal(routes[1].handlers[1].name, "handleWebhook");
  assert.equal(routes[1].handlers[1].isMiddleware, false);
});

// ============================================================================
// 5. STATIC AND DYNAMIC ROUTE PATHS
// ============================================================================

test("expressRouteExtractor: 5. Static, parameterized, and dynamic route paths", () => {
  const code = `
    const express = require("express");
    const router = express.Router();

    router.get("/static/docs", docHandler);
    router.get("/users/:userId/orders/:orderId", orderHandler);
    router.get(\`/api/v1/\${dynamicPrefix}/data\`, dynamicHandler);
    router.get("/api/" + "v1/" + "reports", reportsHandler); // all-static concat
  `;
  const fileId = "file_paths_js";
  const { sourceFile } = createSourceAST("src/paths.js", code);
  const routes = extractExpressRoutes(sourceFile, fileId);

  assert.equal(routes.length, 4);

  // Static
  assert.equal(routes[0].routePath, "/static/docs");
  assert.equal(routes[0].isDynamic, false);
  assert.equal(routes[0].pathClassification, "static");

  // Parameterized
  assert.equal(routes[1].routePath, "/users/:userId/orders/:orderId");
  assert.equal(routes[1].isDynamic, false);
  assert.equal(routes[1].pathClassification, "parameterized");
  assert.deepEqual(routes[1].dynamicParts, ["userId", "orderId"]);

  // Dynamic template expression
  assert.equal(routes[2].routePath, null);
  assert.equal(routes[2].isDynamic, true);
  assert.equal(routes[2].pathClassification, "dynamic_expression");
  assert.deepEqual(routes[2].dynamicParts, ["dynamicPrefix"]);

  // All-static concatenation
  assert.equal(routes[3].routePath, "/api/v1/reports");
  assert.equal(routes[3].isDynamic, false);
  assert.equal(routes[3].pathClassification, "static");
});

// ============================================================================
// 6. MULTIPLE HANDLERS AND HANDLER SYMBOL REFERENCES
// ============================================================================

test("expressRouteExtractor: 6. Multiple handlers, wrappers (asyncHandler), and symbol resolution", () => {
  const code = `
    const express = require("express");
    const router = express.Router();

    function authenticate(req, res, next) { next(); }
    function validate(req, res, next) { next(); }
    function processGraph(req, res) { res.send(); }

    router.post("/graph/build", authenticate, validate, asyncHandler(processGraph));
  `;
  const fileId = "file_handlers_js";
  const { sourceFile } = createSourceAST("src/handlers.js", code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const routes = extractExpressRoutes(sourceFile, fileId, { symbols });

  assert.equal(routes.length, 1);
  const route = routes[0];
  assert.equal(route.handlers.length, 3);

  // 1. authenticate (middleware)
  assert.equal(route.handlers[0].name, "authenticate");
  assert.equal(route.handlers[0].isMiddleware, true);
  const authSym = symbols.find((s) => s.name === "authenticate");
  assert.ok(authSym);
  assert.equal(route.handlers[0].symbolId, authSym.id);

  // 2. validate (middleware)
  assert.equal(route.handlers[1].name, "validate");
  assert.equal(route.handlers[1].isMiddleware, true);
  const valSym = symbols.find((s) => s.name === "validate");
  assert.ok(valSym);
  assert.equal(route.handlers[1].symbolId, valSym.id);

  // 3. processGraph inside asyncHandler wrapper (terminating handler)
  assert.equal(route.handlers[2].name, "processGraph");
  assert.equal(route.handlers[2].isMiddleware, false);
  const procSym = symbols.find((s) => s.name === "processGraph");
  assert.ok(procSym);
  assert.equal(route.handlers[2].symbolId, procSym.id);
});

// ============================================================================
// 7. APP.USE('/API', IMPORTEDROUTER)
// ============================================================================

test("expressRouteExtractor: 7. app.use('/api', importedRouter) router mounting extraction", () => {
  const code = `
    const express = require("express");
    const authRoutes = require("./routes/authRoutes");
    const app = express();

    app.use("/api", authRoutes);
  `;
  const fileId = "file_app_mount_js";
  const { sourceFile } = createSourceAST("src/app.js", code);
  const mounts = extractExpressMounts(sourceFile, fileId);

  assert.equal(mounts.length, 1);
  const m = mounts[0];
  assert.equal(m.id, `${fileId}#mount_0`);
  assert.equal(m.receiver, "app");
  assert.equal(m.mountPrefix, "/api");
  assert.equal(m.isPrefixDynamic, false);
  assert.equal(m.routerIdentifier, "authRoutes");
  assert.equal(m.importedModuleSpecifier, "./routes/authRoutes");
  assert.equal(m.isLocalRouter, false);
  assert.equal(m.resolutionStatus, "resolved");
});

// ============================================================================
// 8. MULTIPLE ROUTER MOUNTS WITH DIFFERENT PREFIXES
// ============================================================================

test("expressRouteExtractor: 8. Multiple router mounts with distinct prefixes and array mounting", () => {
  const code = `
    const express = require("express");
    const userRoutes = require("./routes/userRoutes");
    const orgRoutes = require("./routes/orgRoutes");
    const adminRoutes = require("./routes/adminRoutes");
    const app = express();

    app.use("/api/v1/users", userRoutes);
    app.use("/api/v1/orgs", orgRoutes);
    app.use("/admin", adminRoutes);
    app.use("/api/v2", [userRoutes, orgRoutes]);
  `;
  const fileId = "file_multi_mount_js";
  const { sourceFile } = createSourceAST("src/app.js", code);
  const mounts = extractExpressMounts(sourceFile, fileId);

  assert.equal(mounts.length, 5);

  assert.equal(mounts[0].mountPrefix, "/api/v1/users");
  assert.equal(mounts[0].routerIdentifier, "userRoutes");

  assert.equal(mounts[1].mountPrefix, "/api/v1/orgs");
  assert.equal(mounts[1].routerIdentifier, "orgRoutes");

  assert.equal(mounts[2].mountPrefix, "/admin");
  assert.equal(mounts[2].routerIdentifier, "adminRoutes");

  // Array elements extracted individually
  assert.equal(mounts[3].mountPrefix, "/api/v2");
  assert.equal(mounts[3].routerIdentifier, "userRoutes");
  assert.equal(mounts[4].mountPrefix, "/api/v2");
  assert.equal(mounts[4].routerIdentifier, "orgRoutes");
});

// ============================================================================
// 9. NESTED ROUTER MOUNTS
// ============================================================================

test("expressRouteExtractor: 9. Nested router mounts in same module and hierarchical routers", () => {
  const code = `
    const express = require("express");
    const app = express();
    const apiRouter = express.Router();
    const subRouter = express.Router();

    subRouter.get("/profile", getProfile);
    apiRouter.use("/users", subRouter);
    app.use("/api", apiRouter);
  `;
  const fileId = "file_nested_js";
  const { sourceFile } = createSourceAST("src/nested.js", code);
  const facts = extractExpressFacts(sourceFile, fileId);

  assert.equal(facts.routes.length, 1);
  assert.equal(facts.routes[0].routePath, "/profile");
  assert.equal(facts.routes[0].receiver, "subRouter");

  assert.equal(facts.mounts.length, 2);

  // apiRouter.use("/users", subRouter)
  assert.equal(facts.mounts[0].receiver, "apiRouter");
  assert.equal(facts.mounts[0].mountPrefix, "/users");
  assert.equal(facts.mounts[0].routerIdentifier, "subRouter");
  assert.equal(facts.mounts[0].isLocalRouter, true);
  assert.equal(facts.mounts[0].importedFileId, fileId);

  // app.use("/api", apiRouter)
  assert.equal(facts.mounts[1].receiver, "app");
  assert.equal(facts.mounts[1].mountPrefix, "/api");
  assert.equal(facts.mounts[1].routerIdentifier, "apiRouter");
  assert.equal(facts.mounts[1].isLocalRouter, true);
});

// ============================================================================
// 10. CORRECT IMPORTED-MODULE IDENTITY
// ============================================================================

test("expressRouteExtractor: 10. Correct imported-module identity using JavaScriptModuleResolver", () => {
  const code = `
    const express = require("express");
    const graphRoutes = require("./routes/graphRoutes");
    const app = express();

    app.use("/api", graphRoutes);
  `;
  const fileId = "file_app_resolver_js";
  const filePath = "src/app.js";
  const { sourceFile } = createSourceAST(filePath, code);

  const manifest = ["src/app.js", "src/routes/graphRoutes.js"];
  const resolver = new JavaScriptModuleResolver({ manifest });

  const mounts = extractExpressMounts(sourceFile, fileId, {
    filePath,
    repository: MOCK_REPO,
    moduleResolver: resolver,
  });

  assert.equal(mounts.length, 1);
  const m = mounts[0];
  assert.equal(m.resolutionStatus, "resolved");
  assert.equal(m.importedModuleSpecifier, "./routes/graphRoutes");
  // Verified canonical file identity computed via createFileId
  assert.equal(m.importedFileId, "file_google_cartograph_src_routes_graphRoutes.js");
});

// ============================================================================
// 11. UNRESOLVED AND AMBIGUOUS ROUTER IMPORTS
// ============================================================================

test("expressRouteExtractor: 11. Unresolved and ambiguous router imports preservation", () => {
  const code = `
    const express = require("express");
    const missingRouter = require("./routes/nonExistentRoutes");
    const undeclaredRouter = getRouter();
    const app = express();

    app.use("/api/missing", missingRouter);
    app.use("/api/undeclared", undeclaredRouter);
  `;
  const fileId = "file_unresolved_js";
  const filePath = "src/app.js";
  const { sourceFile } = createSourceAST(filePath, code);

  // Manifest without nonExistentRoutes
  const manifest = ["src/app.js"];
  const resolver = new JavaScriptModuleResolver({ manifest });

  const mounts = extractExpressMounts(sourceFile, fileId, {
    filePath,
    repository: MOCK_REPO,
    moduleResolver: resolver,
  });

  // Missing router from unresolvable import
  const missingMount = mounts.find((m) => m.mountPrefix === "/api/missing");
  assert.ok(missingMount);
  assert.equal(missingMount.resolutionStatus, "unresolved");
  assert.equal(missingMount.importedFileId, null);

  // Undeclared router identifier
  const undeclaredMount = mounts.find((m) => m.mountPrefix === "/api/undeclared");
  assert.ok(undeclaredMount);
  assert.equal(undeclaredMount.resolutionStatus, "unresolved");
});

// ============================================================================
// 12. DYNAMIC MOUNT PREFIXES
// ============================================================================

test("expressRouteExtractor: 12. Dynamic mount prefixes preservation", () => {
  const code = `
    const express = require("express");
    const userRoutes = require("./routes/userRoutes");
    const app = express();

    app.use(getBasePrefix() + "/v1", userRoutes);
  `;
  const fileId = "file_dyn_prefix_js";
  const { sourceFile } = createSourceAST("src/app.js", code);
  const mounts = extractExpressMounts(sourceFile, fileId);

  assert.equal(mounts.length, 1);
  const m = mounts[0];
  assert.equal(m.mountPrefix, null);
  assert.equal(m.isPrefixDynamic, true);
  assert.equal(m.resolutionStatus, "dynamic_prefix");
});

// ============================================================================
// 13. SOURCE-LOCATION ACCURACY
// ============================================================================

test("expressRouteExtractor: 13. Source location coordinates accuracy (1-based line, 0-based column)", () => {
  const code = `
    const express = require("express");
    const router = express.Router();
    router.get("/metrics", metricsHandler);
  `;
  const fileId = "file_loc_js";
  const { sourceFile } = createSourceAST("src/metrics.js", code);
  const routes = extractExpressRoutes(sourceFile, fileId);

  assert.equal(routes.length, 1);
  const r = routes[0];
  assert.ok(r.location);
  assert.equal(r.location.start.line, 4);
  assert.ok(r.location.start.column >= 0);
  assert.ok(r.location.end.line >= 4);

  assert.ok(r.pathLocation);
  assert.equal(r.pathLocation.start.line, 4);
});

// ============================================================================
// 14. FILEIR V1.0.0 VALIDATION
// ============================================================================

test("expressRouteExtractor: 14. FileIR v1.0.0 validation and non-enumerable attachment", async () => {
  const adapter = new JavaScriptAdapter();
  const fileContent = `
    const express = require("express");
    const userRoutes = require("./routes/userRoutes");
    const app = express();

    app.get("/api/health", (req, res) => res.json({ ok: true }));
    app.use("/api", userRoutes);

    module.exports = app;
  `;

  const file = {
    path: "src/server.js",
    content: fileContent,
    repository: MOCK_REPO,
  };

  const fileIr = await adapter.parseFile(file);

  // 1. Valid FileIR v1.0.0 contract
  const validation = validateFileIR(fileIr);
  assert.equal(validation.isValid, true);
  assert.deepEqual(validation.errors, []);

  // 2. Direct in-memory access via non-enumerable properties
  assert.ok(fileIr.expressRoutes);
  assert.equal(fileIr.expressRoutes.length, 1);
  assert.equal(fileIr.expressRoutes[0].routePath, "/api/health");

  assert.ok(fileIr.expressMounts);
  assert.equal(fileIr.expressMounts.length, 1);
  assert.equal(fileIr.expressMounts[0].mountPrefix, "/api");

  // 3. Serialized JSON does not contain extra fields
  const serialized = JSON.stringify(fileIr);
  const parsedBack = JSON.parse(serialized);
  assert.equal(parsedBack.expressRoutes, undefined);
  assert.equal(parsedBack.expressMounts, undefined);

  // 4. Accessible via expressFactStore even if cloned / deserialized
  const retrievedFacts = getExpressRouteFacts(fileIr.analysis.file.fileId);
  assert.equal(retrievedFacts.routes.length, 1);
  assert.equal(retrievedFacts.mounts.length, 1);
});

// ============================================================================
// 15. STAGE 1 FRONTEND REQUEST EXTRACTION UNAFFECTED
// ============================================================================

test("expressRouteExtractor: 15. Stage 1 frontend request extraction remains unaffected", async () => {
  const adapter = new JavaScriptAdapter();
  const fullContent = `
    // Frontend API client call
    export async function fetchHealth() {
      return fetch("/api/health");
    }

    // Backend route declaration in hybrid file
    const express = require("express");
    const router = express.Router();
    router.get("/api/health", (req, res) => res.json({ status: "ok" }));
  `;

  const file = {
    path: "src/hybrid.js",
    content: fullContent,
    repository: MOCK_REPO,
  };

  const fileIr = await adapter.parseFile(file);

  // Validation
  const validation = validateFileIR(fileIr);
  assert.equal(validation.isValid, true);

  // Frontend facts from Stage 1
  assert.ok(fileIr.httpRequests);
  assert.equal(fileIr.httpRequests.length, 1);
  assert.equal(fileIr.httpRequests[0].clientType, "fetch");
  assert.equal(fileIr.httpRequests[0].method, "GET");
  assert.equal(fileIr.httpRequests[0].staticPath, "/api/health");

  // Backend route facts from Stage 2
  assert.ok(fileIr.expressRoutes);
  assert.equal(fileIr.expressRoutes.length, 1);
  assert.equal(fileIr.expressRoutes[0].httpMethod, "GET");
  assert.equal(fileIr.expressRoutes[0].routePath, "/api/health");
});
