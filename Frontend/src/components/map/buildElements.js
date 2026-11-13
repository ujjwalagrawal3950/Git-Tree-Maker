import {
  EXPANDED_CHILD_X,
  EXPANDED_HEADER_HEIGHT,
  FILE_HEIGHT,
  FILE_STEP,
  FILE_WIDTH,
  buildFileMap,
  fileNodeId,
  folderNodeId,
  getLayout,
} from '../../lib/repositoryGraph'

const TONE_RANK = { dim: 0, default: 1, incoming: 2, outgoing: 2 }

export function buildElements(repository, expandedFolderId, selectedFileId) {
  const fileMap = buildFileMap(repository)
  const { positions, folders, stats } = getLayout(
    repository,
    expandedFolderId,
  )

  const selectedFile = selectedFileId ? fileMap.get(selectedFileId) : null
  const selectedNodeId = selectedFile ? fileNodeId(selectedFile.id) : null
  const selectedFolderNodeId = selectedFile
    ? folderNodeId(selectedFile.folder)
    : null

  const nodes = []

  for (const folder of folders) {
    const position = positions.get(folder.id)
    const folderStats = stats.get(folder.id)
    const expanded = folder.id === expandedFolderId

    nodes.push({
      id: folderNodeId(folder.id),
      type: 'folder',
      position: { x: position.x, y: position.y },
      data: {
        folderId: folder.id,
        label: folder.label,
        fileCount: folder.files.length,
        incoming: folderStats?.incoming ?? 0,
        outgoing: folderStats?.outgoing ?? 0,
        expanded,
        selected: selectedFolderNodeId === folderNodeId(folder.id),
        dimmed: false,
      },
      style: { width: position.width, height: position.height },
      draggable: false,
      selectable: false,
    })

    if (!expanded) continue

    folder.files.forEach((file, index) => {
      nodes.push({
        id: fileNodeId(file.id),
        type: 'file',
        parentId: folderNodeId(folder.id),
        extent: 'parent',
        position: {
          x: EXPANDED_CHILD_X,
          y: EXPANDED_HEADER_HEIGHT + index * FILE_STEP,
        },
        data: {
          file,
          selected: selectedFileId === file.id,
          dimmed: false,
        },
        style: { width: FILE_WIDTH, height: FILE_HEIGHT },
        draggable: false,
        selectable: false,
      })
    })
  }

  const edgeMap = new Map()

  for (const edge of repository.edges) {
    const source = fileMap.get(edge.source)
    const target = fileMap.get(edge.target)
    if (!source || !target) continue

    const sourceExpanded = source.folder === expandedFolderId
    const targetExpanded = target.folder === expandedFolderId
    const sourceNode = sourceExpanded
      ? fileNodeId(source.id)
      : folderNodeId(source.folder)
    const targetNode = targetExpanded
      ? fileNodeId(target.id)
      : folderNodeId(target.folder)

    if (sourceNode === targetNode) continue

    const key = `${sourceNode}\u0000${targetNode}`
    const existing = edgeMap.get(key)
    if (existing) {
      existing.count += 1
      continue
    }

    edgeMap.set(key, {
      id: `edge:${key}`,
      source: sourceNode,
      target: targetNode,
      count: 1,
      tone: 'default',
    })
  }

  const connected = new Set()
  if (selectedNodeId) {
    connected.add(selectedNodeId)
    if (selectedFolderNodeId) connected.add(selectedFolderNodeId)

    for (const edge of edgeMap.values()) {
      if (edge.source === selectedNodeId) connected.add(edge.target)
      if (edge.target === selectedNodeId) connected.add(edge.source)
    }
  }

  for (const node of nodes) {
    node.data.dimmed = Boolean(selectedNodeId) && !connected.has(node.id)
  }

  for (const edge of edgeMap.values()) {
    if (!selectedNodeId) continue
    if (edge.source === selectedNodeId) edge.tone = 'outgoing'
    else if (edge.target === selectedNodeId) edge.tone = 'incoming'
    else edge.tone = 'dim'
  }

  const edges = [...edgeMap.values()].sort(
    (a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.id.localeCompare(b.id),
  )

  return { nodes, edges }
}
