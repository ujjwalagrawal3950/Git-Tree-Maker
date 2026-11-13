/**
 * Cartograph Unified Graph Query Service.
 *
 * Provides high-performance, indexed, bounded queries over immutable Graph Snapshots.
 * Supports O(1) node lookup, fast adjacency traversal, bounded N-hop neighborhood search
 * with cycle detection, paginated filtering, and scoped subgraphs.
 */

class GraphQueryService {
  /**
   * @param {object} snapshot - Validated Cartograph Graph Snapshot
   */
  constructor(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("GraphQueryService requires a valid snapshot object");
    }

    this.snapshot = snapshot;
    this.nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
    this.edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
    this.unresolvedReferences = Array.isArray(snapshot.unresolvedReferences)
      ? snapshot.unresolvedReferences
      : [];
    this.diagnostics = Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [];
    this.statistics = snapshot.statistics || {};

    // ------------------------------------------------------------------------
    // Build In-Memory Secondary Indexes
    // ------------------------------------------------------------------------
    this.nodeMap = new Map();
    this.outgoingIndex = new Map(); // nodeId -> Array<Edge>
    this.incomingIndex = new Map(); // nodeId -> Array<Edge>
    this.edgeMap = new Map(); // edgeId -> Edge
    this.typeIndex = new Map(); // nodeType -> Array<Node>
    this.fileNodesByPath = new Map(); // relativePath -> FileNode
    this.symbolsByFilePath = new Map(); // relativePath -> Array<SymbolNode>

    // Index Nodes
    for (const node of this.nodes) {
      this.nodeMap.set(node.id, node);

      if (!this.typeIndex.has(node.type)) {
        this.typeIndex.set(node.type, []);
      }
      this.typeIndex.get(node.type).push(node);

      if (node.type === "file" && node.path) {
        this.fileNodesByPath.set(node.path, node);
      } else if (node.type === "symbol" && node.path) {
        if (!this.symbolsByFilePath.has(node.path)) {
          this.symbolsByFilePath.set(node.path, []);
        }
        this.symbolsByFilePath.get(node.path).push(node);
      }

      // Initialize empty adjacency lists
      this.outgoingIndex.set(node.id, []);
      this.incomingIndex.set(node.id, []);
    }

    // Index Edges
    for (const edge of this.edges) {
      this.edgeMap.set(edge.id, edge);

      if (this.outgoingIndex.has(edge.source)) {
        this.outgoingIndex.get(edge.source).push(edge);
      } else {
        this.outgoingIndex.set(edge.source, [edge]);
      }

      if (this.incomingIndex.has(edge.target)) {
        this.incomingIndex.get(edge.target).push(edge);
      } else {
        this.incomingIndex.set(edge.target, [edge]);
      }
    }
  }

  /**
   * Returns snapshot metadata and statistics.
   *
   * @returns {object}
   */
  getSnapshotMetadata() {
    return {
      schemaVersion: this.snapshot.schemaVersion,
      graphId: this.snapshot.graphId,
      repository: this.snapshot.repository,
      revision: this.snapshot.revision,
      builder: this.snapshot.builder,
      statistics: this.statistics,
    };
  }

  /**
   * Retrieves a single node by its canonical ID.
   *
   * @param {string} nodeId
   * @returns {object|null}
   */
  getNode(nodeId) {
    if (!nodeId || typeof nodeId !== "string") return null;
    return this.nodeMap.get(nodeId) || null;
  }

  /**
   * Retrieves paginated nodes with optional filtering by type, language, or search query.
   *
   * @param {object} [options]
   * @param {string} [options.type] - e.g. "file", "symbol", "external"
   * @param {string} [options.language] - e.g. "typescript", "python"
   * @param {string} [options.query] - Case-insensitive substring match on name
   * @param {number} [options.page=1]
   * @param {number} [options.pageSize=50]
   * @returns {{ nodes: Array<object>, total: number, page: number, pageSize: number, totalPages: number }}
   */
  getNodes(options = {}) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(options.pageSize, 10) || 50));

    let candidateNodes = options.type && this.typeIndex.has(options.type)
      ? this.typeIndex.get(options.type)
      : this.nodes;

    if (options.language) {
      const langLower = options.language.toLowerCase();
      candidateNodes = candidateNodes.filter(
        (n) => n.language && n.language.toLowerCase() === langLower
      );
    }

    if (options.query) {
      const qLower = options.query.toLowerCase();
      candidateNodes = candidateNodes.filter(
        (n) =>
          (n.name && n.name.toLowerCase().includes(qLower)) ||
          (n.qualifiedName && n.qualifiedName.toLowerCase().includes(qLower))
      );
    }

    const total = candidateNodes.length;
    const totalPages = Math.ceil(total / pageSize) || 1;
    const offset = (page - 1) * pageSize;
    const paginated = candidateNodes.slice(offset, offset + pageSize);

    return {
      nodes: paginated,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  /**
   * Retrieves outgoing edges from a node with optional edge type filter.
   *
   * @param {string} nodeId
   * @param {object} [options]
   * @param {string} [options.edgeType]
   * @returns {Array<object>}
   */
  getOutgoingEdges(nodeId, options = {}) {
    if (!nodeId || !this.outgoingIndex.has(nodeId)) return [];
    const edges = this.outgoingIndex.get(nodeId);
    if (options.edgeType) {
      return edges.filter((e) => e.type === options.edgeType);
    }
    return edges;
  }

  /**
   * Retrieves incoming edges to a node with optional edge type filter.
   *
   * @param {string} nodeId
   * @param {object} [options]
   * @param {string} [options.edgeType]
   * @returns {Array<object>}
   */
  getIncomingEdges(nodeId, options = {}) {
    if (!nodeId || !this.incomingIndex.has(nodeId)) return [];
    const edges = this.incomingIndex.get(nodeId);
    if (options.edgeType) {
      return edges.filter((e) => e.type === options.edgeType);
    }
    return edges;
  }

  /**
   * Retrieves adjacent neighbor nodes and connecting edges.
   *
   * @param {string} nodeId
   * @param {object} [options]
   * @param {"outgoing"|"incoming"|"both"} [options.direction="both"]
   * @param {string} [options.edgeType]
   * @returns {{ nodes: Array<object>, edges: Array<object> }}
   */
  getNeighbors(nodeId, options = {}) {
    const direction = options.direction || "both";
    const edges = [];

    if (direction === "outgoing" || direction === "both") {
      edges.push(...this.getOutgoingEdges(nodeId, options));
    }
    if (direction === "incoming" || direction === "both") {
      edges.push(...this.getIncomingEdges(nodeId, options));
    }

    const neighborNodeIds = new Set();
    for (const edge of edges) {
      if (edge.source !== nodeId) neighborNodeIds.add(edge.source);
      if (edge.target !== nodeId) neighborNodeIds.add(edge.target);
    }

    const neighborNodes = [];
    for (const nId of neighborNodeIds) {
      const node = this.getNode(nId);
      if (node) neighborNodes.push(node);
    }

    return {
      nodes: neighborNodes,
      edges,
    };
  }

  /**
   * Computes a bounded N-hop neighborhood around a center node.
   * Enforces strict maximum depth, maximum node count, and cycle avoidance.
   *
   * @param {string} centerNodeId
   * @param {object} [options]
   * @param {number} [options.maxDepth=2] - Maximum hops (capped at 5)
   * @param {number} [options.maxNodes=100] - Maximum total nodes (capped at 500)
   * @param {"outgoing"|"incoming"|"both"} [options.direction="both"]
   * @param {string[]} [options.edgeTypes] - Filter edges by types
   * @returns {{
   *   rootNodeId: string,
   *   nodes: Array<object>,
   *   edges: Array<object>,
   *   depthReached: number,
   *   truncated: boolean
   * }}
   */
  getNeighborhood(centerNodeId, options = {}) {
    const centerNode = this.getNode(centerNodeId);
    if (!centerNode) {
      return {
        rootNodeId: centerNodeId,
        nodes: [],
        edges: [],
        depthReached: 0,
        truncated: false,
      };
    }

    const maxDepth = Math.min(5, Math.max(1, parseInt(options.maxDepth, 10) || 2));
    const maxNodes = Math.min(500, Math.max(1, parseInt(options.maxNodes, 10) || 100));
    const direction = options.direction || "both";
    const edgeTypeFilter = Array.isArray(options.edgeTypes) ? new Set(options.edgeTypes) : null;

    const visitedNodes = new Set([centerNodeId]);
    const collectedNodes = [centerNode];
    const collectedEdges = [];
    const edgeIdSet = new Set();

    let currentQueue = [centerNodeId];
    let depth = 0;
    let truncated = false;

    while (currentQueue.length > 0 && depth < maxDepth) {
      depth++;
      const nextQueue = [];

      for (const currId of currentQueue) {
        let candidateEdges = [];
        if (direction === "outgoing" || direction === "both") {
          candidateEdges.push(...this.getOutgoingEdges(currId));
        }
        if (direction === "incoming" || direction === "both") {
          candidateEdges.push(...this.getIncomingEdges(currId));
        }

        if (edgeTypeFilter) {
          candidateEdges = candidateEdges.filter((e) => edgeTypeFilter.has(e.type));
        }

        for (const edge of candidateEdges) {
          if (!edgeIdSet.has(edge.id)) {
            edgeIdSet.add(edge.id);
            collectedEdges.push(edge);
          }

          const nextId = edge.source === currId ? edge.target : edge.source;
          if (!visitedNodes.has(nextId)) {
            if (collectedNodes.length >= maxNodes) {
              truncated = true;
              break;
            }

            visitedNodes.add(nextId);
            const neighborNode = this.getNode(nextId);
            if (neighborNode) {
              collectedNodes.push(neighborNode);
              nextQueue.push(nextId);
            }
          }
        }

        if (truncated) break;
      }

      if (truncated) break;
      currentQueue = nextQueue;
    }

    return {
      rootNodeId: centerNodeId,
      nodes: collectedNodes,
      edges: collectedEdges,
      depthReached: depth,
      truncated,
    };
  }

  /**
   * Retrieves the provenance evidence collection for an edge by edgeId.
   *
   * @param {string} edgeId
   * @returns {Array<object>|null}
   */
  getEdgeEvidence(edgeId) {
    if (!edgeId || !this.edgeMap.has(edgeId)) return null;
    return this.edgeMap.get(edgeId).evidence || [];
  }

  /**
   * Retrieves paginated unresolved references.
   *
   * @param {object} [options]
   * @param {string} [options.status] - Filter by normalized status (e.g. "ambiguous", "unresolved")
   * @param {string} [options.category] - Filter by category (e.g. "dependency", "call", "inheritance")
   * @param {string} [options.sourceFile] - Filter by sourceFile path
   * @param {number} [options.page=1]
   * @param {number} [options.pageSize=50]
   * @returns {{ items: Array<object>, total: number, page: number, pageSize: number, totalPages: number }}
   */
  getUnresolvedReferences(options = {}) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(options.pageSize, 10) || 50));

    let items = this.unresolvedReferences;
    if (options.status) {
      items = items.filter((item) => item.status === options.status);
    }
    if (options.category) {
      items = items.filter((item) => item.category === options.category);
    }
    if (options.sourceFile) {
      items = items.filter((item) => item.sourceFile === options.sourceFile);
    }

    const total = items.length;
    const totalPages = Math.ceil(total / pageSize) || 1;
    const offset = (page - 1) * pageSize;
    const paginated = items.slice(offset, offset + pageSize);

    return {
      items: paginated,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  /**
   * Extracts a bounded subgraph representing a file, its contained symbols,
   * and its direct incoming and outgoing file dependencies.
   *
   * @param {string} filePath - Repository-relative file path
   * @returns {{ nodes: Array<object>, edges: Array<object> }|null}
   */
  getFileSubgraph(filePath) {
    if (!filePath || !this.fileNodesByPath.has(filePath)) return null;

    const fileNode = this.fileNodesByPath.get(filePath);
    const nodeSet = new Set([fileNode.id]);
    const edgeSet = new Set();
    const resultNodes = [fileNode];
    const resultEdges = [];

    // Add all symbols contained in this file
    const symbols = this.symbolsByFilePath.get(filePath) || [];
    for (const sym of symbols) {
      nodeSet.add(sym.id);
      resultNodes.push(sym);
    }

    // Add direct incoming and outgoing edges for file and its symbols
    for (const nId of Array.from(nodeSet)) {
      const outgoing = this.getOutgoingEdges(nId);
      const incoming = this.getIncomingEdges(nId);

      for (const e of [...outgoing, ...incoming]) {
        if (!edgeSet.has(e.id)) {
          edgeSet.add(e.id);
          resultEdges.push(e);

          // If the endpoint node is not yet included, include it
          const otherId = e.source === nId ? e.target : e.source;
          if (!nodeSet.has(otherId)) {
            nodeSet.add(otherId);
            const otherNode = this.getNode(otherId);
            if (otherNode) resultNodes.push(otherNode);
          }
        }
      }
    }

    return {
      nodes: resultNodes,
      edges: resultEdges,
    };
  }

  /**
   * Extracts a bounded subgraph for a specific symbol, including its enclosing
   * file/symbol, member symbols, and direct callers/callees.
   *
   * @param {string} symbolId - Canonical Symbol Node ID
   * @returns {{ nodes: Array<object>, edges: Array<object> }|null}
   */
  getSymbolSubgraph(symbolId) {
    const symbolNode = this.getNode(symbolId);
    if (!symbolNode || symbolNode.type !== "symbol") return null;

    return this.getNeighborhood(symbolId, { maxDepth: 1, maxNodes: 50 });
  }
}

module.exports = {
  GraphQueryService,
};

