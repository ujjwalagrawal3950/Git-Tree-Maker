/**
 * Cartograph HTTP Route Resolver (Stage 3).
 * Statically resolves and connects frontend HTTP client request facts (Stage 1)
 * with backend Express route registrations and mounting hierarchies (Stage 2).
 *
 * Adheres strictly to Cartograph dynamic route extraction specifications:
 * - Does not modify FileIR v1.0.0.
 * - Does not create canonical graph edges or mutate graph schemas.
 * - Produces deterministic, traceable resolution facts with explicit certainty classifications:
 *   confirmed_exact | pattern_compatible | ambiguous | unresolved | unsupported | external.
 */

const RESOLVER_VERSION = "1.0.0";

/**
 * Standard supported HTTP methods.
 */
const SUPPORTED_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Normalizes a URL pathname:
 * - Strips query parameters (?...) and hash fragments (#...)
 * - Strips trailing slashes (unless root "/")
 * - Ensures leading slash
 *
 * @param {string|null} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p || typeof p !== "string") return "/";
  let clean = p.trim().split("?")[0].split("#")[0];
  if (!clean.startsWith("/")) clean = `/${clean}`;
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean;
}

/**
 * Joins path segments cleanly without duplicate or missing slashes.
 *
 * @param {string|null} prefix
 * @param {string|null} path
 * @returns {string|null}
 */
function joinPaths(prefix, path) {
  if (prefix === null || path === null) return null;
  const cleanPrefix = normalizePath(prefix);
  const cleanPath = normalizePath(path);
  if (cleanPrefix === "/") return cleanPath;
  if (cleanPath === "/") return cleanPrefix;
  return `${cleanPrefix}${cleanPath}`;
}

/**
 * Splits a path into non-empty segments.
 *
 * @param {string|null} pathStr
 * @returns {string[]}
 */
function splitSegments(pathStr) {
  if (!pathStr || typeof pathStr !== "string") return [];
  const clean = normalizePath(pathStr);
  if (clean === "/") return [];
  return clean.slice(1).split("/");
}

/**
 * Checks whether a client request path or pattern structurally matches a composed backend route.
 *
 * Supported Structural Rules:
 * - Literal match: "users" === "users" (case-insensitive)
 * - Backend parameter token: ":id" or ":userId" matches any non-empty client segment
 * - Frontend parameter token: ":param" or ":userId" matches any backend segment
 * - Frontend base URL placeholder token (e.g. ":API_BASE_URL") is stripped from prefix for route matching
 *
 * @param {string} clientPattern - Client path or reconstructed template (e.g. "/api/users/:userId")
 * @param {string} backendComposedPath - Composed backend route path (e.g. "/api/users/:id")
 * @returns {boolean}
 */
function matchPathStructural(clientPattern, backendComposedPath) {
  if (!clientPattern || !backendComposedPath) return false;

  let clientSegments = splitSegments(clientPattern);
  const backendSegments = splitSegments(backendComposedPath);

  // If client pattern begins with a variable base URL token (e.g. ":API_BASE_URL/api/...")
  if (
    clientSegments.length > 0 &&
    clientSegments[0].startsWith(":") &&
    /base|origin|host|api_?url|server_?url/i.test(clientSegments[0])
  ) {
    clientSegments.shift();
  }

  if (clientSegments.length !== backendSegments.length) {
    return false;
  }

  for (let i = 0; i < clientSegments.length; i++) {
    const cSeg = clientSegments[i];
    const bSeg = backendSegments[i];

    // Backend Express route parameter (e.g. :id, :userId, :repositoryId)
    if (bSeg.startsWith(":")) {
      continue;
    }

    // Client dynamic placeholder (e.g. :userId, :param)
    if (cSeg.startsWith(":")) {
      continue;
    }

    // Exact literal segment match (case-insensitive)
    if (cSeg.toLowerCase() !== bSeg.toLowerCase()) {
      return false;
    }
  }

  return true;
}

/**
 * Traverses mounting hierarchies to compute all fully qualified composed routes.
 * Handles nested router mounts across files, multiple mounts of the same router,
 * dynamic prefixes, and circular mount detection.
 *
 * @param {Array<object>} allRoutes - Extracted backend route facts
 * @param {Array<object>} allMounts - Extracted backend mount facts
 * @returns {Array<object>} Composed backend route records
 */
function composeBackendRoutes(allRoutes = [], allMounts = []) {
  // Index incoming mounts: targetFileId -> mounts[]
  const incomingByTargetFile = new Map();
  // Index local mounts: fileId -> Map<routerIdentifier, mounts[]>
  const localMountsByFile = new Map();

  for (const m of allMounts) {
    if (m.isLocalRouter) {
      if (!localMountsByFile.has(m.fileId)) {
        localMountsByFile.set(m.fileId, new Map());
      }
      const fileMap = localMountsByFile.get(m.fileId);
      if (!fileMap.has(m.routerIdentifier)) {
        fileMap.set(m.routerIdentifier, []);
      }
      fileMap.get(m.routerIdentifier).push(m);
    } else if (m.importedFileId) {
      if (!incomingByTargetFile.has(m.importedFileId)) {
        incomingByTargetFile.set(m.importedFileId, []);
      }
      incomingByTargetFile.get(m.importedFileId).push(m);
    }
  }

  /**
   * Recursively discovers all mount chains from root receivers to (fileId, receiver).
   * Guarded against circular references.
   *
   * @param {string} fileId
   * @param {string} receiver
   * @param {Set<string>} [visited]
   * @returns {Array<Array<object>>}
   */
  function getMountChains(fileId, receiver, visited = new Set()) {
    const visitKey = `${fileId}:${receiver}`;
    if (visited.has(visitKey)) {
      // Circular router mounting detected: terminate recursion safely
      return [];
    }

    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    const incomingMounts = [];

    // 1. Local router mounted within same file
    if (localMountsByFile.has(fileId)) {
      const fileLocal = localMountsByFile.get(fileId);
      if (fileLocal.has(receiver)) {
        incomingMounts.push(...fileLocal.get(receiver));
      }
    }

    // 2. Router file imported and mounted by parent modules
    if (incomingByTargetFile.has(fileId)) {
      incomingMounts.push(...incomingByTargetFile.get(fileId));
    }

    // Root receiver (e.g. app instance or unmounted router)
    if (incomingMounts.length === 0) {
      return [[]]; // Base chain with 0 mounts
    }

    const chains = [];
    for (const mount of incomingMounts) {
      const parentChains = getMountChains(mount.fileId, mount.receiver, nextVisited);
      for (const pc of parentChains) {
        chains.push([...pc, mount]);
      }
    }

    return chains.length > 0 ? chains : [[]];
  }

  const composedRoutes = [];

  for (const route of allRoutes) {
    const chains = getMountChains(route.fileId, route.receiver);

    for (const chain of chains) {
      let composedPath = route.routePath;
      let isComposedDynamic = route.isDynamic;
      let hasDynamicPrefix = false;
      let mountPrefix = "";

      for (const m of chain) {
        if (m.mountPrefix) {
          mountPrefix = joinPaths(mountPrefix, m.mountPrefix);
        } else if (m.isPrefixDynamic) {
          hasDynamicPrefix = true;
          isComposedDynamic = true;
          composedPath = null;
        }
      }

      if (composedPath !== null && !hasDynamicPrefix) {
        composedPath = joinPaths(mountPrefix, composedPath);
      }

      composedRoutes.push({
        routeFactId: route.id,
        backendFileId: route.fileId,
        receiver: route.receiver,
        receiverEvidence: route.receiverEvidence,
        httpMethod: route.httpMethod,
        originalRoutePath: route.routePath,
        composedRoutePath: composedPath,
        rawPath: route.rawPath,
        isDynamic: isComposedDynamic,
        hasDynamicPrefix,
        dynamicParts: route.dynamicParts || [],
        pathClassification: isComposedDynamic ? "dynamic_expression" : route.pathClassification,
        handlers: route.handlers || [],
        mountChain: chain,
        location: route.location,
        pathLocation: route.pathLocation,
        enclosingSymbolId: route.enclosingSymbolId,
      });
    }
  }

  // Deterministic ordering: fileId -> routeFactId -> composedRoutePath
  composedRoutes.sort((a, b) => {
    if (a.backendFileId !== b.backendFileId) return a.backendFileId.localeCompare(b.backendFileId);
    if (a.routeFactId !== b.routeFactId) return a.routeFactId.localeCompare(b.routeFactId);
    return String(a.composedRoutePath).localeCompare(String(b.composedRoutePath));
  });

  return composedRoutes;
}

/**
 * Engine resolving frontend HTTP requests against composed backend routes.
 */
class HttpRouteResolver {
  constructor(options = {}) {
    this.resolverVersion = RESOLVER_VERSION;
    this.options = options;
  }

  /**
   * Resolves a set of extracted frontend requests against backend routes and mounts.
   *
   * @param {object} params
   * @param {Array<object>} params.clientRequests - Extracted HTTP requests from Stage 1
   * @param {Array<object>} params.backendRoutes - Extracted Express routes from Stage 2
   * @param {Array<object>} params.backendMounts - Extracted Express mounts from Stage 2
   * @returns {{
   *   resolverVersion: string,
   *   composedRoutes: Array<object>,
   *   resolutions: Array<object>,
   *   summary: { totalRequests: number, confirmedExact: number, patternCompatible: number, ambiguous: number, unresolved: number, unsupported: number, external: number }
   * }}
   */
  resolve({ clientRequests = [], backendRoutes = [], backendMounts = [] }) {
    const composedRoutes = composeBackendRoutes(backendRoutes, backendMounts);

    // Build fast lookup index by HTTP method: method -> composedRoutes[]
    // Express router.all() routes are indexed under "ALL" and considered for every method
    const routesByMethod = new Map();
    for (const m of SUPPORTED_HTTP_METHODS) {
      routesByMethod.set(m, []);
    }
    routesByMethod.set("ALL", []);

    for (const cr of composedRoutes) {
      const m = cr.httpMethod;
      if (routesByMethod.has(m)) {
        routesByMethod.get(m).push(cr);
      }
    }

    const allRoutes = routesByMethod.get("ALL") || [];

    // Sort client requests deterministically: fileId -> index
    const sortedRequests = [...clientRequests].sort((a, b) => {
      if (a.fileId !== b.fileId) return a.fileId.localeCompare(b.fileId);
      return (a.index || 0) - (b.index || 0);
    });

    const resolutions = [];
    let confirmedExact = 0;
    let patternCompatible = 0;
    let ambiguous = 0;
    let unresolved = 0;
    let unsupported = 0;
    let external = 0;

    for (const req of sortedRequests) {
      const resolution = this._resolveSingleRequest(req, routesByMethod, allRoutes);
      resolutions.push(resolution);

      switch (resolution.classification) {
        case "confirmed_exact":
          confirmedExact++;
          break;
        case "pattern_compatible":
          patternCompatible++;
          break;
        case "ambiguous":
          ambiguous++;
          break;
        case "unresolved":
          unresolved++;
          break;
        case "unsupported":
          unsupported++;
          break;
        case "external":
          external++;
          break;
      }
    }

    return {
      resolverVersion: this.resolverVersion,
      composedRoutes,
      resolutions,
      summary: {
        totalRequests: sortedRequests.length,
        confirmedExact,
        patternCompatible,
        ambiguous,
        unresolved,
        unsupported,
        external,
      },
    };
  }

  /**
   * Resolves a single frontend HTTP request against the indexed composed backend routes.
   *
   * @private
   */
  _resolveSingleRequest(req, routesByMethod, allWildcardRoutes) {
    const clientFactId = req.id;
    const clientFileId = req.fileId;
    const effectiveMethod = req.method ? req.method.toUpperCase() : "GET";
    const rawEndpoint = req.rawUrl || req.url || "";
    const clientLocation = req.location || null;

    // 1. External URL Check
    if (req.isExternal) {
      return {
        id: `${clientFactId}_resolution`,
        clientFileId,
        clientFactId,
        backendFileId: null,
        backendRouteFactId: null,
        httpMethod: effectiveMethod,
        rawClientEndpoint: rawEndpoint,
        normalizedClientPattern: req.template || req.staticPath || null,
        originalRoutePath: null,
        composedRoutePath: null,
        classification: "external",
        mountChain: [],
        clientLocation,
        backendLocation: null,
        resolverVersion: this.resolverVersion,
        resolutionRule: "external_url_exclusion",
        candidates: [],
      };
    }

    // 2. Unsupported Dynamic Expression Check
    // A request where URL expression cannot be statically parsed to a path or template
    if (req.isDynamic && req.staticPath === null && req.template === null) {
      return {
        id: `${clientFactId}_resolution`,
        clientFileId,
        clientFactId,
        backendFileId: null,
        backendRouteFactId: null,
        httpMethod: effectiveMethod,
        rawClientEndpoint: rawEndpoint,
        normalizedClientPattern: null,
        originalRoutePath: null,
        composedRoutePath: null,
        classification: "unsupported",
        mountChain: [],
        clientLocation,
        backendLocation: null,
        resolverVersion: this.resolverVersion,
        resolutionRule: "unsupported_dynamic_expression",
        candidates: [],
      };
    }

    // Candidate routes for this method + wildcard routes
    const methodCandidates = routesByMethod.get(effectiveMethod) || [];
    const candidatePool = [...methodCandidates, ...allWildcardRoutes];

    // Determine normalized client lookup pattern
    const clientPattern = req.template || req.staticPath;
    const isClientStatic = !req.isDynamic && req.staticPath !== null;

    const matchedExactRoutes = [];
    const matchedPatternRoutes = [];

    for (const cr of candidatePool) {
      if (cr.composedRoutePath === null) {
        continue;
      }

      // Check Exact Literal Match
      if (isClientStatic && !cr.isDynamic && cr.pathClassification === "static") {
        if (normalizePath(req.staticPath) === normalizePath(cr.composedRoutePath)) {
          matchedExactRoutes.push(cr);
          continue;
        }
      }

      // Check Pattern-Compatible Match
      if (matchPathStructural(clientPattern, cr.composedRoutePath)) {
        matchedPatternRoutes.push(cr);
      }
    }

    // Evaluation Hierarchy:
    // A. Exact Matches
    if (matchedExactRoutes.length === 1) {
      const match = matchedExactRoutes[0];
      return {
        id: `${clientFactId}_resolution`,
        clientFileId,
        clientFactId,
        backendFileId: match.backendFileId,
        backendRouteFactId: match.routeFactId,
        httpMethod: effectiveMethod,
        rawClientEndpoint: rawEndpoint,
        normalizedClientPattern: req.staticPath,
        originalRoutePath: match.originalRoutePath,
        composedRoutePath: match.composedRoutePath,
        classification: "confirmed_exact",
        mountChain: match.mountChain,
        clientLocation,
        backendLocation: match.location || null,
        resolverVersion: this.resolverVersion,
        resolutionRule: match.httpMethod === "ALL" ? "router_all_wildcard_exact" : "exact_literal_match",
        candidates: [this._candidateSummary(match)],
      };
    }

    if (matchedExactRoutes.length > 1) {
      return {
        id: `${clientFactId}_resolution`,
        clientFileId,
        clientFactId,
        backendFileId: null,
        backendRouteFactId: null,
        httpMethod: effectiveMethod,
        rawClientEndpoint: rawEndpoint,
        normalizedClientPattern: req.staticPath,
        originalRoutePath: null,
        composedRoutePath: null,
        classification: "ambiguous",
        mountChain: [],
        clientLocation,
        backendLocation: null,
        resolverVersion: this.resolverVersion,
        resolutionRule: "ambiguous_multiple_exact_candidates",
        candidates: matchedExactRoutes.map(this._candidateSummary),
      };
    }

    // B. Pattern Compatible Matches
    if (matchedPatternRoutes.length === 1) {
      const match = matchedPatternRoutes[0];
      return {
        id: `${clientFactId}_resolution`,
        clientFileId,
        clientFactId,
        backendFileId: match.backendFileId,
        backendRouteFactId: match.routeFactId,
        httpMethod: effectiveMethod,
        rawClientEndpoint: rawEndpoint,
        normalizedClientPattern: clientPattern,
        originalRoutePath: match.originalRoutePath,
        composedRoutePath: match.composedRoutePath,
        classification: "pattern_compatible",
        mountChain: match.mountChain,
        clientLocation,
        backendLocation: match.location || null,
        resolverVersion: this.resolverVersion,
        resolutionRule: match.httpMethod === "ALL" ? "router_all_wildcard_pattern" : "pattern_compatible_match",
        candidates: [this._candidateSummary(match)],
      };
    }

    if (matchedPatternRoutes.length > 1) {
      return {
        id: `${clientFactId}_resolution`,
        clientFileId,
        clientFactId,
        backendFileId: null,
        backendRouteFactId: null,
        httpMethod: effectiveMethod,
        rawClientEndpoint: rawEndpoint,
        normalizedClientPattern: clientPattern,
        originalRoutePath: null,
        composedRoutePath: null,
        classification: "ambiguous",
        mountChain: [],
        clientLocation,
        backendLocation: null,
        resolverVersion: this.resolverVersion,
        resolutionRule: "ambiguous_multiple_pattern_candidates",
        candidates: matchedPatternRoutes.map(this._candidateSummary),
      };
    }

    // C. No Route Matched -> Unresolved
    return {
      id: `${clientFactId}_resolution`,
      clientFileId,
      clientFactId,
      backendFileId: null,
      backendRouteFactId: null,
      httpMethod: effectiveMethod,
      rawClientEndpoint: rawEndpoint,
      normalizedClientPattern: clientPattern,
      originalRoutePath: null,
      composedRoutePath: null,
      classification: "unresolved",
      mountChain: [],
      clientLocation,
      backendLocation: null,
      resolverVersion: this.resolverVersion,
      resolutionRule: "unresolved_no_matching_route",
      candidates: [],
    };
  }

  /**
   * Helper formatting candidate route summaries.
   *
   * @private
   */
  _candidateSummary(cr) {
    return {
      backendFileId: cr.backendFileId,
      backendRouteFactId: cr.routeFactId,
      httpMethod: cr.httpMethod,
      originalRoutePath: cr.originalRoutePath,
      composedRoutePath: cr.composedRoutePath,
      mountChainLength: cr.mountChain ? cr.mountChain.length : 0,
    };
  }
}

module.exports = {
  RESOLVER_VERSION,
  SUPPORTED_HTTP_METHODS,
  normalizePath,
  joinPaths,
  splitSegments,
  matchPathStructural,
  composeBackendRoutes,
  HttpRouteResolver,
};
