/**
 * Cartograph Unified Dependency Graph API Controller.
 *
 * Implements authenticated, tenant-isolated endpoints for graph snapshot creation,
 * metadata summary, paginated node queries, directed edge queries, bounded neighborhood queries,
 * provenance evidence, and scoped subgraphs.
 *
 * Enforces:
 * - Session authentication & active organization verification.
 * - Strict multi-tenant repository access control before cache lookup.
 * - Server-side FileIR trust boundary (client-supplied FileIR is rejected).
 * - Exact commit revision scoping.
 */

const { AppError } = require("../lib/errors");
const { requirePlainObject } = require("../lib/validation");
const { ensureTenantAuthorization } = require("./repositoryController");
const { defaultStore } = require("../services/graph/GraphSnapshotStore");
const { buildRepositoryGraph } = require("../services/graph/graphPipeline");
const { parseRepositoryFiles } = require("../services/parser");
const githubService = require("../services/github");
const { retrieveSourceFiles } = require("../services/sourceRetrieval");
const { verifyRepositoryOwnership } = require("../services/repositoryAuth");

/**
 * Validates tenant authorization and repository-level access, then returns
 * the active GraphQueryService for the requested repository and revision.
 *
 * Enforces that authorization runs strictly BEFORE snapshot-cache lookup
 * against authoritative repository records, never relying solely on graph cache state.
 *
 * @param {object} req - Express request
 * @param {string} repositoryId - Decoded repository ID
 * @param {string|null} [commitSha=null] - Optional specific commit SHA
 * @returns {Promise<object>} The active GraphQueryService instance
 */
async function ensureAuthorizedQueryService(req, repositoryId, commitSha = null) {
  // 1. Session authentication and active organization membership check
  const orgId = await ensureTenantAuthorization(req);

  // 2. Authoritative repository-level authorization (happens BEFORE cache lookup)
  await verifyRepositoryOwnership(repositoryId, orgId);

  // 3. Cache lookup strictly scoped to repository, commit, and organization context
  const cached = defaultStore.get({ repositoryId, commitSha, organizationId: orgId });
  if (!cached || !cached.queryService) {
    throw new AppError(
      404,
      "GRAPH_NOT_FOUND",
      `No graph snapshot found for repository '${repositoryId}'${
        commitSha ? ` at commit '${commitSha}'` : ""
      }. Build the graph first.`
    );
  }

  return cached.queryService;
}

/**
 * POST /api/repositories/:repositoryId/graph/build
 * Builds, validates, and caches a unified dependency graph from authoritative server-parsed FileIR.
 */
async function buildGraph(req, res) {
  // 1. Enforce authentication and active tenant authorization
  const orgId = await ensureTenantAuthorization(req);

  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const body = requirePlainObject(req.body);

  // 2. Authoritatively verify repository ownership against tenant context (NOT from cache state)
  await verifyRepositoryOwnership(repositoryId, orgId);

  const commitSha = body.commitSha || body.ref || (body.files ? null : "HEAD");
  if (!commitSha || typeof commitSha !== "string" || commitSha.trim().length === 0) {
    throw new AppError(400, "MISSING_COMMIT_SHA", "A valid commitSha string is required in request body.");
  }
  const cleanSha = commitSha.trim();
  let effectiveSha = cleanSha;

  // 3. FileIR Trust Boundary: Reject client-supplied FileIR to prevent parsing pipeline bypass
  if (body.fileIRList !== undefined) {
    throw new AppError(
      400,
      "UNTRUSTED_FILE_IR",
      "Client-supplied FileIR cannot bypass the server parsing pipeline. Submit raw source files or repository ref."
    );
  }

  // 4. Obtain FileIR strictly from existing server-side parsing pipeline
  let sourceFiles = Array.isArray(body.files) ? body.files : null;
  let manifestFiles = null;
  let isPartialRetrieval = false;

  if (!sourceFiles) {
    const targetRef = body.ref || cleanSha;

    const [owner, repo] = repositoryId.split("/");
    if (!owner || !repo) {
      throw new AppError(400, "INVALID_REPOSITORY_ID", "Repository ID must be in 'owner/repo' format.");
    }

    const manifest = await githubService.discoverRepositoryManifest(owner, repo, { ref: targetRef });
    effectiveSha = manifest.commitSha || cleanSha;
    manifestFiles = manifest.files;

    const retrievalResult = await retrieveSourceFiles({
      owner,
      repo,
      commitSha: effectiveSha,
      manifestFiles: manifest.files,
      options: {
        paths: body.paths,
        includeDocumentation: Boolean(body.includeDocumentation),
        budgets: body.budgets,
      },
    });

    sourceFiles = retrievalResult.files;
    isPartialRetrieval = retrievalResult.status === "partial";
  }

  // Authoritative server-side parsing
  const parseResult = await parseRepositoryFiles({
    repository: {
      owner: repositoryId.split("/")[0] || "unknown",
      name: repositoryId.split("/")[1] || "unknown",
      fullName: repositoryId,
      commitSha: effectiveSha,
    },
    files: sourceFiles,
    options: body.options || {},
  });

  const authoritativeFileIRList = parseResult.files || [];

  // Extract supporting files (tsconfig.json, pom.xml, etc.)
  const supportingFiles = {};
  if (Array.isArray(sourceFiles)) {
    for (const sf of sourceFiles) {
      if (sf && sf.path && sf.content) {
        const base = sf.path.split("/").pop();
        if (base && !supportingFiles[base]) {
          supportingFiles[base] = sf.content;
        }
      }
    }
  }

  try {
    const result = await buildRepositoryGraph({
      repositoryId,
      commitSha: effectiveSha,
      fileIRList: authoritativeFileIRList,
      organizationId: orgId,
    }, {
      ...(body.options || {}),
      manifest: manifestFiles || (body.options && body.options.manifest) || null,
      supportingFiles: { ...supportingFiles, ...((body.options && body.options.supportingFiles) || {}) },
      isPartial: isPartialRetrieval || Boolean(body.options && body.options.isPartial),
    });

    return res.status(201).json({
      success: true,
      data: {
        graphId: result.snapshot.graphId,
        cacheKey: result.cacheKey,
        repository: result.snapshot.repository,
        revision: result.snapshot.revision,
        statistics: result.snapshot.statistics,
        diagnostics: result.snapshot.diagnostics,
      },
    });
  } catch (err) {
    if (err.code === "INVALID_GRAPH_SNAPSHOT") {
      throw new AppError(422, "INVALID_GRAPH_SNAPSHOT", err.message);
    }
    throw err;
  }
}

/**
 * GET /api/repositories/:repositoryId/graph
 * Retrieves snapshot metadata, schema version, builder version, and statistics.
 */
async function getGraphSummary(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const metadata = queryService.getSnapshotMetadata();

  return res.status(200).json({
    success: true,
    data: metadata,
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/nodes
 * Retrieves paginated nodes with optional filtering by type, language, or search query.
 */
async function getNodes(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const result = queryService.getNodes({
    type: req.query.type,
    language: req.query.language,
    query: req.query.query,
    page: req.query.page,
    pageSize: req.query.pageSize,
  });

  return res.status(200).json({
    success: true,
    data: result,
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/nodes/:nodeId
 * Retrieves detailed node information by canonical ID.
 */
async function getNodeDetails(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const nodeId = decodeURIComponent(req.params.nodeId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const node = queryService.getNode(nodeId);

  if (!node) {
    throw new AppError(404, "NODE_NOT_FOUND", `Node '${nodeId}' not found in graph.`);
  }

  return res.status(200).json({
    success: true,
    data: node,
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/edges
 * Retrieves paginated edges with optional filtering by type, source, or target.
 */
async function getEdges(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const result = queryService.getEdges({
    edgeType: req.query.edgeType,
    excludeTypes: req.query.excludeTypes,
    source: req.query.source,
    target: req.query.target,
    page: req.query.page,
    pageSize: req.query.pageSize,
  });

  return res.status(200).json({
    success: true,
    data: result,
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/nodes/:nodeId/outgoing
 * Retrieves outgoing directed edges for a specific node.
 */
async function getOutgoingEdges(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const nodeId = decodeURIComponent(req.params.nodeId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const edges = queryService.getOutgoingEdges(nodeId, {
    edgeType: req.query.edgeType,
  });

  return res.status(200).json({
    success: true,
    data: {
      nodeId,
      edges,
      total: edges.length,
    },
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/nodes/:nodeId/incoming
 * Retrieves incoming directed edges for a specific node.
 */
async function getIncomingEdges(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const nodeId = decodeURIComponent(req.params.nodeId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const edges = queryService.getIncomingEdges(nodeId, {
    edgeType: req.query.edgeType,
  });

  return res.status(200).json({
    success: true,
    data: {
      nodeId,
      edges,
      total: edges.length,
    },
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/neighborhood
 * Retrieves bounded N-hop neighborhood around a center node.
 */
async function getNeighborhood(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const centerNodeId = req.query.centerNodeId || req.query.nodeId;
  const commitSha = req.query.commitSha || null;

  if (!centerNodeId || typeof centerNodeId !== "string") {
    throw new AppError(400, "MISSING_CENTER_NODE_ID", "centerNodeId query parameter is required.");
  }

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const edgeTypes = req.query.edgeTypes ? req.query.edgeTypes.split(",") : undefined;

  const neighborhood = queryService.getNeighborhood(centerNodeId, {
    maxDepth: req.query.maxDepth,
    maxNodes: req.query.maxNodes,
    direction: req.query.direction,
    edgeTypes,
  });

  return res.status(200).json({
    success: true,
    data: neighborhood,
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/edges/:edgeId/evidence
 * Retrieves provenance evidence records for a specific edge.
 */
async function getEdgeEvidence(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const edgeId = decodeURIComponent(req.params.edgeId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const evidence = queryService.getEdgeEvidence(edgeId);

  if (!evidence) {
    throw new AppError(404, "EDGE_NOT_FOUND", `Edge '${edgeId}' not found in graph.`);
  }

  return res.status(200).json({
    success: true,
    data: {
      edgeId,
      evidence,
      total: evidence.length,
    },
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/unresolved
 * Retrieves paginated unresolved and ambiguous references.
 */
async function getUnresolvedReferences(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const commitSha = req.query.commitSha || null;

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const result = queryService.getUnresolvedReferences({
    status: req.query.status,
    category: req.query.category,
    sourceFile: req.query.sourceFile,
    page: req.query.page,
    pageSize: req.query.pageSize,
  });

  return res.status(200).json({
    success: true,
    data: result,
  });
}

/**
 * GET /api/repositories/:repositoryId/graph/subgraph/file
 * Retrieves a bounded file-level subgraph.
 */
async function getFileSubgraph(req, res) {
  const repositoryId = decodeURIComponent(req.params.repositoryId);
  const filePath = req.query.filePath;
  const commitSha = req.query.commitSha || null;

  if (!filePath || typeof filePath !== "string") {
    throw new AppError(400, "MISSING_FILE_PATH", "filePath query parameter is required.");
  }

  const queryService = await ensureAuthorizedQueryService(req, repositoryId, commitSha);
  const subgraph = queryService.getFileSubgraph(filePath);

  if (!subgraph) {
    throw new AppError(404, "FILE_NOT_FOUND", `File '${filePath}' not found in graph snapshot.`);
  }

  return res.status(200).json({
    success: true,
    data: subgraph,
  });
}

module.exports = {
  ensureAuthorizedQueryService,
  buildGraph,
  getGraphSummary,
  getNodes,
  getEdges,
  getNodeDetails,
  getOutgoingEdges,
  getIncomingEdges,
  getNeighborhood,
  getEdgeEvidence,
  getUnresolvedReferences,
  getFileSubgraph,
};
