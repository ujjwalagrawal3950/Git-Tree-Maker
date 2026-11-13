import dagre from 'dagre'
import { NODE_TYPES } from './graphTransformer.js'

export const NODE_DIMENSIONS = {
  [NODE_TYPES.FILE]: { width: 220, height: 48 },
  [NODE_TYPES.SYMBOL]: { width: 190, height: 40 },
  [NODE_TYPES.EXTERNAL]: { width: 170, height: 36 },
  default: { width: 200, height: 44 },
}

export function getNodeDimensions(type) {
  return NODE_DIMENSIONS[type] || NODE_DIMENSIONS.default
}

/**
 * Computes deterministic Dagre layout for React Flow nodes and edges.
 *
 * @param {Array} nodes - React Flow nodes (with canonical IDs)
 * @param {Array} edges - React Flow edges (with canonical IDs)
 * @param {Object} options - Layout configuration
 * @returns {Array} Positioned React Flow nodes
 */
export function layoutGraphElements(nodes, edges, options = {}) {
  const {
    direction = 'LR', // 'TB' or 'LR'
    ranksep = 70,
    nodesep = 50,
  } = options

  if (!nodes || nodes.length === 0) {
    return []
  }

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    ranksep,
    nodesep,
    marginx: 40,
    marginy: 40,
  })

  // Sort nodes by canonical ID to guarantee 100% layout determinism across runs
  const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id))
  for (const node of sortedNodes) {
    const dim = getNodeDimensions(node.type)
    g.setNode(node.id, { width: dim.width, height: dim.height })
  }

  // Sort edges by source and target canonical IDs for determinism
  const sortedEdges = [...edges].sort((a, b) => {
    const cmp = a.source.localeCompare(b.source)
    return cmp !== 0 ? cmp : a.target.localeCompare(b.target)
  })

  for (const edge of sortedEdges) {
    // Only add edge to layout graph if both endpoints exist in the node set
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(g)

  // Map calculated coordinates back to React Flow nodes without altering node.id
  return sortedNodes.map((node) => {
    const dagreNode = g.node(node.id)
    const dim = getNodeDimensions(node.type)

    if (!dagreNode) {
      return node
    }

    // Dagre returns center x, y; React Flow positions from top-left
    const x = Math.round(dagreNode.x - dim.width / 2)
    const y = Math.round(dagreNode.y - dim.height / 2)

    return {
      ...node,
      position: { x, y },
    }
  })
}
