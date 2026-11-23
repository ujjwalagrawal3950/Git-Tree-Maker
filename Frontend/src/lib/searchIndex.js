import {
  deriveDirectoryHierarchy,
  getAncestorDirectories,
  normalizePath,
  resolveFileFromMap,
} from './repositoryGraph.js'

/**
 * Computes the full cumulative ancestry chain for a folder ID.
 * e.g. "Backend/controllers/api" -> ["Backend", "Backend/controllers", "Backend/controllers/api"]
 *
 * @param {string} dirId
 * @returns {string[]}
 */
export function getFolderAncestry(dirId) {
  if (!dirId || dirId === 'root') return []
  const segments = dirId.split('/').filter(Boolean)
  const chain = []
  for (let i = 0; i < segments.length; i++) {
    chain.push(segments.slice(0, i + 1).join('/'))
  }
  return chain
}

/**
 * Builds a fast, in-memory search index over repository files, directories, and declared symbols.
 *
 * @param {object} repository - Repository model { files, edges, repository }
 * @returns {object} Search index
 */
export function buildSearchIndex(repository) {
  const items = []
  const files = Array.isArray(repository?.files) ? repository.files : []
  const repoName = repository?.repository || repository?.name || 'Repository'

  const hierarchy = deriveDirectoryHierarchy(repository)
  const { folderMap } = hierarchy

  // 1. Index directories
  for (const [dirId, folder] of folderMap.entries()) {
    if (dirId === 'root') continue
    items.push({
      type: 'folder',
      id: dirId,
      name: folder.name,
      label: folder.label || folder.name,
      path: dirId,
      depth: folder.depth ?? 0,
      parentId: folder.parentId,
      fileCount: folder.files?.length ?? 0,
      directFileCount: folder.directFiles?.length ?? 0,
      ancestors: getFolderAncestry(dirId),
    })
  }

  // 2. Index files & symbols
  for (const file of files) {
    const rawPath = file.path || file.data?.path || file.id
    const cleanPath = normalizePath(rawPath)
    const name = file.name || file.data?.label || cleanPath.split('/').pop() || cleanPath
    const explicitFolder = file.folder || file.data?.folder
    const ancestors = file.ancestors || getAncestorDirectories(cleanPath, explicitFolder)
    const kind = file.kind || file.data?.kind || 'file'

    const fileItem = {
      type: 'file',
      id: file.id,
      name,
      label: name,
      path: cleanPath,
      kind,
      directory: file.directory || ancestors[ancestors.length - 1] || 'root',
      ancestors,
    }
    items.push(fileItem)

    // Index declared symbols in file
    const symbols = file.symbols || file.data?.symbols || []
    for (const sym of symbols) {
      const symName = sym.name || sym.label || sym.id.split('#').pop()
      items.push({
        type: 'symbol',
        id: sym.id,
        name: symName,
        label: `${symName} (${name})`,
        symbolName: symName,
        symbolKind: sym.kind || 'symbol',
        fileId: file.id,
        fileName: name,
        filePath: cleanPath,
        path: `${cleanPath}#${symName}`,
        kind: sym.kind || 'symbol',
        ancestors,
      })
    }
  }

  return {
    repoName,
    items,
    folderMap,
  }
}

/**
 * Searches the index with relevance scoring and prefix/exact weighting.
 *
 * @param {object} index - Search index built by buildSearchIndex
 * @param {string} rawQuery - Search term
 * @param {number} [limit=20] - Max results
 * @returns {Array<object>} Ranked results
 */
export function searchRepository(index, rawQuery, limit = 20) {
  if (!index || !Array.isArray(index.items)) return []
  const query = (rawQuery || '').trim().toLowerCase()
  if (!query) return []

  const scored = []

  for (const item of index.items) {
    const nameLower = (item.name || '').toLowerCase()
    const pathLower = (item.path || '').toLowerCase()
    const kindLower = (item.kind || '').toLowerCase()

    let score = 0

    // Exact matches
    if (nameLower === query) {
      score += 100
    } else if (pathLower === query) {
      score += 85
    }
    // Prefix matches
    else if (nameLower.startsWith(query)) {
      score += 70
    } else if (pathLower.startsWith(query)) {
      score += 55
    }
    // Substring matches
    else if (nameLower.includes(query)) {
      score += 40
    } else if (pathLower.includes(query)) {
      score += 25
    } else if (kindLower.includes(query)) {
      score += 10
    }

    if (score > 0) {
      // Small bonus for shorter paths and direct files
      if (item.type === 'file') score += 2
      else if (item.type === 'folder') score += 1

      scored.push({
        ...item,
        score,
      })
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path),
  )

  return scored.slice(0, limit)
}

/**
 * Derives clickable breadcrumbs path based on the selected file, folder, or active context.
 *
 * @param {object} repository - Repository model
 * @param {string|null} selectedFileOrNodeId - Active selection
 * @param {Set|Array|null} expandedFolders - Expanded directory IDs
 * @returns {Array<object>} Breadcrumb segments
 */
export function deriveBreadcrumbs(repository, selectedFileOrNodeId, expandedFolders) {
  const repoName = repository?.repository || repository?.name || 'Repository'
  const crumbs = [
    {
      id: 'root',
      label: repoName,
      type: 'repo',
      targetId: null,
      isLast: false,
    },
  ]

  const hierarchy = deriveDirectoryHierarchy(repository)
  const { fileMap, folderMap } = hierarchy

  if (!selectedFileOrNodeId) {
    // If no node is selected, show most specific expanded directory if any
    const expandedList = Array.from(
      expandedFolders instanceof Set ? expandedFolders : [expandedFolders].filter(Boolean),
    ).filter((id) => id && id !== 'root')

    if (expandedList.length === 0) {
      crumbs[0].isLast = true
      return crumbs
    }

    // Pick the deepest expanded folder
    const deepest = expandedList.sort(
      (a, b) => (b.split('/').length) - (a.split('/').length),
    )[0]

    const ancestors = getFolderAncestry(deepest)
    for (let i = 0; i < ancestors.length; i++) {
      const dirId = ancestors[i]
      const folder = folderMap.get(dirId)
      crumbs.push({
        id: dirId,
        label: folder?.name || dirId.split('/').pop() || dirId,
        type: 'folder',
        targetId: dirId,
        isLast: i === ancestors.length - 1,
      })
    }
    return crumbs
  }

  // 1. If a file is selected
  const file = resolveFileFromMap(fileMap, selectedFileOrNodeId) || fileMap.get(selectedFileOrNodeId)
  if (file) {
    const ancestors = file.ancestors || [file.folder]
    for (const dirId of ancestors) {
      if (dirId === 'root') continue
      const folder = folderMap.get(dirId)
      crumbs.push({
        id: dirId,
        label: folder?.name || dirId.split('/').pop() || dirId,
        type: 'folder',
        targetId: dirId,
        isLast: false,
      })
    }
    crumbs.push({
      id: file.id,
      label: file.name,
      type: 'file',
      targetId: file.id,
      isLast: true,
    })
    return crumbs
  }

  // 2. If a folder is selected directly (e.g. "folder:Backend/controllers" or "Backend/controllers")
  const cleanFolderId = selectedFileOrNodeId.startsWith('folder:')
    ? selectedFileOrNodeId.slice(7)
    : selectedFileOrNodeId

  if (folderMap.has(cleanFolderId)) {
    const ancestors = getFolderAncestry(cleanFolderId)
    for (let i = 0; i < ancestors.length; i++) {
      const dirId = ancestors[i]
      if (dirId === 'root') continue
      const folder = folderMap.get(dirId)
      crumbs.push({
        id: dirId,
        label: folder?.name || dirId.split('/').pop() || dirId,
        type: 'folder',
        targetId: dirId,
        isLast: i === ancestors.length - 1,
      })
    }
    return crumbs
  }

  crumbs[0].isLast = true
  return crumbs
}
