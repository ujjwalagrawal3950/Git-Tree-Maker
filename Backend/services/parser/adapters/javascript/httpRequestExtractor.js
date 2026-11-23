const ts = require("typescript");
const { createLocation } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Callable/container symbol kinds capable of enclosing an HTTP call site.
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
 * Supported Axios direct HTTP methods.
 */
const AXIOS_HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
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
 * Extracts string value from a StringLiteral or NoSubstitutionTemplateLiteral.
 *
 * @param {import("typescript").Node} node
 * @returns {string|null}
 */
function getStringLiteralValue(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

/**
 * Normalizes HTTP method string to uppercase. Defaults to "GET".
 *
 * @param {string} [methodStr]
 * @returns {string}
 */
function normalizeHttpMethod(methodStr) {
  if (!methodStr || typeof methodStr !== "string") return "GET";
  return methodStr.trim().toUpperCase();
}

/**
 * Extracts property initializer by property name from an ObjectLiteralExpression.
 *
 * @param {import("typescript").ObjectLiteralExpression} objectLiteral
 * @param {string} propName
 * @returns {import("typescript").Expression|null}
 */
function getObjectProperty(objectLiteral, propName) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return null;
  const target = propName.toLowerCase();
  for (const prop of objectLiteral.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      let nameStr = null;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        nameStr = name.text;
      }
      if (nameStr && nameStr.toLowerCase() === target) {
        return prop.initializer;
      }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text.toLowerCase() === target) {
        return prop.name;
      }
    }
  }
  return null;
}

/**
 * Flattens binary plus (+) expressions into constituent AST operands.
 *
 * @param {import("typescript").Node} node
 * @returns {Array<import("typescript").Node>}
 */
function flattenBinaryPlus(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...flattenBinaryPlus(node.left), ...flattenBinaryPlus(node.right)];
  }
  return [node];
}

/**
 * Analyzes an AST expression serving as an HTTP URL and extracts structured path/template facts.
 *
 * @param {import("typescript").Expression|null} urlNode
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {{
 *   rawUrl: string,
 *   url: string|null,
 *   staticPath: string|null,
 *   isDynamic: boolean,
 *   dynamicParts: string[],
 *   template: string|null,
 *   isExternal: boolean
 * }}
 */
function parseUrlNode(urlNode, sourceFile) {
  if (!urlNode) {
    return {
      rawUrl: "",
      url: null,
      staticPath: null,
      isDynamic: true,
      dynamicParts: [],
      template: null,
      isExternal: false,
    };
  }

  const rawUrl = urlNode.getText(sourceFile);

  // 1. Static String Literal or No-Substitution Template (`...`)
  const literalVal = getStringLiteralValue(urlNode);
  if (literalVal !== null) {
    const isExternal = /^https?:\/\//i.test(literalVal);
    let staticPath = literalVal;
    try {
      if (isExternal) {
        const u = new URL(literalVal);
        staticPath = u.pathname;
      } else {
        const u = new URL(literalVal, "http://localhost");
        staticPath = u.pathname;
      }
    } catch {
      staticPath = literalVal.split("?")[0].split("#")[0];
    }
    return {
      rawUrl,
      url: literalVal,
      staticPath,
      isDynamic: false,
      dynamicParts: [],
      template: staticPath,
      isExternal,
    };
  }

  // 2. Template Expression: `...${...}...`
  if (ts.isTemplateExpression(urlNode)) {
    const dynamicParts = [];
    let templatePattern = urlNode.head.text;

    for (const span of urlNode.templateSpans) {
      const exprText = span.expression.getText(sourceFile).trim();
      dynamicParts.push(exprText);
      const paramName = ts.isIdentifier(span.expression) ? span.expression.text : "param";
      templatePattern += `:${paramName}${span.literal.text}`;
    }

    // Strip trailing query parameters or fragment from template for route matching
    const cleanTemplate = templatePattern.split("?")[0].split("#")[0];
    const isExternal = /^https?:\/\//i.test(templatePattern) ||
      dynamicParts.some((p) => /base_?url|host|origin/i.test(p));

    return {
      rawUrl,
      url: null,
      staticPath: null, // Dynamic template cannot be statically proven as exact path
      isDynamic: true,
      dynamicParts,
      template: cleanTemplate,
      isExternal,
    };
  }

  // 3. Binary Expression (+ concatenation)
  if (ts.isBinaryExpression(urlNode) && urlNode.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts = flattenBinaryPlus(urlNode);
    const dynamicParts = [];
    let isAllStatic = true;
    let templatePattern = "";
    let combinedStatic = "";

    for (const part of parts) {
      const partVal = getStringLiteralValue(part);
      if (partVal !== null) {
        combinedStatic += partVal;
        templatePattern += partVal;
      } else {
        isAllStatic = false;
        const partText = part.getText(sourceFile).trim();
        dynamicParts.push(partText);
        const paramName = ts.isIdentifier(part) ? part.text : "param";
        templatePattern += `:${paramName}`;
      }
    }

    if (isAllStatic) {
      const isExternal = /^https?:\/\//i.test(combinedStatic);
      let staticPath = combinedStatic;
      try {
        if (isExternal) {
          const u = new URL(combinedStatic);
          staticPath = u.pathname;
        } else {
          const u = new URL(combinedStatic, "http://localhost");
          staticPath = u.pathname;
        }
      } catch {
        staticPath = combinedStatic.split("?")[0].split("#")[0];
      }
      return {
        rawUrl,
        url: combinedStatic,
        staticPath,
        isDynamic: false,
        dynamicParts: [],
        template: staticPath,
        isExternal,
      };
    }

    const cleanTemplate = templatePattern.split("?")[0].split("#")[0];
    const isExternal = /^https?:\/\//i.test(templatePattern) ||
      dynamicParts.some((p) => /base_?url|host|origin/i.test(p));

    return {
      rawUrl,
      url: null,
      staticPath: null,
      isDynamic: true,
      dynamicParts,
      template: cleanTemplate,
      isExternal,
    };
  }

  // 4. Other dynamic expression (Identifier, CallExpression, PropertyAccess, etc.)
  const exprText = rawUrl.trim();
  const isExternal = /base_?url|host|origin/i.test(exprText);
  return {
    rawUrl,
    url: null,
    staticPath: null,
    isDynamic: true,
    dynamicParts: [exprText],
    template: null,
    isExternal,
  };
}

/**
 * Recognizes if a call expression node is an HTTP client invocation (`fetch`, `axios`).
 *
 * @param {import("typescript").CallExpression} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {object|null} Matched invocation details or null if not an HTTP call
 */
function matchHttpClientCall(node, sourceFile) {
  if (!ts.isCallExpression(node)) return null;

  const expr = node.expression;
  const args = node.arguments;

  // Helper for fetch method extraction from options object
  function extractFetchMethod(optionsArg) {
    if (!optionsArg) return { method: "GET", isMethodDynamic: false, rawMethod: null };
    if (ts.isObjectLiteralExpression(optionsArg)) {
      const methodInit = getObjectProperty(optionsArg, "method");
      if (methodInit) {
        const val = getStringLiteralValue(methodInit);
        if (val !== null) {
          return { method: normalizeHttpMethod(val), isMethodDynamic: false, rawMethod: null };
        }
        return {
          method: "DYNAMIC",
          isMethodDynamic: true,
          rawMethod: methodInit.getText(sourceFile),
        };
      }
      return { method: "GET", isMethodDynamic: false, rawMethod: null };
    }
    return {
      method: "DYNAMIC",
      isMethodDynamic: true,
      rawMethod: optionsArg.getText(sourceFile),
    };
  }

  // 1. fetch(url, options) or window.fetch / globalThis.fetch
  let isFetch = false;
  if (ts.isIdentifier(expr) && expr.text === "fetch") {
    isFetch = true;
  } else if (ts.isPropertyAccessExpression(expr) && expr.name.text === "fetch") {
    const parentText = expr.expression.getText(sourceFile);
    if (parentText === "window" || parentText === "globalThis") {
      isFetch = true;
    }
  }

  if (isFetch) {
    if (args.length === 0) return null;
    const urlNode = args[0];
    const optionsArg = args[1] || null;
    const methodInfo = extractFetchMethod(optionsArg);
    return {
      clientType: "fetch",
      clientMethod: "fetch",
      urlNode,
      ...methodInfo,
    };
  }

  // 2. axios.get / post / put / patch / delete / head / options
  if (ts.isPropertyAccessExpression(expr)) {
    const methodName = expr.name.text.toLowerCase();
    const callerText = expr.expression.getText(sourceFile);
    const isAxiosCaller =
      callerText === "axios" ||
      callerText === "window.axios" ||
      callerText.endsWith(".axios");

    if (isAxiosCaller && AXIOS_HTTP_METHODS.has(methodName)) {
      if (args.length === 0) return null;
      const urlNode = args[0];
      return {
        clientType: "axios",
        clientMethod: `axios.${methodName}`,
        urlNode,
        method: methodName.toUpperCase(),
        isMethodDynamic: false,
        rawMethod: null,
      };
    }

    // axios.request(config)
    if (isAxiosCaller && methodName === "request") {
      if (args.length === 0) return null;
      if (ts.isObjectLiteralExpression(args[0])) {
        const urlInit = getObjectProperty(args[0], "url");
        const methodInit = getObjectProperty(args[0], "method");
        let method = "GET";
        let isMethodDynamic = false;
        let rawMethod = null;
        if (methodInit) {
          const mVal = getStringLiteralValue(methodInit);
          if (mVal !== null) {
            method = normalizeHttpMethod(mVal);
          } else {
            method = "DYNAMIC";
            isMethodDynamic = true;
            rawMethod = methodInit.getText(sourceFile);
          }
        }
        return {
          clientType: "axios",
          clientMethod: "axios.request",
          urlNode: urlInit,
          method,
          isMethodDynamic,
          rawMethod,
        };
      }
    }
  }

  // 3. axios(config) or axios(url, config)
  const isDirectAxios =
    (ts.isIdentifier(expr) && expr.text === "axios") ||
    (ts.isPropertyAccessExpression(expr) &&
      expr.expression.getText(sourceFile) === "window" &&
      expr.name.text === "axios");

  if (isDirectAxios && args.length >= 1) {
    // axios({ url: '...', method: '...' })
    if (ts.isObjectLiteralExpression(args[0])) {
      const urlInit = getObjectProperty(args[0], "url");
      const methodInit = getObjectProperty(args[0], "method");
      let method = "GET";
      let isMethodDynamic = false;
      let rawMethod = null;
      if (methodInit) {
        const mVal = getStringLiteralValue(methodInit);
        if (mVal !== null) {
          method = normalizeHttpMethod(mVal);
        } else {
          method = "DYNAMIC";
          isMethodDynamic = true;
          rawMethod = methodInit.getText(sourceFile);
        }
      }
      return {
        clientType: "axios",
        clientMethod: "axios()",
        urlNode: urlInit,
        method,
        isMethodDynamic,
        rawMethod,
      };
    }

    // axios(url, { method: '...' })
    const urlNode = args[0];
    const configArg = args[1];
    let method = "GET";
    let isMethodDynamic = false;
    let rawMethod = null;
    if (configArg && ts.isObjectLiteralExpression(configArg)) {
      const methodInit = getObjectProperty(configArg, "method");
      if (methodInit) {
        const mVal = getStringLiteralValue(methodInit);
        if (mVal !== null) {
          method = normalizeHttpMethod(mVal);
        } else {
          method = "DYNAMIC";
          isMethodDynamic = true;
          rawMethod = methodInit.getText(sourceFile);
        }
      }
    }
    return {
      clientType: "axios",
      clientMethod: "axios()",
      urlNode,
      method,
      isMethodDynamic,
      rawMethod,
    };
  }

  return null;
}

/**
 * Extracts structured frontend HTTP request facts from a TypeScript SourceFile AST.
 *
 * Supported Patterns:
 * - fetch(url)
 * - fetch(url, { method: 'POST' })
 * - axios.get(url)
 * - axios.post(url, data)
 * - axios.put(url, data)
 * - axios.patch(url, data)
 * - axios.delete(url)
 * - axios.head(url)
 * - axios.options(url)
 * - axios({ method: 'POST', url: '/api/users' })
 * - axios(url, { method: 'POST' })
 * - axios.request({ url: '/api/users', method: 'DELETE' })
 * - window.fetch(url, ...)
 *
 * Preserves existing FileIR v1.0.0 contracts by returning an auxiliary HTTP-facts structure
 * associated with fileId, source locations, and enclosing symbols.
 *
 * @param {import("typescript").SourceFile} sourceFile - TypeScript AST SourceFile
 * @param {string} fileId - Deterministic file identity
 * @param {Array<object>} [symbols] - Optional pre-extracted symbol records for enclosingSymbolId
 * @returns {Array<object>} Normalized HTTP request facts
 */
function extractHttpRequests(sourceFile, fileId, symbols = []) {
  if (!sourceFile) return [];

  const httpRequests = [];
  let requestCounter = 0;

  function traverse(node) {
    if (!node) return;

    if (ts.isCallExpression(node)) {
      const match = matchHttpClientCall(node, sourceFile);
      if (match) {
        const location = mapNodeLocation(sourceFile, node);
        const enclosingSymbolId = findEnclosingSymbolId(location.start, symbols);
        const urlInfo = parseUrlNode(match.urlNode, sourceFile);
        const urlLocation = match.urlNode ? mapNodeLocation(sourceFile, match.urlNode) : null;

        httpRequests.push({
          id: `${fileId}#http_${requestCounter++}`,
          fileId,
          index: requestCounter - 1,
          clientType: match.clientType,
          clientMethod: match.clientMethod,
          method: match.method,
          isMethodDynamic: match.isMethodDynamic,
          rawMethod: match.rawMethod,
          url: urlInfo.url,
          rawUrl: urlInfo.rawUrl,
          staticPath: urlInfo.staticPath,
          isDynamic: urlInfo.isDynamic,
          dynamicParts: urlInfo.dynamicParts,
          template: urlInfo.template,
          isExternal: urlInfo.isExternal,
          location,
          urlLocation,
          enclosingSymbolId,
          resolutionStatus: "extracted",
        });
      }
    }

    ts.forEachChild(node, traverse);
  }

  ts.forEachChild(sourceFile, traverse);
  return httpRequests;
}

module.exports = {
  extractHttpRequests,
  matchHttpClientCall,
  parseUrlNode,
  getStringLiteralValue,
  normalizeHttpMethod,
  getObjectProperty,
  flattenBinaryPlus,
};
