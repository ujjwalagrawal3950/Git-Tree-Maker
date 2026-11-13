const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultRegistry,
  JavaScriptAdapter,
  TypeScriptAdapter,
  scheduleRepositoryParse,
} = require("../services/parser");
const { validateFileIR } = require("../services/parser/irValidator");

const MOCK_REPO = {
  owner: "facebook",
  name: "react",
  fullName: "facebook/react",
  commitSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

// ========================================================
// 1. REGISTRY INTEGRATION
// ========================================================
test("ParserRegistry: defaultRegistry has JavaScript, TypeScript, Python, and Java adapters registered", () => {
  assert.equal(defaultRegistry.hasAdapter("javascript"), true);
  assert.equal(defaultRegistry.hasAdapter("typescript"), true);
  assert.equal(defaultRegistry.hasAdapter("python"), true);
  assert.equal(defaultRegistry.hasAdapter("java"), true);
  assert.equal(defaultRegistry.hasAdapter("JAVASCRIPT"), true);
  assert.equal(defaultRegistry.hasAdapter("TYPESCRIPT"), true);
  assert.equal(defaultRegistry.hasAdapter("PYTHON"), true);
  assert.equal(defaultRegistry.hasAdapter("JAVA"), true);

  const jsAdapter = defaultRegistry.getAdapter("javascript");
  assert.equal(jsAdapter instanceof JavaScriptAdapter, true);

  const tsAdapter = defaultRegistry.getAdapter("typescript");
  assert.equal(tsAdapter instanceof TypeScriptAdapter, true);

  const pyAdapter = defaultRegistry.getAdapter("python");
  assert.equal(pyAdapter.adapterId, "python-adapter");

  const javaAdapter = defaultRegistry.getAdapter("java");
  assert.equal(javaAdapter.adapterId, "java-adapter");

  // Other languages remain unsupported
  const rubyAdapter = defaultRegistry.getAdapter("ruby");
  assert.equal(rubyAdapter.adapterId, "unsupported-adapter");
});

// ========================================================
// 2. JAVASCRIPT ADAPTER END-TO-END PARSE
// ========================================================
test("JavaScriptAdapter: parses JS/JSX file and produces schema-compliant FileIR", async () => {
  const adapter = new JavaScriptAdapter();
  const code = `
    import React from 'react';
    import { formatName } from './utils';

    export function WelcomeBanner({ name }) {
      const displayName = formatName(name);
      console.log('Rendering WelcomeBanner');
      return <h1>Welcome, {displayName}</h1>;
    }

    export default WelcomeBanner;
  `;

  const file = {
    path: "src/WelcomeBanner.jsx",
    blobSha: "sha_jsx_12345",
    language: "javascript",
    content: code,
    repository: MOCK_REPO,
  };

  const fileIR = await adapter.parseFile(file);

  assert.equal(fileIR.irVersion, "1.0.0");
  assert.equal(fileIR.parser.adapterId, "javascript-adapter");
  assert.equal(fileIR.parser.status, "complete");
  assert.equal(fileIR.diagnostics.length, 0);

  // Symbols: WelcomeBanner function + displayName const = 2
  assert.equal(fileIR.symbols.length >= 1, true);
  const fnSym = fileIR.symbols.find((s) => s.name === "WelcomeBanner");
  assert.ok(fnSym);
  assert.equal(fnSym.isExported, true);

  // Imports: react, ./utils = 2
  assert.equal(fileIR.imports.length, 2);

  // Exports: named WelcomeBanner, default WelcomeBanner = 2
  assert.equal(fileIR.exports.length, 2);

  // Calls: formatName, console.log = 2
  assert.equal(fileIR.callSites.length, 2);

  const validation = validateFileIR(fileIR);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join("; ")}`);
});

// ========================================================
// 3. TYPESCRIPT ADAPTER END-TO-END PARSE
// ========================================================
test("TypeScriptAdapter: parses TS/TSX file with type facts and produces schema-compliant FileIR", async () => {
  const adapter = new TypeScriptAdapter();
  const code = `
    import { BaseService } from './base';

    export interface IUserService {
      getUser(id: string): Promise<User>;
    }

    export class UserService extends BaseService implements IUserService {
      async getUser(id: string): Promise<User> {
        const user = await this.db.fetchUser(id);
        return user;
      }
    }
  `;

  const file = {
    path: "src/UserService.ts",
    blobSha: "sha_ts_98765",
    language: "typescript",
    content: code,
    repository: MOCK_REPO,
  };

  const fileIR = await adapter.parseFile(file);

  assert.equal(fileIR.irVersion, "1.0.0");
  assert.equal(fileIR.parser.adapterId, "typescript-adapter");
  assert.equal(fileIR.parser.status, "complete");

  // Inheritance: extends BaseService, implements IUserService
  assert.equal(fileIR.inheritance.length, 2);
  assert.equal(fileIR.inheritance[0].kind, "extends");
  assert.equal(fileIR.inheritance[0].targetText, "BaseService");
  assert.equal(fileIR.inheritance[1].kind, "implements");
  assert.equal(fileIR.inheritance[1].targetText, "IUserService");

  // Type references
  assert.equal(fileIR.typeReferences.length >= 2, true);

  const validation = validateFileIR(fileIR);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join("; ")}`);
});

// ========================================================
// 4. ERROR RECOVERY: PARTIAL STATUS ON SYNTAX ERROR
// ========================================================
test("TypeScriptAdapter: recovers partial facts on syntax error and marks status partial", async () => {
  const adapter = new TypeScriptAdapter();
  // Contains a valid function followed by a syntax error
  const code = `
    export function healthyFunction() {
      return 100;
    }

    export function brokenFunction( { const x = ;
  `;

  const file = {
    path: "src/broken.ts",
    blobSha: "sha_broken_123",
    language: "typescript",
    content: code,
    repository: MOCK_REPO,
  };

  const fileIR = await adapter.parseFile(file);

  // Status must be partial due to syntax diagnostics
  assert.equal(fileIR.parser.status, "partial");
  assert.equal(fileIR.diagnostics.length > 0, true);
  assert.ok(fileIR.diagnostics.some((d) => d.severity === "error"));

  // Recovered healthy function is preserved
  const healthySym = fileIR.symbols.find((s) => s.name === "healthyFunction");
  assert.ok(healthySym);

  const validation = validateFileIR(fileIR);
  assert.equal(validation.isValid, true, `Validation failed: ${validation.errors.join("; ")}`);
});

// ========================================================
// 5. MULTI-FILE SCHEDULING INTEGRATION
// ========================================================
test("scheduleRepositoryParse: schedules JS, TS, and unsupported files using defaultRegistry", async () => {
  const files = [
    {
      path: "src/app.js",
      language: "javascript",
      blobSha: "b1",
      content: "export function run() { console.log('app running'); }",
    },
    {
      path: "src/types.ts",
      language: "typescript",
      blobSha: "b2",
      content: "export interface Config { debug: boolean; }",
    },
    {
      path: "main.go",
      language: "go",
      blobSha: "b3",
      content: "package main",
    },
  ];

  const result = await scheduleRepositoryParse({
    repository: MOCK_REPO,
    files,
  });

  assert.equal(result.status, "partial"); // 2 complete (js, ts) + 1 unsupported (go)
  assert.equal(result.summary.totalFiles, 3);
  assert.equal(result.summary.parsedComplete, 2);
  assert.equal(result.summary.unsupported, 1);
  assert.equal(result.summary.failed, 0);

  // Both JS and TS files have real extracted symbols
  const jsIR = result.files.find((f) => f.analysis.file.path === "src/app.js");
  assert.equal(jsIR.parser.adapterId, "javascript-adapter");
  assert.equal(jsIR.parser.status, "complete");
  assert.equal(jsIR.symbols.length, 1);
  assert.equal(jsIR.callSites.length, 1);

  const tsIR = result.files.find((f) => f.analysis.file.path === "src/types.ts");
  assert.equal(tsIR.parser.adapterId, "typescript-adapter");
  assert.equal(tsIR.parser.status, "complete");
  assert.equal(tsIR.symbols.length, 1);

  const goIR = result.files.find((f) => f.analysis.file.path === "main.go");
  assert.equal(goIR.parser.status, "unsupported");
});

test("scheduleRepositoryParse: dispatches Java source files to JavaAdapter producing complete FileIR", async () => {
  const files = [
    {
      path: "src/main/java/com/example/App.java",
      language: "java",
      blobSha: "b_java_1",
      content: "package com.example;\npublic class App {\n    public static void main(String[] args) {\n        System.out.println(\"hello\");\n    }\n}\n",
    },
  ];

  const result = await scheduleRepositoryParse({
    repository: MOCK_REPO,
    files,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.summary.totalFiles, 1);
  assert.equal(result.summary.parsedComplete, 1);
  assert.equal(result.summary.failed, 0);

  const javaIR = result.files[0];
  assert.equal(javaIR.parser.adapterId, "java-adapter");
  assert.equal(javaIR.parser.status, "complete");
  assert.ok(javaIR.symbols.some((s) => s.name === "App"));
  assert.ok(javaIR.callSites.length >= 1);

  const validation = validateFileIR(javaIR);
  assert.equal(validation.isValid, true);
});

