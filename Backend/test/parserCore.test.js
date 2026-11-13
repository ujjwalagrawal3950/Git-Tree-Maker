const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}

const { AppError } = require("../lib/errors");
const {
  buildFileIR,
  createLocation,
  createFileId,
  countLines,
  createSymbol,
  createImport,
  createExport,
  createDiagnostic,
} = require("../services/parser/irBuilder");
const { validateFileIR } = require("../services/parser/irValidator");
const BaseAdapter = require("../services/parser/adapters/BaseAdapter");
const UnsupportedAdapter = require("../services/parser/adapters/UnsupportedAdapter");
const { ParserRegistry } = require("../services/parser/ParserRegistry");
const { scheduleRepositoryParse } = require("../services/parser/ParserScheduler");
const { parseRepository: parseController } = require("../controllers/repositoryController");

// ========================================================
// 1. IR BUILDER TESTS
// ========================================================
test("irBuilder: constructs normalized, schema-compliant FileIR", () => {
  const repository = {
    owner: "facebook",
    name: "react",
    fullName: "facebook/react",
    commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  };

  const file = {
    path: "packages/react/src/index.js",
    blobSha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    language: "javascript",
    category: "source",
    content: "export function useState() {}\nexport function useEffect() {}\n",
  };

  const parser = {
    adapterId: "mock-js-adapter",
    adapterVersion: "1.0.0",
    engine: "babel",
    engineVersion: "7.24.0",
    status: "complete",
    capabilities: ["symbols", "exports"],
    durationMs: 4.5,
  };

  const symbols = [
    {
      id: "packages/react/src/index.js#sym_1",
      name: "useState",
      qualifiedName: "useState",
      kind: "function",
      parentSymbolId: null,
      modifiers: ["export"],
      visibility: "public",
      isExported: true,
      location: createLocation(1, 0, 1, 30),
      nameLocation: createLocation(1, 16, 1, 24),
      signature: "function useState()",
      parameters: [],
      returnType: { text: "void", kind: "primitive", isInferred: false },
      typeParameters: [],
      documentation: null,
      languageMetadata: {},
    },
  ];

  const fileIR = buildFileIR({
    repository,
    file,
    parser,
    symbols,
  });

  assert.equal(fileIR.irVersion, "1.0.0");
  assert.equal(fileIR.analysis.repository.fullName, "facebook/react");
  assert.equal(fileIR.analysis.file.path, "packages/react/src/index.js");
  assert.equal(fileIR.stats.lines, 3);
  assert.equal(fileIR.stats.symbols, 1);

  const validation = validateFileIR(fileIR);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join(", ")}`);
});

test("irBuilder: createLocation normalizes coordinates correctly", () => {
  const loc = createLocation(1, 0, 3, 15);
  assert.equal(loc.start.line, 1);
  assert.equal(loc.start.column, 0);
  assert.equal(loc.end.line, 3);
  assert.equal(loc.end.column, 15);
});

test("irBuilder: helpers construct schema-compliant entities with deterministic IDs", () => {
  const fileId = "file_facebook_react_packages_react_src_index_js";
  const loc = createLocation(1, 0, 2, 10);

  const sym = createSymbol({
    fileId,
    index: 0,
    name: "Component",
    kind: "class",
    location: loc,
  });
  assert.equal(sym.id, `${fileId}#sym_0`);
  assert.equal(sym.name, "Component");
  assert.equal(sym.kind, "class");
  assert.deepEqual(sym.modifiers, []);

  const imp = createImport({
    fileId,
    index: 0,
    kind: "module_import",
    rawSource: "./utils",
    location: loc,
  });
  assert.equal(imp.id, `${fileId}#import_0`);
  assert.equal(imp.rawSource, "./utils");

  const exp = createExport({
    fileId,
    index: 0,
    kind: "named",
    exportedName: "Component",
    location: loc,
  });
  assert.equal(exp.id, `${fileId}#export_0`);
  assert.equal(exp.exportedName, "Component");

  const diag = createDiagnostic({
    code: "SYNTAX_ERROR",
    severity: "error",
    message: "Unexpected token",
    location: loc,
  });
  assert.equal(diag.code, "SYNTAX_ERROR");
  assert.equal(diag.severity, "error");
});

// ========================================================
// 2. IR VALIDATOR TESTS
// ========================================================
test("irValidator: detects invalid schema fields and inverted locations", () => {
  const invalidIR = {
    irVersion: "0.9.0", // Invalid version
    analysis: {
      repository: { provider: "gitlab" }, // Must be "github"
    },
    parser: { status: "unknown_status" },
    symbols: [
      {
        id: "sym_1",
        name: "test",
        kind: "invalid_kind",
        location: {
          start: { line: 5, column: 10 },
          end: { line: 3, column: 0 }, // Inverted end line
        },
      },
    ],
  };

  const validation = validateFileIR(invalidIR);
  assert.equal(validation.isValid, false);
  assert.equal(validation.errors.some((e) => e.includes("irVersion")), true);
  assert.equal(validation.errors.some((e) => e.includes("inverted") || e.includes("cannot precede")), true);
});

// ========================================================
// 3. BASE ADAPTER CONTRACT
// ========================================================
test("BaseAdapter: enforces implementation of abstract methods", async () => {
  const adapter = new BaseAdapter();
  assert.throws(() => adapter.getSupportedLanguages(), /must be implemented/);
  await assert.rejects(async () => adapter.parseFile({}), /must be implemented/);
});

// ========================================================
// 4. UNSUPPORTED ADAPTER
// ========================================================
test("UnsupportedAdapter: produces valid FileIR with status unsupported and diagnostic", async () => {
  const adapter = new UnsupportedAdapter();
  const file = {
    path: "App.swift",
    blobSha: "sha_swift_123",
    language: "swift",
    content: "import SwiftUI\nstruct ContentView: View {}\n",
    repository: {
      owner: "apple",
      name: "demo",
      fullName: "apple/demo",
      commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    },
  };

  const ir = await adapter.parseFile(file);
  assert.equal(ir.parser.status, "unsupported");
  assert.equal(ir.diagnostics.length, 1);
  assert.equal(ir.diagnostics[0].code, "PARSER_UNAVAILABLE");

  const validation = validateFileIR(ir);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join(", ")}`);
});

// ========================================================
// 5. PARSER REGISTRY
// ========================================================
test("ParserRegistry: registers language adapters and resolves correctly with fallback", () => {
  const registry = new ParserRegistry();

  class MockDartAdapter extends BaseAdapter {
    constructor() {
      super({ adapterId: "mock-dart", engine: "dart-analyzer" });
    }
    getSupportedLanguages() {
      return ["dart"];
    }
    async parseFile(f) {
      return { dart: true };
    }
  }

  const dartAdapter = new MockDartAdapter();
  registry.registerAdapter(dartAdapter);

  assert.equal(registry.hasAdapter("dart"), true);
  assert.equal(registry.hasAdapter("DART"), true); // Case-insensitive
  assert.equal(registry.getAdapter("dart"), dartAdapter);

  // Unknown language falls back to UnsupportedAdapter
  const fallback = registry.getAdapter("haskell");
  assert.equal(fallback instanceof UnsupportedAdapter, true);

  // Exposes canonical language list from languageRegistry
  const canonicalLangs = registry.getCanonicalLanguages();
  assert.equal(canonicalLangs.includes("typescript"), true);
  assert.equal(canonicalLangs.includes("python"), true);

  // Prevents accidental duplicate registration without replace: true
  assert.throws(
    () => registry.registerAdapter(dartAdapter),
    /already registered/
  );

  // Allows overwriting with replace: true
  assert.doesNotThrow(() => registry.registerAdapter(dartAdapter, { replace: true }));
});

// ========================================================
// 6. PARSER SCHEDULER (CONCURRENCY & FAULT TOLERANCE)
// ========================================================
test("ParserScheduler: schedules parsing across multiple files and aggregates metrics", async () => {
  const registry = new ParserRegistry();

  class MockPythonAdapter extends BaseAdapter {
    constructor() {
      super({ adapterId: "mock-py", engine: "tree-sitter-python" });
    }
    getSupportedLanguages() {
      return ["python"];
    }
    async parseFile(f) {
      return buildFileIR({
        repository: f.repository,
        file: f,
        parser: {
          adapterId: this.adapterId,
          engine: this.engine,
          status: "complete",
        },
        symbols: [
          {
            id: `${f.path}#sym_1`,
            name: "greet",
            kind: "function",
            location: createLocation(1, 0, 2, 0),
          },
        ],
      });
    }
  }

  registry.registerAdapter(new MockPythonAdapter());

  const repository = {
    owner: "octocat",
    name: "hello-world",
    fullName: "octocat/hello-world",
    commitSha: "c1234567890",
  };

  const files = [
    { path: "main.py", language: "python", blobSha: "s1", content: "def greet(): pass\n" },
    { path: "lib.py", language: "python", blobSha: "s2", content: "def greet(): pass\n" },
    { path: "Main.kt", language: "kotlin", blobSha: "s3", content: "fun main() {}\n" }, // unsupported
  ];

  const result = await scheduleRepositoryParse({
    repository,
    files,
    options: { registry, concurrency: 2 },
  });

  assert.equal(result.status, "partial"); // 2 complete + 1 unsupported = partial
  assert.equal(result.files.length, 3);
  assert.equal(result.summary.totalFiles, 3);
  assert.equal(result.summary.parsedComplete, 2);
  assert.equal(result.summary.unsupported, 1);
  assert.equal(result.summary.totalSymbols, 2);
});

test("ParserScheduler: per-file timeout prevents worker hang and records failed FileIR", async () => {
  const registry = new ParserRegistry();

  class HangingAdapter extends BaseAdapter {
    constructor() {
      super({ adapterId: "hanging" });
    }
    getSupportedLanguages() {
      return ["ruby"];
    }
    async parseFile() {
      // Simulate hanging parser that exceeds timeout
      await new Promise((r) => setTimeout(r, 200));
      return {};
    }
  }

  registry.registerAdapter(new HangingAdapter());

  const repository = {
    owner: "octocat",
    name: "hello-world",
    fullName: "octocat/hello-world",
    commitSha: "c1234567890",
  };

  const files = [
    { path: "app.rb", language: "ruby", blobSha: "s_rb", content: "class App; end" },
  ];

  // Set fileTimeoutMs to 50ms to trigger timeout
  const result = await scheduleRepositoryParse({
    repository,
    files,
    options: { registry, fileTimeoutMs: 50 },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].parser.status, "failed");
  assert.equal(result.files[0].diagnostics[0].code, "PARSER_TIMEOUT");
});

// ========================================================
// 7. CONTROLLER AUTHORIZATION TESTS
// ========================================================
test("parseRepository controller: rejects unauthenticated requests (401)", async () => {
  const reqUnauth = {
    actor: null,
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };
  const res = {};

  await assert.rejects(
    async () => parseController(reqUnauth, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 401);
      assert.equal(err.code, "UNAUTHENTICATED");
      return true;
    }
  );
});

test("parseRepository controller: rejects request with missing active organization (403)", async () => {
  const reqNoOrg = {
    actor: { userId: "user_test", orgId: null },
    body: { url: "https://github.com/octocat/Hello-World" },
    params: {},
  };
  const res = {};

  await assert.rejects(
    async () => parseController(reqNoOrg, res),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal(err.status, 403);
      assert.equal(err.code, "NO_ACTIVE_ORGANIZATION");
      return true;
    }
  );
});

