const test = require("node:test");
const assert = require("node:assert/strict");

const { createSourceAST } = require("../services/parser/adapters/javascript/parserFactory");
const { extractDeclarations } = require("../services/parser/adapters/javascript/declarationExtractor");
const { extractHttpRequests } = require("../services/parser/adapters/javascript/httpRequestExtractor");
const { JavaScriptAdapter } = require("../services/parser/adapters/javascript/JavaScriptAdapter");
const { TypeScriptAdapter } = require("../services/parser/adapters/javascript/TypeScriptAdapter");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "google",
  name: "cartograph",
  fullName: "google/cartograph",
  commitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
};

// ============================================================================
// 1. FETCH EXTRACTION
// ============================================================================

test("httpRequestExtractor: fetch(url) extracts GET method and static path", () => {
  const code = `
    async function loadUsers() {
      const res = await fetch("/api/users");
      return res.json();
    }
  `;
  const fileId = "file_frontend_users_js";
  const { sourceFile } = createSourceAST("src/users.js", code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const requests = extractHttpRequests(sourceFile, fileId, symbols);

  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.id, `${fileId}#http_0`);
  assert.equal(req.fileId, fileId);
  assert.equal(req.clientType, "fetch");
  assert.equal(req.clientMethod, "fetch");
  assert.equal(req.method, "GET");
  assert.equal(req.isMethodDynamic, false);
  assert.equal(req.rawMethod, null);
  assert.equal(req.staticPath, "/api/users");
  assert.equal(req.isDynamic, false);
  assert.equal(req.isExternal, false);
  assert.equal(req.resolutionStatus, "extracted");

  // Enclosing symbol check
  const fnSym = symbols.find((s) => s.name === "loadUsers");
  assert.ok(fnSym);
  assert.equal(req.enclosingSymbolId, fnSym.id);
});

test("httpRequestExtractor: fetch with explicit method option normalizes to uppercase", () => {
  const code = `
    fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" } });
    fetch("/api/auth/logout", { method: "delete" });
    fetch("/api/items/update", { method: "PUT" });
    fetch("/api/items/patch", { method: "patch" });
  `;
  const fileId = "file_auth_js";
  const { sourceFile } = createSourceAST("src/auth.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 4);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].staticPath, "/api/auth/login");
  assert.equal(requests[1].method, "DELETE");
  assert.equal(requests[1].staticPath, "/api/auth/logout");
  assert.equal(requests[2].method, "PUT");
  assert.equal(requests[2].staticPath, "/api/items/update");
  assert.equal(requests[3].method, "PATCH");
  assert.equal(requests[3].staticPath, "/api/items/patch");
});

test("httpRequestExtractor: fetch with dynamic method handles DYNAMIC classification", () => {
  const code = `
    const customMethod = getMethod();
    fetch("/api/dynamic", { method: customMethod });
  `;
  const fileId = "file_dyn_js";
  const { sourceFile } = createSourceAST("src/dyn.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "DYNAMIC");
  assert.equal(requests[0].isMethodDynamic, true);
  assert.equal(requests[0].rawMethod, "customMethod");
});

// ============================================================================
// 2. AXIOS EXTRACTION
// ============================================================================

test("httpRequestExtractor: axios HTTP verb methods (get, post, put, patch, delete, head, options)", () => {
  const code = `
    axios.get("/api/products");
    axios.post("/api/products", { title: "Laptop" });
    axios.put("/api/products/123", { title: "Laptop Pro" });
    axios.patch("/api/products/123", { price: 999 });
    axios.delete("/api/products/123");
    axios.head("/api/health");
    axios.options("/api/health");
  `;
  const fileId = "file_products_ts";
  const { sourceFile } = createSourceAST("src/products.ts", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 7);

  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  requests.forEach((req, idx) => {
    assert.equal(req.clientType, "axios");
    assert.equal(req.method, methods[idx]);
    assert.equal(req.isMethodDynamic, false);
    assert.ok(req.staticPath.startsWith("/api/"));
  });
});

test("httpRequestExtractor: axios configuration object form axios({ method, url })", () => {
  const code = `
    axios({ method: "POST", url: "/api/session/create" });
    axios({ url: "/api/status" }); // defaults to GET
    axios("/api/profile", { method: "PUT" }); // axios(url, config)
    axios.request({ url: "/api/request-custom", method: "DELETE" });
  `;
  const fileId = "file_axios_config_js";
  const { sourceFile } = createSourceAST("src/api.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 4);

  assert.equal(requests[0].clientType, "axios");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].staticPath, "/api/session/create");

  assert.equal(requests[1].clientType, "axios");
  assert.equal(requests[1].method, "GET");
  assert.equal(requests[1].staticPath, "/api/status");

  assert.equal(requests[2].clientType, "axios");
  assert.equal(requests[2].method, "PUT");
  assert.equal(requests[2].staticPath, "/api/profile");

  assert.equal(requests[3].clientType, "axios");
  assert.equal(requests[3].clientMethod, "axios.request");
  assert.equal(requests[3].method, "DELETE");
  assert.equal(requests[3].staticPath, "/api/request-custom");
});

// ============================================================================
// 3. GLOBAL CALLERS (window.fetch, globalThis.fetch, window.axios)
// ============================================================================

test("httpRequestExtractor: window.fetch, globalThis.fetch, window.axios", () => {
  const code = `
    window.fetch("/api/window-fetch");
    globalThis.fetch("/api/global-fetch");
    window.axios.get("/api/window-axios");
  `;
  const fileId = "file_globals_js";
  const { sourceFile } = createSourceAST("src/globals.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 3);
  assert.equal(requests[0].clientType, "fetch");
  assert.equal(requests[0].staticPath, "/api/window-fetch");

  assert.equal(requests[1].clientType, "fetch");
  assert.equal(requests[1].staticPath, "/api/global-fetch");

  assert.equal(requests[2].clientType, "axios");
  assert.equal(requests[2].staticPath, "/api/window-axios");
});

// ============================================================================
// 4. URL PATTERN RESOLUTION (Static, Templates, Concat, External)
// ============================================================================

test("httpRequestExtractor: static template literals without substitution", () => {
  const code = "fetch(`/api/static/check`);";
  const fileId = "file_static_template_js";
  const { sourceFile } = createSourceAST("src/test.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].isDynamic, false);
  assert.equal(requests[0].staticPath, "/api/static/check");
});

test("httpRequestExtractor: dynamic template literals with parameter patterns", () => {
  const code = `
    fetch(\`/api/users/\${userId}\`);
    fetch(\`/api/orgs/\${orgId}/teams/\${teamId}/members\`);
  `;
  const fileId = "file_template_js";
  const { sourceFile } = createSourceAST("src/template.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 2);

  // Mandatory Rule 2B: Dynamic values cannot be statically proven as exact path
  assert.equal(requests[0].isDynamic, true);
  assert.equal(requests[0].staticPath, null);
  assert.equal(requests[0].template, "/api/users/:userId");
  assert.deepEqual(requests[0].dynamicParts, ["userId"]);

  assert.equal(requests[1].isDynamic, true);
  assert.equal(requests[1].staticPath, null);
  assert.equal(requests[1].template, "/api/orgs/:orgId/teams/:teamId/members");
  assert.deepEqual(requests[1].dynamicParts, ["orgId", "teamId"]);
});

test("httpRequestExtractor: dynamic template literals with base URL variables", () => {
  const code = "fetch(`${API_BASE_URL}/api/v2/items/${id}`);";
  const fileId = "file_baseurl_js";
  const { sourceFile } = createSourceAST("src/baseurl.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].isDynamic, true);
  assert.equal(requests[0].staticPath, null);
  assert.equal(requests[0].template, ":API_BASE_URL/api/v2/items/:id");
  assert.deepEqual(requests[0].dynamicParts, ["API_BASE_URL", "id"]);
  assert.equal(requests[0].isExternal, true);
});

test("httpRequestExtractor: binary string concatenation (+)", () => {
  const code = `
    fetch("/api/documents/" + docId);
    fetch("/api/" + "v1/" + "reports"); // All-static concatenation
  `;
  const fileId = "file_concat_js";
  const { sourceFile } = createSourceAST("src/concat.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 2);

  // Dynamic concatenation
  assert.equal(requests[0].isDynamic, true);
  assert.equal(requests[0].staticPath, null);
  assert.equal(requests[0].template, "/api/documents/:docId");
  assert.deepEqual(requests[0].dynamicParts, ["docId"]);

  // All-static concatenation
  assert.equal(requests[1].isDynamic, false);
  assert.equal(requests[1].staticPath, "/api/v1/reports");
});

test("httpRequestExtractor: complex dynamic URL expression (call expression)", () => {
  const code = "fetch(buildEndpoint('/users'));";
  const fileId = "file_call_url_js";
  const { sourceFile } = createSourceAST("src/call.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].isDynamic, true);
  assert.equal(requests[0].staticPath, null);
  assert.equal(requests[0].template, null);
  assert.deepEqual(requests[0].dynamicParts, ["buildEndpoint('/users')"]);
});

test("httpRequestExtractor: external full URLs and query strings", () => {
  const code = `
    fetch("https://api.github.com/repos/google/cartograph/issues");
    fetch("/api/search?q=ast&page=1#results");
  `;
  const fileId = "file_ext_query_js";
  const { sourceFile } = createSourceAST("src/ext.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 2);

  // External URL
  assert.equal(requests[0].isExternal, true);
  assert.equal(requests[0].staticPath, "/repos/google/cartograph/issues");

  // Query and fragment stripped for staticPath
  assert.equal(requests[1].isExternal, false);
  assert.equal(requests[1].staticPath, "/api/search");
  assert.equal(requests[1].rawUrl, `"/api/search?q=ast&page=1#results"`);
});

// ============================================================================
// 5. NEGATIVE AND NON-HTTP CASES
// ============================================================================

test("httpRequestExtractor: ignores non-HTTP function calls and route definitions", () => {
  const code = `
    console.log("fetch");
    router.get("/api/users", (req, res) => res.json([]));
    app.post("/api/login", authHandler);
    customFetcher("/api/data");
    const fetch = "not a call";
  `;
  const fileId = "file_negative_js";
  const { sourceFile } = createSourceAST("src/negative.js", code);
  const requests = extractHttpRequests(sourceFile, fileId);

  assert.equal(requests.length, 0);
});

// ============================================================================
// 6. ADAPTER INTEGRATION AND FILEIR V1.0.0 COMPLIANCE
// ============================================================================

test("JavaScriptAdapter: parseFile attaches httpRequests non-enumerably and passes validateFileIR", async () => {
  const adapter = new JavaScriptAdapter();
  const fileContent = `
    export async function loginUser(credentials) {
      return fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
    }

    export function getProfile(userId) {
      return axios.get(\`/api/v1/users/\${userId}\`);
    }
  `;

  const file = {
    path: "src/api/authClient.js",
    content: fileContent,
    repository: MOCK_REPO,
  };

  const fileIr = await adapter.parseFile(file);

  // 1. FileIR v1.0.0 Schema validation passes with 0 errors
  const validation = validateFileIR(fileIr);
  assert.equal(validation.isValid, true);
  assert.deepEqual(validation.errors, []);

  // 2. Non-enumerable httpRequests property exists in-memory
  assert.ok(fileIr.httpRequests);
  assert.equal(fileIr.httpRequests.length, 2);

  // First request: fetch POST
  const req1 = fileIr.httpRequests[0];
  assert.equal(req1.clientType, "fetch");
  assert.equal(req1.method, "POST");
  assert.equal(req1.staticPath, "/api/v1/auth/login");

  // Second request: axios GET dynamic
  const req2 = fileIr.httpRequests[1];
  assert.equal(req2.clientType, "axios");
  assert.equal(req2.method, "GET");
  assert.equal(req2.isDynamic, true);
  assert.equal(req2.template, "/api/v1/users/:userId");

  // 3. Serialized JSON does NOT leak httpRequests (preserves pristine v1.0.0 contract)
  const serialized = JSON.stringify(fileIr);
  const parsedBack = JSON.parse(serialized);
  assert.equal(parsedBack.httpRequests, undefined);

  // 4. callSites remains strictly conforming to v1.0.0
  assert.ok(Array.isArray(fileIr.callSites));
  assert.equal(fileIr.callSites.length >= 2, true);
  for (const cs of fileIr.callSites) {
    assert.equal(cs.resolution.status, "not_attempted");
    assert.equal(cs.isHttp, undefined);
  }
});

test("TypeScriptAdapter: parseFile extracts HTTP requests in TypeScript code", async () => {
  const adapter = new TypeScriptAdapter();
  const fileContent = `
    interface UserCredentials {
      user: string;
      pass: string;
    }

    export class ApiClient {
      async authenticate(creds: UserCredentials): Promise<any> {
        const response = await fetch("/api/auth/token", { method: "POST" });
        return response.json();
      }

      async fetchUser(id: string): Promise<any> {
        const { data } = await axios.get(\`/api/users/\${id}\`);
        return data;
      }
    }
  `;

  const file = {
    path: "src/api/ApiClient.ts",
    content: fileContent,
    repository: MOCK_REPO,
  };

  const fileIr = await adapter.parseFile(file);

  const validation = validateFileIR(fileIr);
  assert.equal(validation.isValid, true);
  assert.deepEqual(validation.errors, []);

  assert.ok(fileIr.httpRequests);
  assert.equal(fileIr.httpRequests.length, 2);

  // Class method enclosing symbol linkage
  const authReq = fileIr.httpRequests[0];
  const authSym = fileIr.symbols.find((s) => s.name === "authenticate");
  assert.ok(authSym);
  assert.equal(authReq.enclosingSymbolId, authSym.id);
});
