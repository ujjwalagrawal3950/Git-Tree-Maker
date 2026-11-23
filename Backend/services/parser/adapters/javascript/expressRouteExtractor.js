const ts = require("typescript");
const { createFileId } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Supported Express route registration methods.
 */
const EXPRESS_ROUTING_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
]);

/**
 * Callable/container symbol kinds capable of enclosing a route or mount declaration.
 */
const CALLABLE_CONTAINER_KINDS = new Set([
  "function",
  "method",
  "constructor",
  "class",
  "module",
  "namespace",
]);

/**
 * Checks if a coordinate position falls inside a symbol's declared location.
 *
 * @param {object} pos - { line, column }
 * @param {object} symbol - Symbol record
 * @returns {boolean}
 */
function isPositionInside(pos, symbol) {
  if (!symbol || !symbol.location) return false;
  const { start, end } = symbol.location;
  const { line, column } = pos;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && column < start.column) return false;
  if (line === end.line && column >= end.column) return false;
  return true;
}

/**
 * Finds the innermost enclosing symbol ID for a given position.
 *
 * @param {object} pos - { line, column }
 * @param {Array<object>} symbols - Pre-extracted symbol records
 * @returns {string|null}
 */
function findEnclosingSymbolId(pos, symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return null;
  let enclosing = null;
  for (const sym of symbols) {
    if (CALLABLE_CONTAINER_KINDS.has(sym.kind) && isPositionInside(pos, sym)) {
      if (!enclosing || sym.parentSymbolId === enclosing.id) {
        enclosing = sym;
      }
    }
  }
  return enclosing ? enclosing.id : null;
}

/**
 * In-memory registry storing extracted Express route facts by file ID.
 * Guarantees explicit accessibility to future Stage 3 resolvers even if FileIR
 * objects are cloned or deserialized across process/turn boundaries.
 */
class ExpressFactStore {
  constructor() {
    this.factsByFile = new Map();
  }

  setFacts(fileId, facts) {
    if (!fileId) return;
    this.factsByFile.set(fileId, {
      routes: Array.isArray(facts.routes) ? facts.routes : [],
      mounts: Array.isArray(facts.mounts) ? facts.mounts : [],
      timestamp: Date.now(),
    });
  }

  getFacts(fileId) {
    if (!fileId) return { routes: [], mounts: [] };
    return this.factsByFile.get(fileId) || { routes: [], mounts: [] };
  }

  getAllFacts() {
    return new Map(this.factsByFile);
  }

  clear() {
    this.factsByFile.clear();
  }
}

const expressFactStore = new ExpressFactStore();

/**
 * Helper to retrieve express route and mount facts for a given file or FileIR object.
 *
 * @param {string|object} fileIdOrIr
 * @returns {{ routes: Array<object>, mounts: Array<object> }}
 */
function getExpressRouteFacts(fileIdOrIr) {
  if (!fileIdOrIr) return { routes: [], mounts: [] };

  if (typeof fileIdOrIr === "string") {
    return expressFactStore.getFacts(fileIdOrIr);
  }

  // If passed a FileIR document
  if (typeof fileIdOrIr === "object") {
    // 1. Direct in-memory non-enumerable properties
    if (Array.isArray(fileIdOrIr.expressRoutes) || Array.isArray(fileIdOrIr.expressMounts)) {
      return {
        routes: fileIdOrIr.expressRoutes || [],
        mounts: fileIdOrIr.expressMounts || [],
      };
    }

    // 2. Lookup via analysis.file.fileId
    const fileId = fileIdOrIr.analysis?.file?.fileId || fileIdOrIr.fileId;
    if (fileId) {
      return expressFactStore.getFacts(fileId);
    }
  }

  return { routes: [], mounts: [] };
}

/**
 * Scans a source file AST to establish strong static evidence of Express usage and identify router/app receivers.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {object} Context object with evidence sets and import maps
 */
function analyzeExpressContext(sourceFile) {
  let hasExpressImport = false;
  const expressAppVariables = new Set();
  const expressRouterVariables = new Set();
  const exportedVariables = new Set();
  const importsMap = new Map(); // localName -> { rawSource, isDefault, isNamed, importedName }

  function inspectNode(node) {
    if (!node) return;

    // 1. ESM Import: import express, { Router } from "express"; import userRoutes from "./routes/userRoutes";
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec === "express" || spec.includes("express")) {
        hasExpressImport = true;
      }
      const clause = node.importClause;
      if (clause) {
        if (clause.name) {
          importsMap.set(clause.name.text, { rawSource: spec, isDefault: true, importedName: "default" });
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const elem of clause.namedBindings.elements) {
            const localName = elem.name.text;
            const importedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
            importsMap.set(localName, {
              rawSource: spec,
              isDefault: false,
              importedName,
            });
            if ((spec === "express" || spec.includes("express")) && importedName === "Router") {
              // Mark Router identifier if used directly
            }
          }
        }
      }
    }

    // 2. CommonJS require: const express = require("express"); const userRoutes = require("./routes/userRoutes");
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const init = node.initializer;

      // Direct require: const x = require("...")
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments.length >= 1) {
        const firstArg = init.arguments[0];
        if (ts.isStringLiteral(firstArg)) {
          const spec = firstArg.text;
          if (spec === "express" || spec.includes("express")) {
            hasExpressImport = true;
          }
          importsMap.set(varName, { rawSource: spec, isDefault: true, importedName: "default" });
        }
      }

      // express() or express.Router() or Router()
      if (ts.isCallExpression(init)) {
        const callExpr = init.expression;
        // express()
        if (ts.isIdentifier(callExpr)) {
          const importRecord = importsMap.get(callExpr.text);
          if (callExpr.text === "express" || (importRecord && (importRecord.rawSource === "express" || importRecord.rawSource.includes("express")))) {
            expressAppVariables.add(varName);
          }
          if (callExpr.text === "Router" || (importRecord && importRecord.importedName === "Router")) {
            expressRouterVariables.add(varName);
          }
        }
        // express.Router()
        if (ts.isPropertyAccessExpression(callExpr) && callExpr.name.text === "Router") {
          expressRouterVariables.add(varName);
        }
      }
    }

    // Destructured require: const { Router } = require("express");
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const init = node.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments.length >= 1) {
        const firstArg = init.arguments[0];
        if (ts.isStringLiteral(firstArg)) {
          const spec = firstArg.text;
          if (spec === "express" || spec.includes("express")) {
            hasExpressImport = true;
          }
          for (const elem of node.name.elements) {
            if (ts.isIdentifier(elem.name)) {
              const localName = elem.name.text;
              const importedName = elem.propertyName && ts.isIdentifier(elem.propertyName) ? elem.propertyName.text : localName;
              importsMap.set(localName, {
                rawSource: spec,
                isDefault: false,
                importedName,
              });
            }
          }
        }
      }
    }

    // 3. Module exports: module.exports = routes; export default router;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(sourceFile);
      if (left === "module.exports" || left.startsWith("module.exports.")) {
        if (ts.isIdentifier(node.right)) {
          exportedVariables.add(node.right.text);
        }
      }
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      exportedVariables.add(node.expression.text);
    }

    ts.forEachChild(node, inspectNode);
  }

  inspectNode(sourceFile);

  return {
    hasExpressImport,
    expressAppVariables,
    expressRouterVariables,
    exportedVariables,
    importsMap,
    isExpressLikely: hasExpressImport || expressAppVariables.size > 0 || expressRouterVariables.size > 0,
  };
}

/**
 * Determines receiver evidence for a given receiver identifier or expression text.
 *
 * @param {string} receiverText
 * @param {object} context
 * @returns {{ evidence: string, isRouter: boolean, isApp: boolean, isValid: boolean }}
 */
function getReceiverEvidence(receiverText, context) {
  if (context.expressAppVariables.has(receiverText)) {
    return { evidence: "express_app_init", isRouter: false, isApp: true, isValid: true };
  }
  if (context.expressRouterVariables.has(receiverText)) {
    return { evidence: "express_router_init", isRouter: true, isApp: false, isValid: true };
  }
  if (context.exportedVariables.has(receiverText) && context.isExpressLikely) {
    return { evidence: "express_exported_router", isRouter: true, isApp: false, isValid: true };
  }
  if (context.isExpressLikely) {
    if (receiverText === "router" || receiverText === "routes") {
      return { evidence: "express_module_context", isRouter: true, isApp: false, isValid: true };
    }
    if (receiverText === "app" || receiverText === "server") {
      return { evidence: "express_module_context", isRouter: false, isApp: true, isValid: true };
    }
  }
  return { evidence: "none", isRouter: false, isApp: false, isValid: false };
}

/**
 * Parses and classifies route path argument.
 *
 * @param {import("typescript").Expression|null} pathNode
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {object}
 */
function parseRoutePath(pathNode, sourceFile) {
  if (!pathNode) {
    return {
      rawPath: "",
      routePath: null,
      isDynamic: true,
      dynamicParts: [],
      pathClassification: "dynamic_expression",
    };
  }

  const rawPath = pathNode.getText(sourceFile);

  // 1. String literal or No-substitution template
  if (ts.isStringLiteral(pathNode) || ts.isNoSubstitutionTemplateLiteral(pathNode)) {
    const val = pathNode.text;
    const cleanPath = val.startsWith("/") ? val : `/${val}`;
    // Check for Express route parameters: :param
    const paramMatches = [...cleanPath.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
    return {
      rawPath,
      routePath: cleanPath,
      isDynamic: false,
      dynamicParts: paramMatches,
      pathClassification: paramMatches.length > 0 ? "parameterized" : "static",
    };
  }

  // 2. Template expression with parameters
  if (ts.isTemplateExpression(pathNode)) {
    const dynamicParts = [];
    let templatePattern = pathNode.head.text;
    for (const span of pathNode.templateSpans) {
      const exprText = span.expression.getText(sourceFile).trim();
      dynamicParts.push(exprText);
      const paramName = ts.isIdentifier(span.expression) ? span.expression.text : "param";
      templatePattern += `:${paramName}${span.literal.text}`;
    }
    return {
      rawPath,
      routePath: null, // Dynamic expressions are not statically proven exact paths
      isDynamic: true,
      dynamicParts,
      template: templatePattern,
      pathClassification: "dynamic_expression",
    };
  }

  // 3. Regular Expression literal
  if (pathNode.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return {
      rawPath,
      routePath: null,
      isDynamic: true,
      dynamicParts: [],
      pathClassification: "regex",
    };
  }

  // 4. Binary Expression (+ concatenation)
  if (ts.isBinaryExpression(pathNode) && pathNode.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // If all parts are static literals
    let isAllStatic = true;
    let combinedStatic = "";
    function checkPart(p) {
      if (ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p)) {
        combinedStatic += p.text;
      } else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        checkPart(p.left);
        checkPart(p.right);
      } else {
        isAllStatic = false;
      }
    }
    checkPart(pathNode);
    if (isAllStatic) {
      const cleanPath = combinedStatic.startsWith("/") ? combinedStatic : `/${combinedStatic}`;
      const paramMatches = [...cleanPath.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
      return {
        rawPath,
        routePath: cleanPath,
        isDynamic: false,
        dynamicParts: paramMatches,
        pathClassification: paramMatches.length > 0 ? "parameterized" : "static",
      };
    }
    return {
      rawPath,
      routePath: null,
      isDynamic: true,
      dynamicParts: [rawPath.trim()],
      pathClassification: "dynamic_expression",
    };
  }

  // 5. Fallback dynamic expression
  return {
    rawPath,
    routePath: null,
    isDynamic: true,
    dynamicParts: [rawPath.trim()],
    pathClassification: "dynamic_expression",
  };
}

/**
 * Extracts and classifies handlers from route declaration arguments.
 *
 * @param {Array<import("typescript").Expression>} handlerNodes
 * @param {import("typescript").SourceFile} sourceFile
 * @param {Array<object>} [symbols]
 * @returns {Array<object>}
 */
function extractHandlers(handlerNodes, sourceFile, symbols = []) {
  const symbolsByName = new Map();
  if (Array.isArray(symbols)) {
    for (const sym of symbols) {
      if (sym && sym.name) {
        symbolsByName.set(sym.name, sym);
      }
    }
  }

  return handlerNodes.map((hNode, idx) => {
    const rawText = hNode.getText(sourceFile);
    let name = "anonymous";
    let matchedSymbolId = null;

    if (ts.isIdentifier(hNode)) {
      name = hNode.text;
      const matched = symbolsByName.get(name);
      if (matched) matchedSymbolId = matched.id;
    } else if (ts.isPropertyAccessExpression(hNode)) {
      name = hNode.getText(sourceFile);
      const propName = hNode.name.text;
      const matched = symbolsByName.get(propName);
      if (matched) matchedSymbolId = matched.id;
    } else if (ts.isCallExpression(hNode)) {
      // Wrapper e.g. asyncHandler(buildGraph) or validateBody(schema)
      if (hNode.arguments.length >= 1 && ts.isIdentifier(hNode.arguments[0])) {
        name = hNode.arguments[0].text;
        const matched = symbolsByName.get(name);
        if (matched) matchedSymbolId = matched.id;
      } else {
        name = hNode.expression.getText(sourceFile);
      }
    } else if (ts.isFunctionExpression(hNode) && hNode.name) {
      name = hNode.name.text;
      const matched = symbolsByName.get(name);
      if (matched) matchedSymbolId = matched.id;
    }

    const isMiddleware = idx < handlerNodes.length - 1;
    const location = mapNodeLocation(sourceFile, hNode);

    return {
      name,
      rawText,
      isMiddleware,
      symbolId: matchedSymbolId,
      location,
    };
  });
}

/**
 * Extracts Express route declarations (e.g. `router.get(...)`, `app.post(...)`).
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @param {object} [options]
 * @returns {Array<object>}
 */
function extractExpressRoutes(sourceFile, fileId, options = {}) {
  if (!sourceFile) return [];

  const symbols = options.symbols || [];
  const context = options.context || analyzeExpressContext(sourceFile);
  const routes = [];
  let routeCounter = 0;

  function traverse(node) {
    if (!node) return;

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const expr = node.expression;
      const methodName = expr.name.text.toLowerCase();
      const receiverText = expr.expression.getText(sourceFile);
      const receiverCheck = getReceiverEvidence(receiverText, context);

      // Route declaration requires valid receiver, supported routing method, and at least 2 arguments (path + handler)
      if (receiverCheck.isValid && EXPRESS_ROUTING_METHODS.has(methodName) && node.arguments.length >= 2) {
        const location = mapNodeLocation(sourceFile, node);
        const enclosingSymbolId = findEnclosingSymbolId(location.start, symbols);
        const pathArg = node.arguments[0];
        const pathLocation = pathArg ? mapNodeLocation(sourceFile, pathArg) : null;
        const pathInfo = parseRoutePath(pathArg, sourceFile);
        const handlerNodes = Array.from(node.arguments).slice(1);
        const handlers = extractHandlers(handlerNodes, sourceFile, symbols);

        routes.push({
          id: `${fileId}#route_${routeCounter++}`,
          fileId,
          index: routeCounter - 1,
          receiver: receiverText,
          receiverEvidence: receiverCheck.evidence,
          httpMethod: methodName === "all" ? "ALL" : methodName.toUpperCase(),
          rawPath: pathInfo.rawPath,
          routePath: pathInfo.routePath,
          isDynamic: pathInfo.isDynamic,
          dynamicParts: pathInfo.dynamicParts,
          template: pathInfo.template || null,
          pathClassification: pathInfo.pathClassification,
          handlers,
          location,
          pathLocation,
          enclosingSymbolId,
        });
      }
    }

    ts.forEachChild(node, traverse);
  }

  ts.forEachChild(sourceFile, traverse);
  return routes;
}

/**
 * Extracts Express router mounting declarations (e.g. `app.use('/api', authRoutes)`).
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @param {object} [options]
 * @returns {Array<object>}
 */
function extractExpressMounts(sourceFile, fileId, options = {}) {
  if (!sourceFile) return [];

  const context = options.context || analyzeExpressContext(sourceFile);
  const moduleResolver = options.moduleResolver || null;
  const filePath = options.filePath || "";
  const repository = options.repository || { fullName: "unknown/unknown" };
  const mounts = [];
  let mountCounter = 0;

  function traverse(node) {
    if (!node) return;

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const expr = node.expression;
      const methodName = expr.name.text.toLowerCase();
      const receiverText = expr.expression.getText(sourceFile);
      const receiverCheck = getReceiverEvidence(receiverText, context);

      if (receiverCheck.isValid && methodName === "use" && node.arguments.length >= 1) {
        const location = mapNodeLocation(sourceFile, node);
        let prefixArg = null;
        let routerCandidates = [];

        if (node.arguments.length === 1) {
          prefixArg = null;
          routerCandidates = [node.arguments[0]];
        } else {
          prefixArg = node.arguments[0];
          routerCandidates = Array.from(node.arguments).slice(1);
        }

        // Mount Prefix Extraction
        let mountPrefix = "/";
        let isPrefixDynamic = false;
        let rawPrefix = '""';
        let prefixLocation = null;

        if (prefixArg) {
          rawPrefix = prefixArg.getText(sourceFile);
          prefixLocation = mapNodeLocation(sourceFile, prefixArg);
          if (ts.isStringLiteral(prefixArg) || ts.isNoSubstitutionTemplateLiteral(prefixArg)) {
            const val = prefixArg.text;
            mountPrefix = val.startsWith("/") ? val : `/${val}`;
          } else {
            mountPrefix = null;
            isPrefixDynamic = true;
          }
        }

        for (const rCandidate of routerCandidates) {
          // Handle array of routers: app.use('/api', [userRoutes, orgRoutes])
          const routerNodes = ts.isArrayLiteralExpression(rCandidate) ? rCandidate.elements : [rCandidate];

          for (const rNode of routerNodes) {
            const routerLocation = mapNodeLocation(sourceFile, rNode);
            let routerIdentifier = rNode.getText(sourceFile);
            let importedModuleSpecifier = null;
            let importedFileId = null;
            let isLocalRouter = false;
            let resolutionStatus = "unresolved";

            // 1. Inline require: require('./routes/userRoutes')
            if (ts.isCallExpression(rNode) && ts.isIdentifier(rNode.expression) && rNode.expression.text === "require" && rNode.arguments.length >= 1) {
              const firstArg = rNode.arguments[0];
              if (ts.isStringLiteral(firstArg)) {
                importedModuleSpecifier = firstArg.text;
                routerIdentifier = `require("${firstArg.text}")`;
              }
            } else if (ts.isIdentifier(rNode)) {
              const varName = rNode.text;
              if (context.importsMap.has(varName)) {
                importedModuleSpecifier = context.importsMap.get(varName).rawSource;
              } else if (context.expressRouterVariables.has(varName)) {
                isLocalRouter = true;
                importedFileId = fileId; // Local router in same module
                resolutionStatus = "resolved";
              }
            }

            // If we have an imported specifier, resolve module identity
            if (importedModuleSpecifier) {
              if (moduleResolver && typeof moduleResolver.resolveSpecifier === "function" && filePath) {
                const res = moduleResolver.resolveSpecifier(filePath, importedModuleSpecifier);
                if (res.status === "internal_resolved" && res.resolvedPath) {
                  importedFileId = createFileId(repository.fullName, res.resolvedPath);
                  resolutionStatus = "resolved";
                } else if (res.status === "ambiguous") {
                  resolutionStatus = "ambiguous";
                } else {
                  resolutionStatus = "unresolved";
                }
              } else {
                // Specifier identified; default to resolved or unresolved pending resolver invocation
                resolutionStatus = "resolved";
              }
            }

            if (isPrefixDynamic) {
              resolutionStatus = "dynamic_prefix";
            }

            // Filter out non-router middlewares (e.g. express.json(), cors, securityHeaders, clerkMiddleware)
            // An argument is considered a router candidate if:
            // - It has an imported module specifier (e.g. from ./routes/...)
            // - It is a known local router variable
            // - It is named with router/routes convention or explicitly imported as router
            const isRouterCandidate =
              importedModuleSpecifier !== null ||
              isLocalRouter ||
              /router|routes/i.test(routerIdentifier);

            if (isRouterCandidate) {
              mounts.push({
                id: `${fileId}#mount_${mountCounter++}`,
                fileId,
                index: mountCounter - 1,
                receiver: receiverText,
                receiverEvidence: receiverCheck.evidence,
                mountPrefix,
                isPrefixDynamic,
                rawPrefix,
                routerIdentifier,
                importedModuleSpecifier,
                importedFileId,
                isLocalRouter,
                resolutionStatus,
                location,
                prefixLocation,
                routerLocation,
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, traverse);
  }

  ts.forEachChild(sourceFile, traverse);
  return mounts;
}

/**
 * Extracts combined Express route registrations and router mount declarations from an AST.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @param {object} [options]
 * @returns {{ routes: Array<object>, mounts: Array<object> }}
 */
function extractExpressFacts(sourceFile, fileId, options = {}) {
  const context = analyzeExpressContext(sourceFile);
  const routes = extractExpressRoutes(sourceFile, fileId, { ...options, context });
  const mounts = extractExpressMounts(sourceFile, fileId, { ...options, context });

  const facts = { routes, mounts };
  expressFactStore.setFacts(fileId, facts);
  return facts;
}

module.exports = {
  EXPRESS_ROUTING_METHODS,
  expressFactStore,
  getExpressRouteFacts,
  analyzeExpressContext,
  getReceiverEvidence,
  parseRoutePath,
  extractHandlers,
  extractExpressRoutes,
  extractExpressMounts,
  extractExpressFacts,
};
