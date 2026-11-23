/**
 * Cartograph Deterministic Unified Graph Builder.
 *
 * Constructs canonical, immutable graph snapshots from validated FileIR documents,
 * repository revision metadata, and normalized evidence.
 *
 * Guarantees:
 * - 100% deterministic output: identical inputs produce identical byte-for-byte serialization.
 * - Strict confirmation gating: unconfirmed, unresolved, ambiguous, or unsupported facts
 *   never become confirmed graph edges.
 * - Lossless evidence aggregation: multiple evidence items for the same relationship
 *   are aggregated into a single deduplicated edge with deterministic provenance.
 * - Complete statistics and completeness metrics calculation.
 */

const path = require("path");
const {
  GRAPH_BUILDER_VERSION,
  FILE_IR_VERSION,
  EDGE_SEMANTICS,
  createFileNodeId,
  createSymbolNodeId,
  createExternalNodeId,
  createEdgeId,
  computeResolverFingerprint,
  createGraphSnapshotId,
} = require("./identity");
const { NORMALIZED_STATUSES } = require("./evidenceNormalizer");

class GraphBuilder {
  /**
   * @param {object} [config]
   * @param {string} [config.builderVersion=GRAPH_BUILDER_VERSION]
   * @param {string} [config.fileIrVersion=FILE_IR_VERSION]
   * @param {object} [config.resolverVersions]
   */
  constructor(config = {}) {
    this.builderVersion = config.builderVersion || GRAPH_BUILDER_VERSION;
    this.fileIrVersion = config.fileIrVersion || FILE_IR_VERSION;
    this.resolverVersions = config.resolverVersions || {};
  }

  /**
   * Builds an immutable, canonical graph snapshot from repository revision data.
   *
   * @param {object} params
   * @param {string} params.repositoryId - Full repository ID (e.g. "facebook/react" or UUID)
   * @param {string} params.commitSha - Full 40-character commit SHA
   * @param {Array<object>} params.fileIRList - List of validated FileIR documents
   * @param {Array<object>} [params.normalizedEvidenceList=[]] - List of normalized evidence records
   * @param {object} [options]
   * @param {boolean} [options.includeExternalNodes=true] - Whether to create external nodes for 3rd party deps
   * @returns {object} Canonical Graph Snapshot
   */
  build({
    repositoryId,
    commitSha,
    fileIRList = [],
    normalizedEvidenceList = [],
    manifest = null,
  }, options = {}) {
    if (!repositoryId || typeof repositoryId !== "string") {
      throw new Error("GraphBuilder.build requires a valid repositoryId string");
    }
    if (!commitSha || typeof commitSha !== "string") {
      throw new Error("GraphBuilder.build requires a valid commitSha string");
    }

    const includeExternalNodes = options.includeExternalNodes !== false;
    const fingerprint = computeResolverFingerprint(this.resolverVersions);
    const graphId = createGraphSnapshotId({
      repositoryId,
      commitSha,
      builderVersion: this.builderVersion,
      fileIrVersion: this.fileIrVersion,
      resolverFingerprint: fingerprint,
    });

    const nodeMap = new Map();
    const edgeMap = new Map();
    const unresolvedList = [];
    const diagnostics = [];

    // Index of files present in this snapshot for target validation
    const internalFilePathSet = new Set();
    for (const fileIr of fileIRList) {
      const fileInfo = fileIr && (fileIr.analysis ? fileIr.analysis.file : fileIr.file);
      if (fileInfo && fileInfo.path) {
        internalFilePathSet.add(fileInfo.path);
      }
    }

    const manifestInput = manifest || options.manifest || options.manifestPaths;
    if (manifestInput) {
      const mFiles = Array.isArray(manifestInput.files) ? manifestInput.files : (Array.isArray(manifestInput) ? manifestInput : null);
      if (Array.isArray(mFiles)) {
        for (const f of mFiles) {
          const p = typeof f === "string" ? f : (f && f.path);
          if (p) internalFilePathSet.add(p);
        }
      }
    }

    // ------------------------------------------------------------------------
    // Step 1: Create File Nodes and Symbol Nodes from FileIR documents
    // ------------------------------------------------------------------------
    for (const fileIr of fileIRList) {
      const fileInfo = fileIr && (fileIr.analysis ? fileIr.analysis.file : fileIr.file);
      if (!fileInfo || !fileInfo.path) continue;

      const normPath = fileInfo.path;
      const fileNodeId = createFileNodeId(repositoryId, commitSha, normPath);
      const language = fileInfo.language || "unknown";

      // Create File Node
      if (!nodeMap.has(fileNodeId)) {
        nodeMap.set(fileNodeId, {
          id: fileNodeId,
          type: "file",
          name: path.posix.basename(normPath),
          path: normPath,
          language,
          metadata: {
            blobSha: fileInfo.blobSha || null,
            lines: fileIr.metrics ? fileIr.metrics.lines : (fileIr.stats ? fileIr.stats.lines : null),
            status: (fileIr.parser && fileIr.parser.status) || fileIr.status || "complete",
          },
        });
      }

      // Collect diagnostics from FileIR if present
      if (Array.isArray(fileIr.diagnostics)) {
        for (const diag of fileIr.diagnostics) {
          diagnostics.push({
            ...diag,
            sourceFile: normPath,
          });
        }
      }

      // Create Symbol Nodes & Structural Containment Edges
      const symbols = Array.isArray(fileIr.symbols) ? fileIr.symbols : (Array.isArray(fileIr.declarations) ? fileIr.declarations : []);
      const fileSymbolIdToNodeId = new Map();

      for (const sym of symbols) {
        const symNodeId = createSymbolNodeId(fileNodeId, sym);
        fileSymbolIdToNodeId.set(sym.id, symNodeId);

        if (!nodeMap.has(symNodeId)) {
          nodeMap.set(symNodeId, {
            id: symNodeId,
            type: "symbol",
            name: sym.name || "unknown",
            qualifiedName: sym.qualifiedName || null,
            kind: sym.kind || "unknown",
            path: normPath,
            language,
            parentSymbolId: sym.parentSymbolId || null,
            location: sym.location || null,
            metadata: {
              visibility: sym.visibility || "public",
              isExported: Boolean(sym.isExported),
              signature: sym.signature || null,
              returnType: sym.returnType || null,
            },
          });
        }

        // Structural Ownership Edge:
        // Top-level symbol -> file contains symbol
        // Member symbol -> enclosing symbol contains member
        if (!sym.parentSymbolId) {
          // Top-level symbol owned by file
          const edgeId = createEdgeId(fileNodeId, EDGE_SEMANTICS.CONTAINS, symNodeId);
          if (!edgeMap.has(edgeId)) {
            edgeMap.set(edgeId, {
              id: edgeId,
              source: fileNodeId,
              target: symNodeId,
              type: EDGE_SEMANTICS.CONTAINS,
              semanticQualifier: null,
              confirmed: true,
              evidence: [
                {
                  id: `ev_cont_${sym.id || sym.name}`,
                  category: "containment",
                  sourceFile: normPath,
                  sourceFactId: sym.id || "sym_fact",
                  sourceLocation: sym.location || null,
                  resolver: { name: "FileIROwnership", version: this.fileIrVersion, rule: "top_level_declaration" },
                  status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true, confidence: "high" },
                },
              ],
            });
          }
        }

        // Concrete definition edge for C/C++ or languages where definition is distinct
        if (sym.isDefinition === true || (sym.languageMetadata && sym.languageMetadata.isDefinition === true)) {
          const defEdgeId = createEdgeId(fileNodeId, EDGE_SEMANTICS.DEFINES, symNodeId);
          if (!edgeMap.has(defEdgeId)) {
            edgeMap.set(defEdgeId, {
              id: defEdgeId,
              source: fileNodeId,
              target: symNodeId,
              type: EDGE_SEMANTICS.DEFINES,
              semanticQualifier: null,
              confirmed: true,
              evidence: [
                {
                  id: `ev_def_${sym.id || sym.name}`,
                  category: "definition",
                  sourceFile: normPath,
                  sourceFactId: sym.id || "sym_fact",
                  sourceLocation: sym.location || null,
                  resolver: { name: "FileIRDefinition", version: this.fileIrVersion, rule: "concrete_body" },
                  status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true, confidence: "high" },
                },
              ],
            });
          }
        }
      }

      // Link member symbols to enclosing parent symbols
      for (const sym of symbols) {
        if (sym.parentSymbolId && fileSymbolIdToNodeId.has(sym.parentSymbolId)) {
          const parentNodeId = fileSymbolIdToNodeId.get(sym.parentSymbolId);
          const childNodeId = fileSymbolIdToNodeId.get(sym.id);
          const memberEdgeId = createEdgeId(parentNodeId, EDGE_SEMANTICS.MEMBER_OF, childNodeId);

          if (!edgeMap.has(memberEdgeId)) {
            edgeMap.set(memberEdgeId, {
              id: memberEdgeId,
              source: parentNodeId,
              target: childNodeId,
              type: EDGE_SEMANTICS.MEMBER_OF,
              semanticQualifier: null,
              confirmed: true,
              evidence: [
                {
                  id: `ev_member_${sym.id}`,
                  category: "containment",
                  sourceFile: normPath,
                  sourceFactId: sym.id || "member_fact",
                  sourceLocation: sym.location || null,
                  resolver: { name: "FileIROwnership", version: this.fileIrVersion, rule: "member_containment" },
                  status: { original: "internal_resolved", normalized: NORMALIZED_STATUSES.RESOLVED, isConfirmed: true, confidence: "high" },
                },
              ],
            });
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // Step 2: Process Normalized Evidence
    // ------------------------------------------------------------------------
    for (const ev of normalizedEvidenceList) {
      if (!ev || typeof ev !== "object") continue;

      const isConfirmed = ev.status && ev.status.isConfirmed === true;
      const normalizedStatus = ev.status ? ev.status.normalized : NORMALIZED_STATUSES.UNRESOLVED;

      // 2A-HTTP: HTTP Request Evidence
      if (ev.category === "http_request") {
        if (isConfirmed && ev.sourceFile && ev.target && ev.target.resolvedPath) {
          const sourceFileNodeId = createFileNodeId(repositoryId, commitSha, ev.sourceFile);
          const targetFileNodeId = createFileNodeId(repositoryId, commitSha, ev.target.resolvedPath);

          // Verify both source and target exist in this revision / manifest
          if (nodeMap.has(sourceFileNodeId) && internalFilePathSet.has(ev.target.resolvedPath)) {
            // If target file node does not exist yet (e.g. valid file in manifest not in fileIRList), create it
            if (!nodeMap.has(targetFileNodeId)) {
              nodeMap.set(targetFileNodeId, {
                id: targetFileNodeId,
                type: "file",
                name: path.posix.basename(ev.target.resolvedPath),
                path: ev.target.resolvedPath,
                language: "unknown",
                metadata: { status: "reference_only" },
              });
            }

            const method = ev.target.httpMethod || (ev.metadata && ev.metadata.httpMethod) || "GET";
            const composedPath = ev.target.composedRoutePath || (ev.metadata && ev.metadata.composedRoutePath) || "/";
            const classification = (ev.status && ev.status.classification) || "confirmed_exact";
            const isPattern = classification === "pattern_compatible";
            const semanticQualifier = `${method}:${composedPath}${isPattern ? ":pattern" : ""}`;

            const edgeId = createEdgeId(
              sourceFileNodeId,
              EDGE_SEMANTICS.HTTP_REQUEST,
              targetFileNodeId,
              semanticQualifier
            );

            if (edgeMap.has(edgeId)) {
              // Deduplicate edge: append supporting evidence
              const existingEdge = edgeMap.get(edgeId);
              existingEdge.evidence.push(ev);
            } else {
              edgeMap.set(edgeId, {
                id: edgeId,
                source: sourceFileNodeId,
                target: targetFileNodeId,
                type: EDGE_SEMANTICS.HTTP_REQUEST,
                semanticQualifier,
                confirmed: true,
                metadata: {
                  httpMethod: method,
                  composedRoutePath: composedPath,
                  classification,
                  isPatternCompatible: isPattern,
                  mountChain: ev.target.mountChain || (ev.metadata && ev.metadata.mountChain) || [],
                },
                evidence: [ev],
              });
            }
            continue;
          }
        }

        // Unconfirmed or target file not in revision/manifest: route to unresolvedReferences
        unresolvedList.push({
          id: ev.id || `unres_http_${unresolvedList.length}`,
          category: "http_request",
          sourceFile: ev.sourceFile || "unknown",
          rawSpecifier: ev.target ? (ev.target.rawSpecifier || ev.target.clientPattern) : null,
          status: (ev.status && ev.status.classification) || normalizedStatus,
          candidates: ev.target && Array.isArray(ev.target.candidates) ? [...ev.target.candidates] : null,
          rule: ev.resolver ? ev.resolver.rule : null,
          location: ev.sourceLocation || null,
          resolver: ev.resolver || null,
        });
        continue;
      }

      // 2A: Confirmed Internal Dependency Edge
      if (isConfirmed && ev.sourceFile && ev.target && ev.target.resolvedPath) {
        // Enforce repository revision containment
        const sourceFileNodeId = createFileNodeId(repositoryId, commitSha, ev.sourceFile);
        const targetFileNodeId = createFileNodeId(repositoryId, commitSha, ev.target.resolvedPath);

        // Verify both source and target exist in this revision
        if (nodeMap.has(sourceFileNodeId) && internalFilePathSet.has(ev.target.resolvedPath)) {
          // If target file node does not exist yet (e.g. valid file not in fileIRList), create it
          if (!nodeMap.has(targetFileNodeId)) {
            nodeMap.set(targetFileNodeId, {
              id: targetFileNodeId,
              type: "file",
              name: path.posix.basename(ev.target.resolvedPath),
              path: ev.target.resolvedPath,
              language: "unknown",
              metadata: { status: "reference_only" },
            });
          }

          // Choose edge type based on evidence context (e.g. C/C++ includes vs imports)
          const isInclude = ev.resolver && ev.resolver.name && ev.resolver.name.includes("Cpp");
          const edgeType = isInclude ? "includes" : EDGE_SEMANTICS.IMPORTS;
          const edgeId = createEdgeId(sourceFileNodeId, edgeType, targetFileNodeId);

          const isConditional = Boolean(
            ev.isConditional ||
            (ev.evidence && ev.evidence.isConditional) ||
            (ev.languageMetadata && ev.languageMetadata.isConditional)
          );
          const conditionText =
            (ev.languageMetadata && ev.languageMetadata.condition) ||
            (ev.evidence && ev.evidence.condition) ||
            null;

          if (edgeMap.has(edgeId)) {
            // Deduplicate edge: append supporting evidence
            const existingEdge = edgeMap.get(edgeId);
            existingEdge.evidence.push(ev);
            // If any evidence is NOT conditional, the relationship is unconditional
            if (!isConditional) {
              existingEdge.semanticQualifier = null;
            }
          } else {
            edgeMap.set(edgeId, {
              id: edgeId,
              source: sourceFileNodeId,
              target: targetFileNodeId,
              type: edgeType,
              semanticQualifier: isConditional ? "conditional" : null,
              confirmed: true,
              metadata: conditionText ? { condition: conditionText } : {},
              evidence: [ev],
            });
          }
          continue;
        }
      }

      // 2B: External Package or Standard Library Reference
      if (
        includeExternalNodes &&
        (normalizedStatus === NORMALIZED_STATUSES.EXTERNAL_PACKAGE ||
          normalizedStatus === NORMALIZED_STATUSES.STANDARD_LIBRARY) &&
        ev.sourceFile
      ) {
        const sourceFileNodeId = createFileNodeId(repositoryId, commitSha, ev.sourceFile);
        if (nodeMap.has(sourceFileNodeId)) {
          const packageName = ev.target.packageName || ev.target.rawSpecifier || "unknown";
          const isBuiltin = normalizedStatus === NORMALIZED_STATUSES.STANDARD_LIBRARY;
          const ecosystem = ev.resolver && ev.resolver.name ? ev.resolver.name.replace("Resolver", "") : "generic";

          const externalNodeId = createExternalNodeId(ecosystem, packageName, { isBuiltin });

          if (!nodeMap.has(externalNodeId)) {
            nodeMap.set(externalNodeId, {
              id: externalNodeId,
              type: "external",
              name: packageName,
              language: ecosystem.toLowerCase(),
              metadata: {
                isBuiltin,
                ecosystem,
              },
            });
          }

          const extEdgeId = createEdgeId(sourceFileNodeId, EDGE_SEMANTICS.IMPORTS, externalNodeId);
          if (edgeMap.has(extEdgeId)) {
            edgeMap.get(extEdgeId).evidence.push(ev);
          } else {
            edgeMap.set(extEdgeId, {
              id: extEdgeId,
              source: sourceFileNodeId,
              target: externalNodeId,
              type: EDGE_SEMANTICS.IMPORTS,
              semanticQualifier: null,
              confirmed: true,
              evidence: [ev],
            });
          }
          continue;
        }
      }

      // 2C: Unresolved, Ambiguous, Dynamic, Unsupported, or Unconfirmed Call Facts
      unresolvedList.push({
        id: ev.id || `unres_${unresolvedList.length}`,
        category: ev.category || "dependency",
        sourceFile: ev.sourceFile || "unknown",
        rawSpecifier: ev.target ? ev.target.rawSpecifier : null,
        status: normalizedStatus,
        candidates: ev.target && Array.isArray(ev.target.candidates) ? [...ev.target.candidates] : null,
        rule: ev.resolver ? ev.resolver.rule : null,
        location: ev.sourceLocation || null,
        resolver: ev.resolver || null,
      });
    }

    // ------------------------------------------------------------------------
    // Step 3: Deterministic Sorting of All Collections
    // ------------------------------------------------------------------------
    const nodes = Array.from(nodeMap.values()).sort((a, b) => a.id.localeCompare(b.id));

    const edges = Array.from(edgeMap.values())
      .map((edge) => {
        // Deterministically sort internal evidence items for each edge
        edge.evidence.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
        return edge;
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const unresolvedReferences = unresolvedList.sort((a, b) => {
      const cmp = String(a.sourceFile || "").localeCompare(String(b.sourceFile || ""));
      if (cmp !== 0) return cmp;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });

    diagnostics.sort((a, b) => {
      const cmp = String(a.sourceFile || "").localeCompare(String(b.sourceFile || ""));
      if (cmp !== 0) return cmp;
      return String(a.code || "").localeCompare(String(b.code || ""));
    });

    // ------------------------------------------------------------------------
    // Step 4: Calculate Statistics
    // ------------------------------------------------------------------------
    let fileNodes = 0;
    let symbolNodes = 0;
    let externalNodes = 0;
    for (const node of nodes) {
      if (node.type === "file") fileNodes++;
      else if (node.type === "symbol") symbolNodes++;
      else if (node.type === "external") externalNodes++;
    }

    const edgesByType = {};
    for (const edge of edges) {
      edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
    }

    let ambiguousCount = 0;
    let unresolvedCount = 0;
    for (const unres of unresolvedReferences) {
      if (unres.status === NORMALIZED_STATUSES.AMBIGUOUS) {
        ambiguousCount++;
      } else {
        unresolvedCount++;
      }
    }

    const statistics = {
      totalNodes: nodes.length,
      fileNodes,
      symbolNodes,
      externalNodes,
      totalEdges: edges.length,
      edgesByType,
      unresolvedCount,
      ambiguousCount,
      totalDiagnostics: diagnostics.length,
      isPartial: Boolean(options.isPartial),
      completeness: options.isPartial ? "partial" : "complete",
    };

    return {
      schemaVersion: "1.0.0",
      graphId,
      repository: { repositoryId },
      revision: { commitSha },
      builder: {
        version: this.builderVersion,
        fileIrVersion: this.fileIrVersion,
        resolverFingerprint: fingerprint,
      },
      nodes,
      edges,
      unresolvedReferences,
      diagnostics,
      statistics,
    };
  }
}

module.exports = {
  GraphBuilder,
};

