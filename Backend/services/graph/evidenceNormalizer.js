/**
 * Cartograph Unified Evidence Normalizer.
 *
 * Normalizes disparate syntactic evidence and resolver outputs across JavaScript/TypeScript,
 * Python, Java, and C/C++ into a uniform, lossless evidence contract.
 *
 * Preserves resolver provenance, exact original statuses, candidate target sets,
 * source locations, and language-specific metadata without ever promoting unconfirmed,
 * unresolved, ambiguous, dynamic, unsupported, or external dependencies into confirmed internal edges.
 */

const NORMALIZED_STATUSES = Object.freeze({
  RESOLVED: "resolved",
  EXTERNAL_PACKAGE: "external_package",
  STANDARD_LIBRARY: "standard_library",
  AMBIGUOUS: "ambiguous",
  UNRESOLVED: "unresolved",
  UNSUPPORTED: "unsupported",
  DYNAMIC: "dynamic",
  WILDCARD: "wildcard",
  UNCONFIRMED: "unconfirmed",
});

/**
 * Maps resolver-specific status strings to unified normalized statuses.
 *
 * @param {string} originalStatus
 * @returns {string}
 */
function mapToNormalizedStatus(originalStatus) {
  switch (originalStatus) {
    case "internal_resolved":
      return NORMALIZED_STATUSES.RESOLVED;
    case "external_package":
      return NORMALIZED_STATUSES.EXTERNAL_PACKAGE;
    case "builtin":
    case "standard_library":
      return NORMALIZED_STATUSES.STANDARD_LIBRARY;
    case "ambiguous":
      return NORMALIZED_STATUSES.AMBIGUOUS;
    case "dynamic":
      return NORMALIZED_STATUSES.DYNAMIC;
    case "unsupported":
      return NORMALIZED_STATUSES.UNSUPPORTED;
    case "wildcard":
      return NORMALIZED_STATUSES.WILDCARD;
    case "unresolved":
    default:
      return NORMALIZED_STATUSES.UNRESOLVED;
  }
}

/**
 * Normalizes a single module import or C/C++ include resolution.
 *
 * Works with outputs from:
 * - JavaScriptModuleResolver
 * - PythonImportResolver
 * - JavaImportResolver
 * - CppIncludeResolver
 *
 * @param {object} resolution - The raw resolution object from the resolver
 * @param {object} [context]
 * @param {string} [context.resolverName] - Resolver name (e.g. "CppIncludeResolver")
 * @param {string} [context.resolverVersion="1.0.0"] - Resolver version
 * @param {string} [context.sourceFile] - Fallback source file path if not present in evidence
 * @returns {object} Normalized evidence contract
 */
function normalizeImportResolution(resolution, context = {}) {
  if (!resolution || typeof resolution !== "object") {
    throw new Error("normalizeImportResolution requires a valid resolution object");
  }

  const rawEvidence = resolution.evidence || {};
  const sourceFile = rawEvidence.sourceFile || resolution.sourceFile || context.sourceFile || null;
  const sourceLocation = rawEvidence.location || resolution.location || null;
  const resolverName = context.resolverName || rawEvidence.resolverName || "unknown_resolver";
  const resolverVersion = context.resolverVersion || rawEvidence.resolverVersion || "1.0.0";
  const rule = resolution.rule || rawEvidence.rule || "unknown_rule";
  const originalStatus = resolution.status || "unresolved";

  const normalizedStatus = mapToNormalizedStatus(originalStatus);

  // Strict confirmation constraint:
  // ONLY internal_resolved with a non-empty resolvedPath is a confirmed internal edge.
  // Unresolved, ambiguous, dynamic, unsupported, external, and standard library are NEVER confirmed.
  const isConfirmed = originalStatus === "internal_resolved" && typeof resolution.resolvedPath === "string" && resolution.resolvedPath.length > 0;

  // Confidence determination
  let confidence = "none";
  if (isConfirmed) {
    confidence = "high";
  } else if (normalizedStatus === NORMALIZED_STATUSES.AMBIGUOUS) {
    confidence = "low";
  } else if (
    normalizedStatus === NORMALIZED_STATUSES.EXTERNAL_PACKAGE ||
    normalizedStatus === NORMALIZED_STATUSES.STANDARD_LIBRARY
  ) {
    confidence = "medium";
  }

  // Preserve language-specific metadata without loss
  const languageMetadata = { ...rawEvidence };
  delete languageMetadata.sourceFile;
  delete languageMetadata.location;
  delete languageMetadata.resolverVersion;
  delete languageMetadata.resolverName;
  delete languageMetadata.rule;

  // Add any resolution-level language extras
  if (resolution.category !== undefined) languageMetadata.category = resolution.category;
  if (resolution.stubPath !== undefined) languageMetadata.stubPath = resolution.stubPath;
  if (resolution.isStatic !== undefined) languageMetadata.isStatic = resolution.isStatic;
  if (resolution.isWildcard !== undefined) languageMetadata.isWildcard = resolution.isWildcard;

  // Normalization ID
  const factId = resolution.id || (resolution.type ? `${resolution.type}_fact` : "dep_fact");

  return {
    id: `ev_${factId}`,
    category: "dependency",
    sourceFile,
    sourceFactId: factId,
    sourceLocation,
    resolver: {
      name: resolverName,
      version: resolverVersion,
      rule,
    },
    status: {
      original: originalStatus,
      normalized: normalizedStatus,
      isConfirmed,
      confidence,
    },
    target: {
      resolvedPath: resolution.resolvedPath || null,
      resolvedSymbolId: resolution.resolvedSymbolId || null,
      resolvedSymbolName: resolution.resolvedSymbolName || null,
      packageName: resolution.packageName || null,
      rawSpecifier: resolution.rawSource || resolution.target || null,
      candidates: Array.isArray(resolution.candidates) ? [...resolution.candidates] : null,
    },
    languageMetadata,
  };
}

/**
 * Normalizes a call site fact from FileIR without speculative resolution.
 * Confirmed call relationships require sufficiently strong and unique evidence;
 * lexical matching alone is unconfirmed.
 *
 * @param {object} callFact - Call fact from FileIR
 * @param {string} sourceFile - Repository-relative path of source file
 * @param {object} [context]
 * @returns {object} Normalized evidence contract
 */
function normalizeCallFact(callFact, sourceFile, context = {}) {
  if (!callFact || typeof callFact !== "object") {
    throw new Error("normalizeCallFact requires a valid callFact object");
  }

  const factId = callFact.id || "call_fact";
  const callee = callFact.callee || (callFact.target ? callFact.target.name : null) || "unknown";

  const languageMetadata = { ...(callFact.languageMetadata || {}) };
  if (callFact.enclosingSymbolId !== undefined) {
    languageMetadata.enclosingSymbolId = callFact.enclosingSymbolId;
  }
  if (callFact.argumentsCount !== undefined) {
    languageMetadata.argumentsCount = callFact.argumentsCount;
  }
  if (callFact.typeArguments !== undefined) {
    languageMetadata.typeArguments = callFact.typeArguments;
  }

  // Gate 10B constraint: Do NOT implement speculative call resolution.
  // Preserves call-site facts and marks confirmed: false.
  return {
    id: `ev_${factId}`,
    category: "call",
    sourceFile: sourceFile || context.sourceFile || null,
    sourceFactId: factId,
    sourceLocation: callFact.location || null,
    resolver: {
      name: context.resolverName || "FileIRCallExtractor",
      version: context.resolverVersion || "1.0.0",
      rule: "lexical_call_site",
    },
    status: {
      original: "unresolved",
      normalized: NORMALIZED_STATUSES.UNCONFIRMED,
      isConfirmed: false,
      confidence: "none",
    },
    target: {
      resolvedPath: null,
      resolvedSymbolId: null,
      resolvedSymbolName: null,
      packageName: null,
      rawSpecifier: callee,
      candidates: Array.isArray(callFact.candidates) ? [...callFact.candidates] : null,
    },
    languageMetadata,
  };
}

/**
 * Normalizes an inheritance/heritage fact from FileIR.
 *
 * @param {object} heritageFact
 * @param {string} sourceFile
 * @param {object} [context]
 * @returns {object} Normalized evidence contract
 */
function normalizeInheritanceFact(heritageFact, sourceFile, context = {}) {
  if (!heritageFact || typeof heritageFact !== "object") {
    throw new Error("normalizeInheritanceFact requires a valid heritageFact object");
  }

  const factId = heritageFact.id || "heritage_fact";
  const targetName = heritageFact.targetName || heritageFact.name || "unknown";
  const isConfirmed = Boolean(heritageFact.resolvedSymbolId);

  return {
    id: `ev_${factId}`,
    category: "inheritance",
    sourceFile: sourceFile || context.sourceFile || null,
    sourceFactId: factId,
    sourceLocation: heritageFact.location || null,
    resolver: {
      name: context.resolverName || "FileIRHeritageExtractor",
      version: context.resolverVersion || "1.0.0",
      rule: heritageFact.rule || "heritage_clause",
    },
    status: {
      original: isConfirmed ? "internal_resolved" : "unresolved",
      normalized: isConfirmed ? NORMALIZED_STATUSES.RESOLVED : NORMALIZED_STATUSES.UNCONFIRMED,
      isConfirmed,
      confidence: isConfirmed ? "high" : "none",
    },
    target: {
      resolvedPath: heritageFact.resolvedPath || null,
      resolvedSymbolId: heritageFact.resolvedSymbolId || null,
      resolvedSymbolName: targetName,
      packageName: heritageFact.packageName || null,
      rawSpecifier: targetName,
      candidates: Array.isArray(heritageFact.candidates) ? [...heritageFact.candidates] : null,
    },
    languageMetadata: { ...(heritageFact.languageMetadata || {}) },
  };
}

/**
 * Normalizes an HTTP route resolution from HttpRouteResolver.
 *
 * Distinguishes confirmed_exact, pattern_compatible, ambiguous, unresolved,
 * unsupported, and external classifications without ever promoting unconfirmed
 * or external dependencies into confirmed internal edges.
 *
 * @param {object} resolution - Resolution output from HttpRouteResolver
 * @param {object} [context]
 * @param {string} [context.resolverName="HttpRouteResolver"]
 * @param {string} [context.resolverVersion="1.0.0"]
 * @param {string} [context.sourceFile]
 * @returns {object} Normalized evidence contract
 */
function normalizeHttpResolution(resolution, context = {}) {
  if (!resolution || typeof resolution !== "object") {
    throw new Error("normalizeHttpResolution requires a valid resolution object");
  }

  const clientFactId = resolution.clientFactId || resolution.id || "http_fact";
  const rawClientFile = resolution.clientFileId || null;
  const rawBackendFile = resolution.backendFileId || null;

  // Resolve repository-relative paths for client and backend files
  const fileIdToPath = context.fileIdToPathMap || context.filePathMap || null;

  const resolveToRelativePath = (rawVal, explicitPath) => {
    if (explicitPath && typeof explicitPath === "string" && !explicitPath.startsWith("file_")) {
      return explicitPath;
    }
    if (!rawVal || typeof rawVal !== "string") return null;

    // 1. Try lookup via fileIdToPathMap
    if (fileIdToPath) {
      if (typeof fileIdToPath.get === "function" && fileIdToPath.has(rawVal)) {
        return fileIdToPath.get(rawVal);
      }
      if (typeof fileIdToPath === "object" && fileIdToPath[rawVal]) {
        return fileIdToPath[rawVal];
      }
    }

    // 2. If it's already a clean relative path (not starting with "file_")
    if (!rawVal.startsWith("file_") && (rawVal.includes("/") || /\.[a-zA-Z0-9]+$/.test(rawVal))) {
      return rawVal;
    }

    return null;
  };

  const clientFilePath = resolveToRelativePath(
    rawClientFile,
    resolution.clientPath || resolution.clientFilePath || context.sourceFile || context.clientPath
  );
  const backendFilePath = resolveToRelativePath(
    rawBackendFile,
    resolution.backendPath || resolution.backendFilePath || context.targetFile || context.backendPath
  );

  const sourceLocation = resolution.clientLocation || resolution.location || null;
  const classification = resolution.classification || "unresolved";

  // A confirmed HTTP edge REQUIRES valid repository-relative file paths for both endpoints.
  // Never promote to confirmed if either endpoint cannot be mapped to a repository-relative path.
  const hasValidRelativePaths =
    typeof clientFilePath === "string" && clientFilePath.length > 0 &&
    typeof backendFilePath === "string" && backendFilePath.length > 0;

  const isConfirmed =
    (classification === "confirmed_exact" || classification === "pattern_compatible") &&
    hasValidRelativePaths;

  let confidence = "none";
  if (isConfirmed && classification === "confirmed_exact") {
    confidence = "high";
  } else if (isConfirmed && classification === "pattern_compatible") {
    confidence = "medium";
  } else if (classification === "ambiguous") {
    confidence = "low";
  }

  let normalizedStatus = NORMALIZED_STATUSES.UNRESOLVED;
  if (isConfirmed) {
    normalizedStatus = NORMALIZED_STATUSES.RESOLVED;
  } else if (classification === "ambiguous") {
    normalizedStatus = NORMALIZED_STATUSES.AMBIGUOUS;
  } else if (classification === "external") {
    normalizedStatus = NORMALIZED_STATUSES.EXTERNAL_PACKAGE;
  } else if (classification === "unsupported") {
    normalizedStatus = NORMALIZED_STATUSES.UNSUPPORTED;
  }

  const factId = resolution.id || `${clientFactId}_resolution`;
  const resolverName = context.resolverName || "HttpRouteResolver";
  const resolverVersion = context.resolverVersion || resolution.resolverVersion || "1.0.0";
  const rule = resolution.resolutionRule || "route_matching";

  return {
    id: `ev_${factId}`,
    category: "http_request",
    sourceFile: clientFilePath,
    sourceFactId: clientFactId,
    sourceLocation,
    resolver: {
      name: resolverName,
      version: resolverVersion,
      rule,
    },
    status: {
      original: classification,
      normalized: normalizedStatus,
      isConfirmed,
      confidence,
      classification,
    },
    target: {
      resolvedPath: backendFilePath,
      clientFileId: rawClientFile,
      backendFileId: rawBackendFile,
      httpMethod: resolution.httpMethod || "GET",
      composedRoutePath: resolution.composedRoutePath || null,
      originalRoutePath: resolution.originalRoutePath || null,
      rawSpecifier: resolution.rawClientEndpoint || null,
      clientPattern: resolution.normalizedClientPattern || null,
      backendRouteFactId: resolution.backendRouteFactId || null,
      backendLocation: resolution.backendLocation || null,
      mountChain: Array.isArray(resolution.mountChain) ? [...resolution.mountChain] : [],
      candidates: Array.isArray(resolution.candidates) ? [...resolution.candidates] : null,
    },
    metadata: {
      classification,
      isPatternCompatible: classification === "pattern_compatible",
      clientFileId: rawClientFile,
      backendFileId: rawBackendFile,
      clientPath: clientFilePath,
      backendPath: backendFilePath,
      httpMethod: resolution.httpMethod || "GET",
      composedRoutePath: resolution.composedRoutePath || null,
      originalRoutePath: resolution.originalRoutePath || null,
      mountChain: Array.isArray(resolution.mountChain) ? [...resolution.mountChain] : [],
      backendRouteFactId: resolution.backendRouteFactId || null,
      backendLocation: resolution.backendLocation || null,
    },
  };
}

/**
 * Batch-normalizes resolver repository output or an array of resolution items.
 *
 * @param {object|Array<object>} resolverOutput - { files: [...], summary: {...} } or Array of resolutions
 * @param {object} [context]
 * @param {string} [context.resolverName]
 * @param {string} [context.resolverVersion]
 * @returns {Array<object>} Array of normalized evidence objects
 */
function normalizeResolverResults(resolverOutput, context = {}) {
  const normalized = [];

  if (!resolverOutput) return normalized;

  // Handle { files: [ { file, resolutions: [...] } ] } or { files: [ { resolutions: [...] } ], fileResolutions: [...] }
  const fileList = resolverOutput.files || resolverOutput.fileResolutions;
  if (Array.isArray(fileList)) {
    for (const fileItem of fileList) {
      const sourceFile = fileItem.file || fileItem.sourceFile || null;
      const resolutions = fileItem.resolutions || [];
      for (const res of resolutions) {
        normalized.push(normalizeImportResolution(res, { ...context, sourceFile }));
      }
    }
    return normalized;
  }

  // Handle flat array of resolution objects
  if (Array.isArray(resolverOutput)) {
    for (const res of resolverOutput) {
      normalized.push(normalizeImportResolution(res, context));
    }
    return normalized;
  }

  // Handle single resolution object
  if (typeof resolverOutput === "object") {
    normalized.push(normalizeImportResolution(resolverOutput, context));
  }

  return normalized;
}

module.exports = {
  NORMALIZED_STATUSES,
  mapToNormalizedStatus,
  normalizeImportResolution,
  normalizeCallFact,
  normalizeInheritanceFact,
  normalizeHttpResolution,
  normalizeResolverResults,
};

