const test = require("node:test");
const assert = require("node:assert/strict");

const {
  JavaScriptModuleResolver,
  JavaScriptAdapter,
  TypeScriptAdapter,
} = require("../services/parser");

const MOCK_REPO = {
  owner: "facebook",
  name: "react",
  fullName: "facebook/react",
  commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

// ========================================================
// 1. RELATIVE EXACT MATCH & EXTENSION PROBING
// ========================================================
test("JavaScriptModuleResolver: resolves exact matches and extension probing", () => {
  const manifest = [
    "src/index.ts",
    "src/utils.ts",
    "src/styles.css",
    "src/components/Button.tsx",
  ];

  const resolver = new JavaScriptModuleResolver({ manifest });

  // 1. Exact match
  const exact = resolver.resolveSpecifier("src/index.ts", "./styles.css");
  assert.equal(exact.status, "internal_resolved");
  assert.equal(exact.resolvedPath, "src/styles.css");
  assert.equal(exact.rule, "exact_match");

  // 2. Extension probing: ./utils -> src/utils.ts
  const probed = resolver.resolveSpecifier("src/index.ts", "./utils");
  assert.equal(probed.status, "internal_resolved");
  assert.equal(probed.resolvedPath, "src/utils.ts");
  assert.equal(probed.rule, "extension_probing");

  // 3. Parent relative probing: ../components/Button from src/pages/Home.tsx
  const parentProbed = resolver.resolveSpecifier("src/pages/Home.tsx", "../components/Button");
  assert.equal(parentProbed.status, "internal_resolved");
  assert.equal(parentProbed.resolvedPath, "src/components/Button.tsx");
  assert.equal(parentProbed.rule, "extension_probing");
});

// ========================================================
// 2. DIRECTORY INDEX RESOLUTION
// ========================================================
test("JavaScriptModuleResolver: resolves directory index imports", () => {
  const manifest = [
    "src/app.ts",
    "src/components/index.tsx",
    "src/lib/index.js",
  ];

  const resolver = new JavaScriptModuleResolver({ manifest });

  // ./components -> src/components/index.tsx
  const res1 = resolver.resolveSpecifier("src/app.ts", "./components");
  assert.equal(res1.status, "internal_resolved");
  assert.equal(res1.resolvedPath, "src/components/index.tsx");
  assert.equal(res1.rule, "index_resolution");

  // ./lib -> src/lib/index.js
  const res2 = resolver.resolveSpecifier("src/app.ts", "./lib");
  assert.equal(res2.status, "internal_resolved");
  assert.equal(res2.resolvedPath, "src/lib/index.js");
  assert.equal(res2.rule, "index_resolution");
});

// ========================================================
// 3. AMBIGUOUS AND UNRESOLVED HANDLING
// ========================================================
test("JavaScriptModuleResolver: marks duplicate candidate files as ambiguous and non-existent as unresolved", () => {
  // Both .ts and .js exist for "utils"
  const manifest = [
    "src/app.ts",
    "src/utils.ts",
    "src/utils.js",
  ];

  const resolver = new JavaScriptModuleResolver({ manifest });

  // Ambiguous: multiple matching candidates
  const ambig = resolver.resolveSpecifier("src/app.ts", "./utils");
  assert.equal(ambig.status, "ambiguous");
  assert.equal(ambig.resolvedPath, null);
  assert.equal(ambig.candidates.length, 2);

  // Unresolved: target does not exist
  const unres = resolver.resolveSpecifier("src/app.ts", "./nonexistent");
  assert.equal(unres.status, "unresolved");
  assert.equal(unres.resolvedPath, null);
});

// ========================================================
// 4. NODE BUILT-INS VS EXTERNAL PACKAGES
// ========================================================
test("JavaScriptModuleResolver: classifies Node built-ins and external packages accurately", () => {
  const resolver = new JavaScriptModuleResolver({ manifest: [] });

  // Node built-ins
  const fsRes = resolver.resolveSpecifier("src/app.ts", "fs");
  assert.equal(fsRes.status, "builtin");
  assert.equal(fsRes.rule, "node_builtin");

  const nodePathRes = resolver.resolveSpecifier("src/app.ts", "node:path");
  assert.equal(nodePathRes.status, "builtin");

  const fsPromisesRes = resolver.resolveSpecifier("src/app.ts", "fs/promises");
  assert.equal(fsPromisesRes.status, "builtin");

  // External packages
  const reactRes = resolver.resolveSpecifier("src/app.ts", "react");
  assert.equal(reactRes.status, "external_package");
  assert.equal(reactRes.packageName, "react");

  const scopedRes = resolver.resolveSpecifier("src/app.ts", "@clerk/backend");
  assert.equal(scopedRes.status, "external_package");
  assert.equal(scopedRes.packageName, "@clerk/backend");

  const lodashRes = resolver.resolveSpecifier("src/app.ts", "lodash/get");
  assert.equal(lodashRes.status, "external_package");
  assert.equal(lodashRes.packageName, "lodash");

  // Dynamic expressions
  const dynamicRes = resolver.resolveSpecifier("src/app.ts", null);
  assert.equal(dynamicRes.status, "dynamic");
  assert.equal(dynamicRes.rule, "dynamic_expression");
});

// ========================================================
// 5. TYPESCRIPT PATH ALIASES VIA TSCONFIG.JSON
// ========================================================
test("JavaScriptModuleResolver: resolves TypeScript path aliases configured in tsconfig.json", () => {
  const manifest = [
    "src/index.ts",
    "src/components/Header.tsx",
    "src/shared/utils.ts",
  ];

  const tsconfigContent = JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
        "@shared/*": ["src/shared/*"],
      },
    },
  });

  const resolver = new JavaScriptModuleResolver({
    manifest,
    supportingFiles: { "tsconfig.json": tsconfigContent },
  });

  // Alias @/components/Header -> src/components/Header.tsx
  const headerRes = resolver.resolveSpecifier("src/index.ts", "@/components/Header");
  assert.equal(headerRes.status, "internal_resolved");
  assert.equal(headerRes.resolvedPath, "src/components/Header.tsx");
  assert.equal(headerRes.rule, "tsconfig_alias");

  // Alias @shared/utils -> src/shared/utils.ts
  const utilsRes = resolver.resolveSpecifier("src/index.ts", "@shared/utils");
  assert.equal(utilsRes.status, "internal_resolved");
  assert.equal(utilsRes.resolvedPath, "src/shared/utils.ts");
  assert.equal(utilsRes.rule, "tsconfig_alias");
});

// ========================================================
// 6. END-TO-END FILEIR RESOLUTION & SUMMARY METRICS
// ========================================================
test("JavaScriptModuleResolver: resolves parsed FileIR and aggregates repository metrics", async () => {
  const tsAdapter = new TypeScriptAdapter();
  const code = `
    import React from "react";
    import { format } from "./utils";
    import * as fs from "node:fs";
    import { Header } from "@/components/Header";
    import "./missing";
    export { helper } from "./helper";
  `;

  const manifest = [
    "src/App.tsx",
    "src/utils.ts",
    "src/helper.ts",
    "src/components/Header.tsx",
  ];

  const tsconfig = JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
  });

  const file = {
    path: "src/App.tsx",
    blobSha: "sha_app",
    language: "typescript",
    content: code,
    repository: MOCK_REPO,
  };

  const fileIR = await tsAdapter.parseFile(file);

  const resolver = new JavaScriptModuleResolver({
    manifest,
    supportingFiles: { "tsconfig.json": tsconfig },
  });

  const repoResolution = resolver.resolveRepository([fileIR]);

  assert.equal(repoResolution.files.length, 1);
  const fileRecord = repoResolution.files[0];
  assert.equal(fileRecord.filePath, "src/App.tsx");
  // 5 imports + 1 re-export = 6 total resolutions
  assert.equal(fileRecord.resolutions.length, 6);

  const summary = repoResolution.summary;
  assert.equal(summary.totalResolutions, 6);
  assert.equal(summary.internalResolved, 3); // ./utils, @/components/Header, ./helper
  assert.equal(summary.externalPackages, 1); // react
  assert.equal(summary.builtins, 1);         // node:fs
  assert.equal(summary.unresolved, 1);       // ./missing
  assert.equal(summary.ambiguous, 0);
  assert.equal(summary.dynamic, 0);
});

