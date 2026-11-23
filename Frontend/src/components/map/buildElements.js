import {
  FILE_HEIGHT,
  FILE_WIDTH,
  fileNodeId,
  folderNodeId,
  getLayout,
  isFolderExpanded,
  resolveVisibleNodeId,
  resolveFileFromMap,
} from '../../lib/repositoryGraph.js'

const TONE_RANK = { dim: 0, default: 1, incoming: 2, outgoing: 2 }

/**
 * Computes graph geometry (node positions, sizes, hierarchy, and visible aggregated edges).
 * This function invokes Dagre layout calculations and should be memoized strictly on
 * [repository, expandedFolders]. Selecting or dimming nodes NEVER re-runs this function.
 *
 * @param {object} repository - Repository model with files & edges
 * @param {string|Array|Set|null} expandedFolders - Expanded directory IDs
 * @returns {object} { nodes, edges, nodeParentMap, fileMap, expandedFolders }
 */
export function computeGraphGeometry(repository, expandedFolders, filterOptions = {}) {
  const { positions, folders, stats, fileMap } = getLayout(
    repository,
    expandedFolders,
    filterOptions,
  )

  const nodes = []
  const nodeParentMap = new Map() // nodeId -> parentNodeId (for hierarchical ancestor preservation)

  /**
   * Emits a folder node and (when expanded) recursively emits its direct subfolders
   * and direct files in strict pre-order so parentId always precedes its children.
   */
  const emitFolderNode = (folder, layoutBox, parentNodeId) => {
    const folderId = folderNodeId(folder.id)
    const folderStats = stats.get(folder.id)
    const expanded = isFolderExpanded(folder.id, expandedFolders)

    const node = {
      id: folderId,
      type: 'folder',
      position: { x: layoutBox.x, y: layoutBox.y },
      data: {
        folderId: folder.id,
        label: folder.label,
        path: folder.id,
        depth: folder.depth ?? 0,
        isRoot: Boolean(folder.isRoot || folder.id === 'root'),
        fileCount: folder.files.length,
        directFileCount: folder.directFiles?.length ?? folder.files.length,
        subfolderCount: folder.subfolders?.length ?? 0,
        incoming: folderStats?.incoming ?? 0,
        outgoing: folderStats?.outgoing ?? 0,
        internal: folderStats?.internal ?? 0,
        expanded,
        selected: false,
        dimmed: false,
      },
      style: { width: layoutBox.width, height: layoutBox.height },
      draggable: false,
      selectable: false,
    }

    if (parentNodeId) {
      node.parentId = parentNodeId
      node.extent = 'parent'
      nodeParentMap.set(folderId, parentNodeId)
    }

    nodes.push(node)

    if (!expanded || !Array.isArray(layoutBox.childLayouts)) return

    for (const child of layoutBox.childLayouts) {
      if (child.type === 'folder') {
        emitFolderNode(child.folder, child, folderId)
      } else if (child.type === 'file') {
        const fNodeId = fileNodeId(child.file.id)
        nodeParentMap.set(fNodeId, folderId)
        nodes.push({
          id: fNodeId,
          type: 'file',
          parentId: folderId,
          extent: 'parent',
          position: { x: child.x, y: child.y },
          data: {
            file: child.file,
            canonicalId: child.file.id,
            label: child.file.name,
            path: child.file.path,
            kind: child.file.kind,
            selected: false,
            dimmed: false,
          },
          style: { width: child.width ?? FILE_WIDTH, height: child.height ?? FILE_HEIGHT },
          draggable: false,
          selectable: false,
        })
      }
    }
  }

  for (const folder of folders) {
    const position = positions.get(folder.id)
    if (!position) continue
    emitFolderNode(folder, position, null)
  }

  const edgeMap = new Map()
  const rawEdges = Array.isArray(repository?.edges) ? repository.edges : []

  for (const edge of rawEdges) {
    const source = resolveFileFromMap(fileMap, edge.source)
    const target = resolveFileFromMap(fileMap, edge.target)
    if (!source || !target) continue

    const sourceNode = resolveVisibleNodeId(source, expandedFolders)
    const targetNode = resolveVisibleNodeId(target, expandedFolders)

    // Skip self-edges when both ends collapse to the same visible node
    if (sourceNode === targetNode) continue

    // Classify directory and subsystem boundaries
    const sourceDirectory =
      source.directory ||
      (source.path ? source.path.split('/').slice(0, -1).join('/') : 'root') ||
      'root'
    const targetDirectory =
      target.directory ||
      (target.path ? target.path.split('/').slice(0, -1).join('/') : 'root') ||
      'root'
    const sourceSubsystem = source.folder || 'root'
    const targetSubsystem = target.folder || 'root'
    const isCrossDirectory = sourceDirectory !== targetDirectory
    const isCrossSubsystem = sourceSubsystem !== targetSubsystem

    // Cross-Directory Only filtering (Safeguard 2: only filters edges, zero effect on node positions)
    if (filterOptions?.crossDirectoryOnly && !isCrossDirectory) {
      continue
    }

    const canonicalEdgeId = edge.id || `canonical:${source.id}->${target.id}`
    const rawType = edge.data?.edgeType || edge.type || 'imports'

    // Relationship Type Filtering (Stage 5): 'all' | 'code' | 'http'
    const relationshipFilter =
      filterOptions?.relationshipFilter || filterOptions?.edgeTypeFilter || 'all'
    if (relationshipFilter === 'http' || relationshipFilter === 'http_only') {
      if (rawType !== 'http_request') continue
    } else if (relationshipFilter === 'code' || relationshipFilter === 'static_only') {
      if (rawType === 'http_request') continue
    }

    const isHttp = rawType === 'http_request'
    const httpMetadata =
      edge.metadata ||
      edge.data?.metadata ||
      (Array.isArray(edge.evidence) && edge.evidence[0]?.metadata) ||
      {}
    const httpMethod =
      httpMetadata.httpMethod ||
      edge.data?.httpMethod ||
      (Array.isArray(edge.evidence) && edge.evidence[0]?.target?.httpMethod) ||
      (edge.semanticQualifier && edge.semanticQualifier.split(':')[0]) ||
      null
    const composedRoutePath =
      httpMetadata.composedRoutePath ||
      edge.data?.composedRoutePath ||
      (Array.isArray(edge.evidence) && edge.evidence[0]?.target?.composedRoutePath) ||
      (edge.semanticQualifier && edge.semanticQualifier.split(':')[1]) ||
      null

    const underlyingRecord = {
      id: canonicalEdgeId,
      sourceId: source.id,
      targetId: target.id,
      sourcePath: source.path || source.id,
      targetPath: target.path || target.id,
      sourceName: source.name || (source.path ? source.path.split('/').pop() : source.id),
      targetName: target.name || (target.path ? target.path.split('/').pop() : target.id),
      sourceDirectory,
      targetDirectory,
      sourceSubsystem,
      targetSubsystem,
      type: rawType,
      metadata: isHttp ? { ...httpMetadata, httpMethod, composedRoutePath } : (edge.metadata || null),
      evidence: edge.evidence || edge.data?.evidence || null,
      raw: edge,
    }

    const key = `${sourceNode}\u0000${targetNode}`
    const existing = edgeMap.get(key)
    if (existing) {
      existing.count += 1
      existing.underlyingEdges.push(underlyingRecord)
      existing.isAggregated = true
      if (isCrossDirectory) existing.hasCrossDirectory = true
      if (isCrossSubsystem) existing.hasCrossSubsystem = true
      if (isHttp) existing.hasHttpRequest = true
      if (!isHttp) existing.hasStaticDependency = true

      if (existing.hasHttpRequest && existing.hasStaticDependency) {
        existing.label = `connections (${existing.count})`
      } else if (existing.hasHttpRequest) {
        existing.label = `HTTP (${existing.count})`
      } else {
        existing.label = `${existing.baseLabel} (${existing.count})`
      }
      continue
    }

    // Determine descriptive relationship label
    let baseLabel = 'imports'
    if (rawType === 'calls') baseLabel = 'calls'
    else if (rawType === 'renders') baseLabel = 'renders'
    else if (rawType === 'uses') baseLabel = 'uses'
    else if (rawType === 'depends_on') baseLabel = 'depends on'
    else if (rawType === 'references') baseLabel = 'references'
    else if (isHttp) {
      baseLabel = composedRoutePath
        ? `${httpMethod || 'HTTP'} ${composedRoutePath}`
        : `HTTP ${httpMethod || 'request'}`
    } else if (edge.label && typeof edge.label === 'string') {
      baseLabel = edge.label
    }

    const isAggregated = Boolean(
      sourceNode.startsWith('folder:') || targetNode.startsWith('folder:'),
    )

    edgeMap.set(key, {
      id: `edge:${key}`,
      source: sourceNode,
      target: targetNode,
      count: 1,
      type: rawType,
      data: {
        edgeType: rawType,
        isHttpRequest: isHttp,
        httpMethod,
        composedRoutePath,
        metadata: httpMetadata,
      },
      baseLabel,
      label: baseLabel,
      tone: 'default',
      selected: false,
      isAggregated,
      isCrossDirectory,
      isCrossSubsystem,
      hasCrossDirectory: isCrossDirectory,
      hasCrossSubsystem: isCrossSubsystem,
      hasHttpRequest: isHttp,
      hasStaticDependency: !isHttp,
      sourceSubsystem,
      targetSubsystem,
      underlyingEdges: [underlyingRecord],
    })
  }

  const edges = [...edgeMap.values()].sort((a, b) => a.id.localeCompare(b.id))

  return {
    nodes,
    edges,
    nodeParentMap,
    fileMap,
    expandedFolders,
  }
}

/**
 * Decorates cached graph geometry elements with selection, dimming, and directional tones in O(V + E).
 * Executes in < 1ms without invoking Dagre or recalculating layout coordinates.
 *
 * @param {object} geometry - Output of computeGraphGeometry
 * @param {string|null} selectedFileOrNodeId - Selected canonical file ID or visible node ID
 * @param {string|null} [selectedEdgeId] - Selected edge ID
 * @returns {object} { nodes, edges }
 */
export function decorateGraphElements(geometry, selectedFileOrNodeId, selectedEdgeId) {
  if (!geometry || !Array.isArray(geometry.nodes)) {
    return { nodes: [], edges: [] }
  }

  const { nodes: rawNodes, edges: rawEdges, nodeParentMap, fileMap, expandedFolders } = geometry

  // Resolve selected node ID (supports either canonical file ID or visible node ID)
  let selectedNodeId = null
  let selectedAncestorFolderNodeIds = new Set()

  if (selectedFileOrNodeId) {
    const selectedFile = fileMap?.get(selectedFileOrNodeId)
    if (selectedFile) {
      selectedNodeId = resolveVisibleNodeId(selectedFile, expandedFolders)
      selectedAncestorFolderNodeIds = new Set(
        (selectedFile.ancestors || [selectedFile.folder]).map(folderNodeId),
      )
    } else {
      selectedNodeId = selectedFileOrNodeId
      // If a folder node was directly selected
      if (selectedNodeId.startsWith('folder:')) {
        selectedAncestorFolderNodeIds = new Set([selectedNodeId])
      }
    }
  }

  // Determine connected nodes (and their containing ancestor folders) for selection dimming
  const connected = new Set()
  const addWithAncestors = (nodeId) => {
    let curr = nodeId
    while (curr && !connected.has(curr)) {
      connected.add(curr)
      curr = nodeParentMap.get(curr) || null
    }
  }

  if (selectedNodeId) {
    addWithAncestors(selectedNodeId)
    for (const ancId of selectedAncestorFolderNodeIds) {
      addWithAncestors(ancId)
    }

    for (const edge of rawEdges) {
      if (edge.source === selectedNodeId) {
        addWithAncestors(edge.target)
      }
      if (edge.target === selectedNodeId) {
        addWithAncestors(edge.source)
      }
    }
  }

  // Apply node decoration
  const decoratedNodes = rawNodes.map((node) => {
    const isNodeSelected =
      node.id === selectedNodeId ||
      node.data?.canonicalId === selectedFileOrNodeId ||
      selectedAncestorFolderNodeIds.has(node.id)

    const isDimmed = Boolean(selectedNodeId) && !connected.has(node.id)

    if (node.data.selected === isNodeSelected && node.data.dimmed === isDimmed) {
      return node
    }

    return {
      ...node,
      data: {
        ...node.data,
        selected: isNodeSelected,
        dimmed: isDimmed,
      },
    }
  })

  // Apply edge decoration & tones
  const decoratedEdges = rawEdges.map((edge) => {
    const isEdgeSelected = Boolean(selectedEdgeId && edge.id === selectedEdgeId)
    let tone = 'default'

    if (selectedNodeId) {
      if (edge.source === selectedNodeId) tone = 'outgoing'
      else if (edge.target === selectedNodeId) tone = 'incoming'
      else tone = 'dim'
    }

    if (edge.tone === tone && edge.selected === isEdgeSelected) {
      return edge
    }

    return {
      ...edge,
      tone,
      selected: isEdgeSelected,
    }
  })

  decoratedEdges.sort(
    (a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.id.localeCompare(b.id),
  )

  return {
    nodes: decoratedNodes,
    edges: decoratedEdges,
  }
}

/**
 * Backwards-compatible composition wrapper for building complete elements.
 *
 * @param {object} repository - Repository model with files & edges
 * @param {string|Array|Set|null} expandedFolders - Expanded directory IDs
 * @param {string|null} selectedFileId - Selected node or file ID
 * @param {string|null} [selectedEdgeId=null] - Selected edge ID
 * @param {object} [filterOptions={}] - Filtering options, e.g. { crossDirectoryOnly: boolean }
 * @returns {object} { nodes, edges }
 */
export function buildElements(
  repository,
  expandedFolders,
  selectedFileId,
  selectedEdgeId = null,
  filterOptions = {},
) {
  const geometry = computeGraphGeometry(repository, expandedFolders, filterOptions)
  return decorateGraphElements(geometry, selectedFileId, selectedEdgeId)
}
