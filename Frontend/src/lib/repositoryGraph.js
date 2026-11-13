import dagre from 'dagre'

export const FOLDER_WIDTH = 220
export const FOLDER_HEIGHT = 78
export const EXPANDED_FOLDER_WIDTH = 264
export const FILE_WIDTH = 232
export const FILE_HEIGHT = 46
export const FILE_STEP = 54
export const EXPANDED_HEADER_HEIGHT = 48
export const EXPANDED_CHILD_X = (EXPANDED_FOLDER_WIDTH - FILE_WIDTH) / 2

export function folderNodeId(folderId) {
  return `folder:${folderId}`
}

export function fileNodeId(fileId) {
  return `file:${fileId}`
}

export function buildFileMap(repository) {
  return new Map(repository.files.map((file) => [file.id, file]))
}

export function getFolders(repository) {
  const folders = new Map()

  for (const file of repository.files) {
    if (!folders.has(file.folder)) folders.set(file.folder, [])
    folders.get(file.folder).push(file)
  }

  return [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, folderFiles]) => ({
      id,
      label: id === 'root' ? 'root' : id,
      files: [...folderFiles].sort((a, b) => a.path.localeCompare(b.path)),
    }))
}

export function getFolderStats(repository) {
  const fileMap = buildFileMap(repository)
  const stats = new Map(
    getFolders(repository).map((folder) => [
      folder.id,
      { fileCount: folder.files.length, incoming: 0, outgoing: 0 },
    ]),
  )

  for (const edge of repository.edges) {
    const source = fileMap.get(edge.source)
    const target = fileMap.get(edge.target)
    if (!source || !target || source.folder === target.folder) continue

    const sourceStats = stats.get(source.folder)
    const targetStats = stats.get(target.folder)
    if (sourceStats) sourceStats.outgoing += 1
    if (targetStats) targetStats.incoming += 1
  }

  return stats
}

export function getFolderEdges(repository) {
  const fileMap = buildFileMap(repository)
  const pairs = new Map()

  for (const edge of repository.edges) {
    const source = fileMap.get(edge.source)
    const target = fileMap.get(edge.target)
    if (!source || !target || source.folder === target.folder) continue

    const key = `${source.folder}\u0000${target.folder}`
    const pair = pairs.get(key)
    if (pair) {
      pair.count += 1
    } else {
      pairs.set(key, { source: source.folder, target: target.folder, count: 1 })
    }
  }

  return [...pairs.values()].sort(
    (a, b) =>
      a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  )
}

export function expandedFolderHeight(fileCount) {
  return EXPANDED_HEADER_HEIGHT + fileCount * FILE_STEP + 4
}

export function getLayout(repository, expandedFolderId) {
  const folders = getFolders(repository)
  const folderEdges = getFolderEdges(repository)
  const graph = new dagre.graphlib.Graph()

  graph.setGraph({
    rankdir: 'LR',
    nodesep: 40,
    ranksep: 96,
    marginx: 32,
    marginy: 32,
  })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const folder of folders) {
    const expanded = folder.id === expandedFolderId
    graph.setNode(folder.id, {
      width: expanded ? EXPANDED_FOLDER_WIDTH : FOLDER_WIDTH,
      height: expanded
        ? expandedFolderHeight(folder.files.length)
        : FOLDER_HEIGHT,
    })
  }

  for (const edge of folderEdges) {
    graph.setEdge(edge.source, edge.target, { weight: edge.count })
  }

  dagre.layout(graph)

  const positions = new Map()
  for (const folder of folders) {
    const node = graph.node(folder.id)
    positions.set(folder.id, {
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
    })
  }

  return {
    positions,
    folders,
    folderEdges,
    stats: getFolderStats(repository),
  }
}

export function getFileNeighbours(repository, fileId) {
  const fileMap = buildFileMap(repository)
  const imports = new Set()
  const importedBy = new Set()

  for (const edge of repository.edges) {
    if (edge.source === fileId) imports.add(edge.target)
    if (edge.target === fileId) importedBy.add(edge.source)
  }

  const byPath = (a, b) => {
    const pathA = fileMap.get(a)?.path ?? a
    const pathB = fileMap.get(b)?.path ?? b
    return pathA.localeCompare(pathB)
  }

  return {
    imports: [...imports].sort(byPath),
    importedBy: [...importedBy].sort(byPath),
  }
}
