const path = require("node:path");
const ts = require("typescript");
const { mapNodeLocation } = require("./locationMapper");
const { createDiagnostic } = require("../../irBuilder");

/**
 * Mapping of supported JavaScript and TypeScript extensions to TypeScript ScriptKind.
 */
const EXTENSION_TO_SCRIPT_KIND = {
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
};

/**
 * Resolves the TypeScript ScriptKind based on file path extension.
 *
 * @param {string} filePath - Path or filename (e.g. "src/App.tsx")
 * @returns {import("typescript").ScriptKind}
 */
function resolveScriptKind(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return ts.ScriptKind.Unknown;
  }
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_SCRIPT_KIND[ext] || ts.ScriptKind.Unknown;
}

/**
 * Parses JavaScript or TypeScript source code into a TypeScript SourceFile AST.
 * Pure in-memory syntax parsing via ts.createSourceFile.
 * Does NOT create a ts.Program, execute code, or perform filesystem resolution.
 *
 * @param {string} filePath - Path to source file
 * @param {string} content - Raw source code text
 * @param {object} [options]
 * @param {import("typescript").ScriptKind} [options.scriptKind]
 * @param {import("typescript").ScriptTarget} [options.target]
 * @returns {{
 *   sourceFile: import("typescript").SourceFile,
 *   scriptKind: import("typescript").ScriptKind,
 *   diagnostics: Array<object>,
 *   hasErrors: boolean
 * }}
 */
function createSourceAST(filePath, content, options = {}) {
  const safeContent = typeof content === "string" ? content : "";
  const scriptKind = options.scriptKind || resolveScriptKind(filePath);
  const target = options.target || ts.ScriptTarget.Latest;

  // ts.createSourceFile(fileName, sourceText, languageVersion, setParentNodes, scriptKind)
  const sourceFile = ts.createSourceFile(
    filePath || "unknown.ts",
    safeContent,
    target,
    /* setParentNodes */ true,
    scriptKind
  );

  // Extract parse diagnostics
  const diagnostics = [];
  const parseDiagnostics = sourceFile.parseDiagnostics || [];

  for (const diag of parseDiagnostics) {
    const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    let location = null;

    if (typeof diag.start === "number") {
      const length = typeof diag.length === "number" ? diag.length : 1;
      location = mapNodeLocation(sourceFile, diag.start, diag.start + length);
    }

    let severity = "error";
    if (diag.category === ts.DiagnosticCategory.Warning) {
      severity = "warning";
    } else if (diag.category === ts.DiagnosticCategory.Message || diag.category === ts.DiagnosticCategory.Suggestion) {
      severity = "info";
    }

    diagnostics.push(
      createDiagnostic({
        code: `TS${diag.code}`,
        severity,
        message,
        location,
      })
    );
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");

  return {
    sourceFile,
    scriptKind,
    diagnostics,
    hasErrors,
  };
}

module.exports = {
  EXTENSION_TO_SCRIPT_KIND,
  resolveScriptKind,
  createSourceAST,
};

