/**
 * Cartograph Unified Graph Validator.
 *
 * Enforces structural, referential, revision, and provenance integrity on Graph Snapshots.
 * Rejects dangling edges, missing provenance, duplicate identities, cross-revision contamination,
 * and unconfirmed/ambiguous facts masquerading as confirmed graph edges.
 */

const { EDGE_SEMANTICS } = require("./identity");
const { NORMALIZED_STATUSES } = require("./evidenceNormalizer");

const VALID_NODE_TYPES = new Set(["file", "symbol", "external"]);
const VALID_EDGE_TYPES = new Set([
  ...Object.values(EDGE_SEMANTICS),
  "includes",
  "inherits",
]);

class GraphValidator {
  /**
   * Validates a Graph Snapshot against Cartograph Graph Integrity Rules.
   *
   * @param {object} snapshot
   * @returns {{
   *   isValid: boolean,
   *   errors: string[],
   *   warnings: string[],
   * }}
   */
  static validate(snapshot) {
    const errors = [];
    const warnings = [];

    if (!snapshot || typeof snapshot !== "object") {
      return {
        isValid: false,
        errors: ["Snapshot must be a non-null object"],
        warnings: [],
      };
    }

    // 1. Schema and Metadata Validation
    if (snapshot.schemaVersion !== "1.0.0") {
      errors.push(`Invalid schemaVersion: expected '1.0.0', got '${snapshot.schemaVersion}'`);
    }
    if (!snapshot.graphId || typeof snapshot.graphId !== "string") {
      errors.push("Missing or invalid graphId");
    }
    if (!snapshot.repository || !snapshot.repository.repositoryId) {
      errors.push("Missing or invalid repository.repositoryId");
    }
    if (!snapshot.revision || !snapshot.revision.commitSha) {
      errors.push("Missing or invalid revision.commitSha");
    }
    if (!snapshot.builder || !snapshot.builder.version) {
      errors.push("Missing or invalid builder.version");
    }

    const expectedCommitSha = snapshot.revision ? snapshot.revision.commitSha : null;

    // 2. Node Integrity
    if (!Array.isArray(snapshot.nodes)) {
      errors.push("Snapshot nodes must be an array");
      return { isValid: false, errors, warnings };
    }

    const nodeIds = new Set();
    const nodeMap = new Map();

    for (let i = 0; i < snapshot.nodes.length; i++) {
      const node = snapshot.nodes[i];
      if (!node || typeof node !== "object") {
        errors.push(`Node at index ${i} is not a valid object`);
        continue;
      }

      if (!node.id || typeof node.id !== "string") {
        errors.push(`Node at index ${i} is missing a valid id string`);
        continue;
      }

      if (nodeIds.has(node.id)) {
        errors.push(`Duplicate node id detected: '${node.id}'`);
      }
      nodeIds.add(node.id);
      nodeMap.set(node.id, node);

      if (!VALID_NODE_TYPES.has(node.type)) {
        errors.push(`Node '${node.id}' has invalid type: '${node.type}'`);
      }

      // Check cross-revision integrity on internal nodes
      if (node.type === "file" || node.type === "symbol") {
        if (expectedCommitSha && !node.id.includes(expectedCommitSha)) {
          errors.push(
            `Cross-revision node detected: Node '${node.id}' does not match snapshot commitSha '${expectedCommitSha}'`
          );
        }
      }
    }

    // 3. Edge Integrity & Referential Checks
    if (!Array.isArray(snapshot.edges)) {
      errors.push("Snapshot edges must be an array");
      return { isValid: false, errors, warnings };
    }

    const edgeIds = new Set();

    for (let i = 0; i < snapshot.edges.length; i++) {
      const edge = snapshot.edges[i];
      if (!edge || typeof edge !== "object") {
        errors.push(`Edge at index ${i} is not a valid object`);
        continue;
      }

      if (!edge.id || typeof edge.id !== "string") {
        errors.push(`Edge at index ${i} is missing a valid id string`);
        continue;
      }

      if (edgeIds.has(edge.id)) {
        errors.push(`Duplicate edge id detected: '${edge.id}'`);
      }
      edgeIds.add(edge.id);

      if (!VALID_EDGE_TYPES.has(edge.type)) {
        errors.push(`Edge '${edge.id}' has invalid edge type: '${edge.type}'`);
      }

      // Endpoint referential integrity: endpoints must exist in nodes collection
      const sourceExists = nodeMap.has(edge.source);
      const targetExists = nodeMap.has(edge.target);

      if (!sourceExists) {
        errors.push(`Dangling edge: Source node '${edge.source}' does not exist for edge '${edge.id}'`);
      }
      if (!targetExists) {
        errors.push(`Dangling edge: Target node '${edge.target}' does not exist for edge '${edge.id}'`);
      }

      // Provenance validation: every edge MUST have a non-empty evidence array
      if (!Array.isArray(edge.evidence) || edge.evidence.length === 0) {
        errors.push(`Edge '${edge.id}' is missing required provenance evidence`);
      } else {
        // Enforce that internal edges are supported by confirmed evidence
        const sourceNode = nodeMap.get(edge.source);
        const targetNode = nodeMap.get(edge.target);

        const isInternalEdge =
          sourceNode &&
          targetNode &&
          (sourceNode.type === "file" || sourceNode.type === "symbol") &&
          (targetNode.type === "file" || targetNode.type === "symbol");

        if (isInternalEdge) {
          const hasConfirmedEvidence = edge.evidence.some(
            (ev) => ev.status && ev.status.isConfirmed === true
          );
          if (!hasConfirmedEvidence) {
            errors.push(
              `Edge '${edge.id}' is an internal edge but lacks any confirmed evidence`
            );
          }
        }
      }
    }

    // 4. Statistics Validation
    if (snapshot.statistics && typeof snapshot.statistics === "object") {
      if (snapshot.statistics.totalNodes !== snapshot.nodes.length) {
        warnings.push(
          `Statistics mismatch: totalNodes (${snapshot.statistics.totalNodes}) does not match nodes.length (${snapshot.nodes.length})`
        );
      }
      if (snapshot.statistics.totalEdges !== snapshot.edges.length) {
        warnings.push(
          `Statistics mismatch: totalEdges (${snapshot.statistics.totalEdges}) does not match edges.length (${snapshot.edges.length})`
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

module.exports = {
  GraphValidator,
  VALID_NODE_TYPES,
  VALID_EDGE_TYPES,
};

