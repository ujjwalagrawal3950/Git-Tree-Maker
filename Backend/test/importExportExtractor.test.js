const test = require("node:test");
const assert = require("node:assert/strict");

const { createSourceAST } = require("../services/parser/adapters/javascript/parserFactory");
const { extractImports } = require("../services/parser/adapters/javascript/importExtractor");
const { extractExports } = require("../services/parser/adapters/javascript/exportExtractor");
const { extractDeclarations } = require("../services/parser/adapters/javascript/declarationExtractor");
const { buildFileIR } = require("../services/parser/irBuilder");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "facebook",
  name: "react",
  fullName: "facebook/react",
  commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

// ========================================================
// 1. ESM IMPORTS EXTRACTION
// ========================================================
test("importExtractor: extracts default, named, namespace, type-only and side-effect imports", () => {
  const code = `
    import React from "react";
    import { useState as state, useEffect, type Dispatch } from "react";
    import * as path from "node:path";
    import type { UserProfile } from "./types";
    import "./styles.css";
  `;

  const fileId = "file_app_tsx";
  const { sourceFile } = createSourceAST("src/App.tsx", code);
  const imports = extractImports(sourceFile, fileId);

  assert.equal(imports.length, 5);

  // 1. Default import
  const imp0 = imports[0];
  assert.equal(imp0.kind, "module_import");
  assert.equal(imp0.rawSource, "react");
  assert.equal(imp0.sourceKind, "package");
  assert.equal(imp0.specifiers.length, 1);
  assert.equal(imp0.specifiers[0].kind, "default");
  assert.equal(imp0.specifiers[0].localName, "React");

  // 2. Named imports with alias and inline type-only
  const imp1 = imports[1];
  assert.equal(imp1.rawSource, "react");
  assert.equal(imp1.specifiers.length, 3);
  assert.equal(imp1.specifiers[0].importedName, "useState");
  assert.equal(imp1.specifiers[0].localName, "state");
  assert.equal(imp1.specifiers[0].isTypeOnly, false);
  assert.equal(imp1.specifiers[2].importedName, "Dispatch");
  assert.equal(imp1.specifiers[2].isTypeOnly, true);

  // 3. Namespace import
  const imp2 = imports[2];
  assert.equal(imp2.rawSource, "node:path");
  assert.equal(imp2.specifiers[0].kind, "namespace");
  assert.equal(imp2.specifiers[0].localName, "path");

  // 4. Top-level type-only import
  const imp3 = imports[3];
  assert.equal(imp3.rawSource, "./types");
  assert.equal(imp3.sourceKind, "relative");
  assert.equal(imp3.specifiers[0].isTypeOnly, true);

  // 5. Side-effect import
  const imp4 = imports[4];
  assert.equal(imp4.rawSource, "./styles.css");
  assert.equal(imp4.sourceKind, "relative");
  assert.equal(imp4.specifiers.length, 0);
});

// ========================================================
// 2. DYNAMIC IMPORTS & COMMONJS REQUIRE
// ========================================================
test("importExtractor: extracts static dynamic imports and CommonJS require calls", () => {
  const code = `
    const helper = require("./helper");
    const dynamicVar = require(moduleName);
    const lazyComponent = import("./views/Dashboard");
    const runtimeLoad = import(dynamicUrl);
  `;

  const fileId = "file_dynamic_js";
  const { sourceFile } = createSourceAST("src/dynamic.js", code);
  const imports = extractImports(sourceFile, fileId);

  assert.equal(imports.length, 4);

  // 1. Static CommonJS require
  const reqStatic = imports[0];
  assert.equal(reqStatic.kind, "require_call");
  assert.equal(reqStatic.rawSource, "./helper");
  assert.equal(reqStatic.sourceKind, "relative");
  assert.equal(reqStatic.languageMetadata.isDynamicExpression, false);
  assert.equal(reqStatic.specifiers[0].localName, "helper");

  // 2. Dynamic expression require
  const reqDynamic = imports[1];
  assert.equal(reqDynamic.kind, "require_call");
  assert.equal(reqDynamic.rawSource, null);
  assert.equal(reqDynamic.languageMetadata.isDynamicExpression, true);

  // 3. Static dynamic import
  const impStatic = imports[2];
  assert.equal(impStatic.kind, "dynamic_import");
  assert.equal(impStatic.rawSource, "./views/Dashboard");
  assert.equal(impStatic.languageMetadata.isDynamicExpression, false);

  // 4. Dynamic expression import
  const impDynamic = imports[3];
  assert.equal(impDynamic.kind, "dynamic_import");
  assert.equal(impDynamic.rawSource, null);
  assert.equal(impDynamic.languageMetadata.isDynamicExpression, true);
});

// ========================================================
// 3. ESM AND COMMONJS EXPORTS EXTRACTION
// ========================================================
test("exportExtractor: extracts declarations, re-exports, default, and CommonJS exports", () => {
  const code = `
    export const API_URL = "https://api.example.com";
    export function fetchUser() {}
    export default function main() {}

    export { helper, utils as tools } from "./utils";
    export * from "./constants";

    module.exports = { app: true };
    exports.version = "2.0";
    module.exports.port = 8080;
  `;

  const fileId = "file_exports_js";
  const { sourceFile } = createSourceAST("src/exports.js", code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const exports = extractExports(sourceFile, fileId, symbols);

  // Check exported declarations
  const namedConst = exports.find((e) => e.exportedName === "API_URL");
  assert.ok(namedConst);
  assert.equal(namedConst.kind, "named");
  assert.ok(namedConst.symbolId);

  const namedFn = exports.find((e) => e.exportedName === "fetchUser");
  assert.ok(namedFn);
  assert.equal(namedFn.kind, "named");

  const defaultExp = exports.find((e) => e.exportedName === "default" && !e.languageMetadata.isCommonJS);
  assert.ok(defaultExp);
  assert.equal(defaultExp.kind, "default");

  // Check re-exports
  const reexports = exports.filter((e) => e.source === "./utils");
  assert.equal(reexports.length, 2);
  assert.equal(reexports[0].kind, "reexport");
  assert.equal(reexports[0].exportedName, "helper");
  assert.equal(reexports[1].exportedName, "tools");

  // Check wildcard re-export
  const wildcard = exports.find((e) => e.source === "./constants");
  assert.ok(wildcard);
  assert.equal(wildcard.kind, "wildcard");
  assert.equal(wildcard.exportedName, "*");

  // Check CommonJS exports
  const cjsDefault = exports.find((e) => e.languageMetadata.target === "module.exports");
  assert.ok(cjsDefault);
  assert.equal(cjsDefault.kind, "default");

  const cjsNamed1 = exports.find((e) => e.exportedName === "version");
  assert.ok(cjsNamed1);
  assert.equal(cjsNamed1.kind, "named");

  const cjsNamed2 = exports.find((e) => e.exportedName === "port");
  assert.ok(cjsNamed2);
  assert.equal(cjsNamed2.kind, "named");
});

// ========================================================
// 4. SCHEMA VALIDATION WITH EXTRACTED IMPORTS AND EXPORTS
// ========================================================
test("importExportExtractor: FileIR with extracted imports and exports passes schema validation", () => {
  const code = `
    import { useState } from "react";
    import "./styles.css";

    export function Counter() {
      const [count, setCount] = useState(0);
      return count;
    }

    export default Counter;
  `;

  const file = {
    path: "src/Counter.jsx",
    blobSha: "blob_counter_sha",
    language: "javascript",
    content: code,
  };

  const fileId = "file_counter_jsx";
  const { sourceFile, diagnostics } = createSourceAST(file.path, code);
  const symbols = extractDeclarations(sourceFile, fileId);
  const imports = extractImports(sourceFile, fileId);
  const exports = extractExports(sourceFile, fileId, symbols);

  const fileIR = buildFileIR({
    repository: MOCK_REPO,
    file,
    parser: {
      adapterId: "javascript-adapter",
      adapterVersion: "1.0.0",
      engine: "typescript",
      engineVersion: "5.9.3",
      status: "complete",
      capabilities: ["symbols", "imports", "exports"],
    },
    symbols,
    imports,
    exports,
    diagnostics,
  });

  const validation = validateFileIR(fileIR);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join("; ")}`);
  assert.equal(fileIR.stats.imports, 2);
  assert.equal(fileIR.stats.exports, 2);
});

