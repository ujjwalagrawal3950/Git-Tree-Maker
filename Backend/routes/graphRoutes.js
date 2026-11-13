const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errors");
const {
  buildGraph,
  getGraphSummary,
  getNodes,
  getNodeDetails,
  getOutgoingEdges,
  getIncomingEdges,
  getNeighborhood,
  getEdgeEvidence,
  getUnresolvedReferences,
  getFileSubgraph,
} = require("../controllers/graphController");

const routes = express.Router();

// Graph Construction & Management
routes.post("/repositories/:repositoryId/graph/build", requireAuth, asyncHandler(buildGraph));
routes.post("/organizations/:orgId/repositories/:repositoryId/graph/build", requireAuth, asyncHandler(buildGraph));

// Snapshot Metadata & Summary
routes.get("/repositories/:repositoryId/graph", requireAuth, asyncHandler(getGraphSummary));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph", requireAuth, asyncHandler(getGraphSummary));

// Node Queries
routes.get("/repositories/:repositoryId/graph/nodes", requireAuth, asyncHandler(getNodes));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/nodes", requireAuth, asyncHandler(getNodes));

routes.get("/repositories/:repositoryId/graph/nodes/:nodeId", requireAuth, asyncHandler(getNodeDetails));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/nodes/:nodeId", requireAuth, asyncHandler(getNodeDetails));

routes.get("/repositories/:repositoryId/graph/nodes/:nodeId/outgoing", requireAuth, asyncHandler(getOutgoingEdges));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/nodes/:nodeId/outgoing", requireAuth, asyncHandler(getOutgoingEdges));

routes.get("/repositories/:repositoryId/graph/nodes/:nodeId/incoming", requireAuth, asyncHandler(getIncomingEdges));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/nodes/:nodeId/incoming", requireAuth, asyncHandler(getIncomingEdges));

// Neighborhood & Subgraph Queries
routes.get("/repositories/:repositoryId/graph/neighborhood", requireAuth, asyncHandler(getNeighborhood));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/neighborhood", requireAuth, asyncHandler(getNeighborhood));

routes.get("/repositories/:repositoryId/graph/subgraph/file", requireAuth, asyncHandler(getFileSubgraph));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/subgraph/file", requireAuth, asyncHandler(getFileSubgraph));

// Provenance & Edge Evidence
routes.get("/repositories/:repositoryId/graph/edges/:edgeId/evidence", requireAuth, asyncHandler(getEdgeEvidence));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/edges/:edgeId/evidence", requireAuth, asyncHandler(getEdgeEvidence));

// Unresolved References
routes.get("/repositories/:repositoryId/graph/unresolved", requireAuth, asyncHandler(getUnresolvedReferences));
routes.get("/organizations/:orgId/repositories/:repositoryId/graph/unresolved", requireAuth, asyncHandler(getUnresolvedReferences));

module.exports = routes;

