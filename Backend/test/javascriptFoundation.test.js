const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");

const {
  createSourceAST,
  resolveScriptKind,
  EXTENSION_TO_SCRIPT_KIND,
} = require("../services/parser/adapters/javascript/parserFactory");
const { mapNodeLocation } = require("../services/parser/adapters/javascript/locationMapper");

// ========================================================
// 1. SCRIPT KIND RESOLUTION FOR ALL 8 EXTENSIONS
// ========================================================
test("parserFactory: resolves correct ScriptKind for all eight target extensions", () => {
  const cases = [
    { file: "index.js", expected: ts.ScriptKind.JS },
    { file: "Component.jsx", expected: ts.ScriptKind.JSX },
    { file: "module.mjs", expected: ts.ScriptKind.JS },
    { file: "common.cjs", expected: ts.ScriptKind.JS },
    { file: "types.ts", expected: ts.ScriptKind.TS },
    { file: "App.tsx", expected: ts.ScriptKind.TSX },
    { file: "esm.mts", expected: ts.ScriptKind.TS },
    { file: "node.cts", expected: ts.ScriptKind.TS },
  ];

  for (const { file, expected } of cases) {
    const kind = resolveScriptKind(file);
    assert.equal(
      kind,
      expected,
      `Failed ScriptKind resolution for ${file}: expected ${expected}, got ${kind}`
    );
  }
});

// ========================================================
// 2. PARSING ALL EIGHT TARGET EXTENSIONS
// ========================================================
test("parserFactory: creates AST for all eight extensions cleanly", () => {
  const extensionFixtures = [
    {
      path: "src/utils.js",
      content: "export function add(a, b) { return a + b; }",
      expectedKind: ts.ScriptKind.JS,
    },
    {
      path: "src/Button.jsx",
      content: "export const Button = () => <button>Click</button>;",
      expectedKind: ts.ScriptKind.JSX,
    },
    {
      path: "src/config.mjs",
      content: "export default { debug: true };",
      expectedKind: ts.ScriptKind.JS,
    },
    {
      path: "src/legacy.cjs",
      content: "module.exports = { port: 3000 };",
      expectedKind: ts.ScriptKind.JS,
    },
    {
      path: "src/math.ts",
      content: "export interface Point { x: number; y: number; }",
      expectedKind: ts.ScriptKind.TS,
    },
    {
      path: "src/Widget.tsx",
      content: "export const Widget: React.FC = () => <div>Widget</div>;",
      expectedKind: ts.ScriptKind.TSX,
    },
    {
      path: "src/network.mts",
      content: "export type URLString = string;",
      expectedKind: ts.ScriptKind.TS,
    },
    {
      path: "src/native.cts",
      content: "export const VERSION: string = '1.0.0';",
      expectedKind: ts.ScriptKind.TS,
    },
  ];

  for (const fixture of extensionFixtures) {
    const { sourceFile, scriptKind, diagnostics, hasErrors } = createSourceAST(
      fixture.path,
      fixture.content
    );

    assert.ok(sourceFile, `AST was not returned for ${fixture.path}`);
    assert.equal(scriptKind, fixture.expectedKind);
    assert.equal(hasErrors, false, `Unexpected syntax errors in ${fixture.path}`);
    assert.equal(diagnostics.length, 0);
    assert.equal(sourceFile.statements.length > 0, true);
  }
});

// ========================================================
// 3. SOURCE LOCATION NORMALIZATION (1-based line, 0-based column)
// ========================================================
test("locationMapper: normalizes coordinates to Cartograph conventions", () => {
  const content = "function hello() {\n  const x = 42;\n  return x;\n}\n";
  const { sourceFile } = createSourceAST("test.ts", content);

  // Statement 0: function hello() { ... }
  const fnDecl = sourceFile.statements[0];
  const loc = mapNodeLocation(sourceFile, fnDecl);

  assert.equal(loc.start.line, 1);
  assert.equal(loc.start.column, 0);
  assert.equal(loc.end.line, 4);
  assert.equal(loc.end.column, 1);

  // Statement inside body: const x = 42;
  const constDecl = fnDecl.body.statements[0];
  const constLoc = mapNodeLocation(sourceFile, constDecl);

  assert.equal(constLoc.start.line, 2);
  assert.equal(constLoc.start.column, 2);
  assert.equal(constLoc.end.line, 2);
  assert.equal(constLoc.end.column, 15);
});

// ========================================================
// 4. PARSE DIAGNOSTICS & SYNTAX ERROR CAPTURE
// ========================================================
test("parserFactory: captures parse diagnostics without throwing on malformed syntax", () => {
  const malformedContent = "function broken( { const x = ;";
  const { sourceFile, diagnostics, hasErrors } = createSourceAST("broken.ts", malformedContent);

  // AST is still produced (error-resilient)
  assert.ok(sourceFile);
  assert.equal(hasErrors, true);
  assert.equal(diagnostics.length > 0, true);

  const firstDiag = diagnostics[0];
  assert.ok(firstDiag.code.startsWith("TS"));
  assert.equal(firstDiag.severity, "error");
  assert.ok(firstDiag.message.length > 0);
  assert.ok(firstDiag.location);
  assert.ok(firstDiag.location.start.line >= 1);
  assert.ok(firstDiag.location.start.column >= 0);
});

// ========================================================
// 5. EMPTY FILE HANDLING
// ========================================================
test("parserFactory: handles empty and whitespace-only files gracefully", () => {
  const empty = createSourceAST("empty.js", "");
  assert.ok(empty.sourceFile);
  assert.equal(empty.hasErrors, false);
  assert.equal(empty.diagnostics.length, 0);
  assert.equal(empty.sourceFile.statements.length, 0);

  const whitespace = createSourceAST("spaces.tsx", "   \n\n  \t  \n");
  assert.ok(whitespace.sourceFile);
  assert.equal(whitespace.hasErrors, false);
  assert.equal(whitespace.diagnostics.length, 0);
});

