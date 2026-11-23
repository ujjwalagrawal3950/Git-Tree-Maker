import dagre from 'dagre'

export const FOLDER_WIDTH = 240
export const FOLDER_HEIGHT = 74
export const EXPANDED_FOLDER_WIDTH = 280
export const FILE_WIDTH = 256
export const FILE_HEIGHT = 38
export const FILE_STEP = 46
export const EXPANDED_HEADER_HEIGHT = 44
export const EXPANDED_CHILD_X = (EXPANDED_FOLDER_WIDTH - FILE_WIDTH) / 2

export function folderNodeId(folderId) {
  return `folder:${folderId}`
}

export function fileNodeId(fileId) {
  return `file:${fileId}`
}

export function getFolderColumnCount(fileCount) {
  if (fileCount <= 18) return 1
  return 3
}

export function expandedFolderWidth(fileCount) {
  const cols = getFolderColumnCount(fileCount)
  if (cols === 1) return EXPANDED_FOLDER_WIDTH
  return 24 + cols * (FILE_WIDTH + 12)
}

export function expandedFolderHeight(fileCount) {
  const cols = getFolderColumnCount(fileCount)
  if (cols === 1) {
    return EXPANDED_HEADER_HEIGHT + fileCount * FILE_STEP + 12
  }
  const rows = Math.ceil(fileCount / cols)
  return EXPANDED_HEADER_HEIGHT + rows * FILE_STEP + 16
}

export function getChildFilePosition(index, fileCount) {
  const cols = getFolderColumnCount(fileCount)
  if (cols === 1) {
    return {
      x: EXPANDED_CHILD_X,
      y: EXPANDED_HEADER_HEIGHT + index * FILE_STEP,
    }
  }
  const rows = Math.ceil(fileCount / cols)
  const colIndex = Math.floor(index / rows)
  const rowIndex = index % rows
  return {
    x: 14 + colIndex * (FILE_WIDTH + 12),
    y: EXPANDED_HEADER_HEIGHT + rowIndex * FILE_STEP,
  }
}

/**
 * Normalizes a repository file path (POSIX separators, trimmed, stripped of leading slash).
 *
 * @param {string} rawPath
 * @returns {string} Normalized POSIX relative path
 */
export function normalizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return ''
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .trim()
}

/**
 * Extracts top-level directory identifier from canonical file path.
 * Top-level files default to 'root'.
 *
 * @param {string} filePath
 * @param {string} [folderProp]
 * @returns {string} Directory identifier
 */
export function getDirectoryFromPath(filePath, folderProp) {
  if (folderProp && typeof folderProp === 'string') return folderProp
  const clean = normalizePath(filePath)
  if (!clean) return 'root'
  const parts = clean.split('/').filter(Boolean)
  if (parts.length <= 1) return 'root'
  if (parts[0] === 'src' && parts.length > 2) {
    return parts[1]
  }
  return parts[0]
}

/**
 * Extracts the full nested directory path for a file.
 * Returns 'root' for root-level files.
 *
 * @param {string} filePath
 * @returns {string} e.g. "Frontend/src/components" or "root"
 */
export function getNestedDirectoryFromPath(filePath) {
  const clean = normalizePath(filePath)
  if (!clean) return 'root'
  const lastSlash = clean.lastIndexOf('/')
  if (lastSlash === -1) return 'root'
  return clean.slice(0, lastSlash)
}

/**
 * Extracts normalized canonical file path from any valid node ID or endpoint string.
 * Strips symbol anchors (#symbol), 'file:' prefixes, and revision-scoped prefix (`${repo}@${commitSha}:`).
 *
 * @param {string} idStr
 * @returns {string} Normalized POSIX relative path
 */
export function extractCanonicalPath(idStr) {
  if (!idStr || typeof idStr !== 'string') return ''
  const withoutSymbol = idStr.includes('#') ? idStr.split('#')[0] : idStr
  if (withoutSymbol.startsWith('file:')) {
    return normalizePath(withoutSymbol.slice(5))
  }
  // Canonical revision-scoped format: "owner/repo@commitSha:relative/path"
  const colonIdx = withoutSymbol.indexOf(':')
  if (colonIdx !== -1 && withoutSymbol.includes('@')) {
    return normalizePath(withoutSymbol.slice(colonIdx + 1))
  }
  return normalizePath(withoutSymbol)
}

/**
 * Resolves an endpoint identifier (revision-scoped ID, file: URI, bare path, or symbol ID)
 * to its corresponding normalized file record from a fileMap.
 *
 * @param {Map<string, object>} fileMap
 * @param {string} endpointId
 * @returns {object|null}
 */
export function resolveFileFromMap(fileMap, endpointId) {
  if (!fileMap || !endpointId) return null
  if (fileMap.has(endpointId)) return fileMap.get(endpointId)
  if (typeof endpointId !== 'string') return null

  // 1. Strip 'file:' prefix
  if (endpointId.startsWith('file:')) {
    const unprefix = endpointId.slice(5)
    if (fileMap.has(unprefix)) return fileMap.get(unprefix)
  }

  // 2. Extract canonical path (stripping repo@commitSha: and/or #symbol)
  const canonicalPath = extractCanonicalPath(endpointId)
  if (canonicalPath) {
    if (fileMap.has(canonicalPath)) return fileMap.get(canonicalPath)
    if (fileMap.has(`file:${canonicalPath}`)) return fileMap.get(`file:${canonicalPath}`)
  }

  // 3. Strip symbol anchor (#)
  if (endpointId.includes('#')) {
    const baseId = endpointId.split('#')[0]
    if (fileMap.has(baseId)) return fileMap.get(baseId)
    const baseCanonical = extractCanonicalPath(baseId)
    if (baseCanonical && fileMap.has(baseCanonical)) return fileMap.get(baseCanonical)
  }

  return null
}

/**
 * Infers visual category/kind for a file based on extension and filename.
 * Used for manifest files that have no language parser FileIR node.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function inferFileKind(filePath) {
  const clean = normalizePath(filePath).toLowerCase()
  const basename = clean.split('/').pop() || ''
  const dotIndex = basename.lastIndexOf('.')
  const ext = dotIndex !== -1 ? basename.slice(dotIndex) : ''

  // Documentation
  if (
    ext === '.md' ||
    ext === '.txt' ||
    ext === '.rst' ||
    ext === '.adoc' ||
    basename.startsWith('readme') ||
    basename.startsWith('license') ||
    basename.startsWith('changelog')
  ) {
    return 'doc'
  }

  // Configuration & Build Manifests
  if (
    basename === 'package.json' ||
    basename === 'tsconfig.json' ||
    basename === 'pom.xml' ||
    basename === 'cargo.toml' ||
    basename === 'pyproject.toml' ||
    basename === 'cmakelists.txt' ||
    basename === 'makefile' ||
    basename.startsWith('.git') ||
    basename.startsWith('.env') ||
    ext === '.json' ||
    ext === '.yaml' ||
    ext === '.yml' ||
    ext === '.toml' ||
    ext === '.xml' ||
    ext === '.ini'
  ) {
    return 'config'
  }

  // Tests
  if (
    clean.includes('.test.') ||
    clean.includes('.spec.') ||
    clean.includes('__tests__') ||
    clean.includes('/test/') ||
    clean.includes('/tests/')
  ) {
    return 'test'
  }

  // Styles
  if (ext === '.css' || ext === '.scss' || ext === '.sass' || ext === '.less') {
    return 'style'
  }

  // Assets / Media
  if (
    ext === '.png' ||
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.gif' ||
    ext === '.svg' ||
    ext === '.ico' ||
    ext === '.webp' ||
    ext === '.woff' ||
    ext === '.woff2' ||
    ext === '.ttf' ||
    ext === '.eot'
  ) {
    return 'asset'
  }

  // Code Sources
  if (
    ext === '.js' ||
    ext === '.jsx' ||
    ext === '.mjs' ||
    ext === '.cjs' ||
    ext === '.ts' ||
    ext === '.tsx' ||
    ext === '.mts' ||
    ext === '.cts' ||
    ext === '.py' ||
    ext === '.pyi' ||
    ext === '.java' ||
    ext === '.c' ||
    ext === '.cpp' ||
    ext === '.cc' ||
    ext === '.cxx' ||
    ext === '.h' ||
    ext === '.hh' ||
    ext === '.hpp' ||
    ext === '.hxx' ||
    ext === '.go' ||
    ext === '.rs' ||
    ext === '.cs' ||
    ext === '.php' ||
    ext === '.rb' ||
    ext === '.kt' ||
    ext === '.kts' ||
    ext === '.swift' ||
    ext === '.dart' ||
    ext === '.scala' ||
    ext === '.sc'
  ) {
    return 'source'
  }

  return 'file'
}

/**
 * Authoritative set of supported source-code extensions (consistent with Backend languageRegistry).
 */
export const SOURCE_CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi',
  '.java',
  '.c', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h',
  '.go',
  '.rs',
  '.cs',
  '.php',
  '.rb',
  '.kt', '.kts',
  '.swift',
  '.dart',
  '.scala', '.sc',
])

/**
 * Authoritative required configuration and metadata filenames.
 */
export const REQUIRED_CONFIG_FILENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'setup.py',
  'setup.cfg',
  'compile_commands.json',
  'cmakelists.txt',
  'makefile',
  'gnumakefile',
  'gemfile',
  'composer.json',
  'gradle.properties',
])

export const REQUIRED_CONFIG_EXTENSIONS = new Set([
  '.toml',
  '.ini',
  '.conf',
  '.mk',
])

export function isSourceCodePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  const clean = normalizePath(filePath).toLowerCase()
  const basename = clean.split('/').pop() || ''
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex === -1) return false
  const ext = basename.slice(dotIndex)
  return SOURCE_CODE_EXTENSIONS.has(ext)
}

export function isRequiredConfigPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  const clean = normalizePath(filePath).toLowerCase()
  const basename = clean.split('/').pop() || ''
  if (REQUIRED_CONFIG_FILENAMES.has(basename)) return true
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex !== -1) {
    const ext = basename.slice(dotIndex)
    if (REQUIRED_CONFIG_EXTENSIONS.has(ext)) return true
  }
  return false
}

export function isEligibleCodeFile(file) {
  if (!file) return false
  if (file.isParsed) return true
  if (['entry', 'component', 'hook', 'utility', 'test', 'source', 'style'].includes(file.kind)) {
    return true
  }
  const filePath = file.path || file.id || ''
  return isSourceCodePath(filePath)
}

export function isEligibleWorkspaceFile(file) {
  if (!file) return false
  if (isEligibleCodeFile(file)) return true
  if (file.kind === 'config') return true
  const filePath = file.path || file.id || ''
  return isRequiredConfigPath(filePath)
}

/**
 * Computes the set of directories that contain at least one eligible source-code descendant.
 * Strictly descendant-based: a directory named "docs" or "assets" is included IF AND ONLY IF
 * it contains an eligible code descendant (e.g. docs/examples/demo.js).
 * Non-code-only branches (e.g. docs/ containing only .md or media/ containing only .png) are omitted.
 *
 * @param {Array<object>} files
 * @param {Array<object>} [edges=[]]
 * @returns {Set<string>} Set of code-eligible directory IDs
 */
export function computeCodeEligibleDirectories(files, edges = []) {
  const eligibleDirs = new Set()
  if (!Array.isArray(files)) return eligibleDirs

  const edgeParticipantFileIds = new Set()
  for (const edge of edges || []) {
    if (edge.source) edgeParticipantFileIds.add(edge.source)
    if (edge.target) edgeParticipantFileIds.add(edge.target)
  }

  for (const raw of files) {
    const fileId = raw.id || raw.path || ''
    const filePath = raw.path || raw.id || ''
    const isEdgeParticipant =
      edgeParticipantFileIds.has(fileId) ||
      edgeParticipantFileIds.has(filePath) ||
      edgeParticipantFileIds.has(`file:${filePath}`)

    if (isEligibleCodeFile(raw) || isEdgeParticipant) {
      const cleanPath = normalizePath(filePath)
      const explicitFolder = raw.folder || raw.data?.folder
      const ancestors = getAncestorDirectories(cleanPath, explicitFolder)
      for (const dirId of ancestors) {
        eligibleDirs.add(dirId)
      }
    }
  }

  return eligibleDirs
}

/**
 * Checks if a given folder ID is currently expanded.
 * Supports string, Array, Set, or record.
 *
 * @param {string} folderId
 * @param {string|Array|Set|object} expanded
 * @returns {boolean}
 */
export function isFolderExpanded(folderId, expanded) {
  if (!expanded) return false
  if (typeof expanded === 'string') return expanded === folderId
  if (expanded instanceof Set) return expanded.has(folderId)
  if (Array.isArray(expanded)) return expanded.includes(folderId)
  if (typeof expanded === 'object') return Boolean(expanded[folderId])
  return false
}

/**
 * Authoritatively merges repository manifest files with canonical graph elements.
 * Preserves complete repository presence (Docs, Frontend, root files, unparsed files)
 * while overlaying confirmed graph dependencies and AST statuses.
 *
 * Strictly separates Files from declared Symbols:
 * - Files populate the directory hierarchy and React Flow canvas containers.
 * - Symbols are associated with their declaring file (file.symbols) for progressive detail inspection.
 * - Symbol-level call edges are lifted to file-to-file relationships, eliminating canvas clutter.
 *
 * @param {object} params
 * @param {object} params.manifest - Authoritative repository manifest from Git tree
 * @param {object} [params.graphSummary] - Canonical graph summary metadata
 * @param {Array<object>} [params.graphNodes=[]] - React Flow nodes from canonical graph
 * @param {Array<object>} [params.graphEdges=[]] - React Flow edges from canonical graph
 * @returns {object} Merged repository model { repository, commitSha, files, edges, rawEdges, manifestSummary }
 */
export function mergeManifestWithGraph({
  manifest,
  graphSummary = null,
  graphNodes = [],
  graphEdges = [],
}) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('Repository manifest is missing or invalid.')
  }

  // Guard against combining graph and manifest from different commits
  if (
    graphSummary &&
    manifest.commitSha &&
    graphSummary.commitSha &&
    manifest.commitSha !== graphSummary.commitSha
  ) {
    throw new Error(
      `Commit mismatch: graph snapshot (${graphSummary.commitSha.slice(0, 7)}) does not match manifest (${manifest.commitSha.slice(0, 7)}).`,
    )
  }

  // Index canonical graph file nodes by normalized path AND symbols by declaring file path
  const graphFileMapByPath = new Map()
  const symbolsByFilePath = new Map()
  const symbolToFilePath = new Map()

  for (const node of graphNodes || []) {
    const rawPath = node.data?.path || node.path

    if (node.type === 'symbol') {
      if (rawPath) {
        const clean = normalizePath(rawPath)
        if (!symbolsByFilePath.has(clean)) {
          symbolsByFilePath.set(clean, [])
        }
        const symRecord = {
          id: node.id,
          name:
            node.data?.label ||
            node.data?.name ||
            node.name ||
            node.id.split('#').pop(),
          kind: node.data?.kind || node.kind || 'symbol',
          path: clean,
          parentSymbolId:
            node.data?.parentSymbolId || node.parentSymbolId || null,
          metadata: node.data?.metadata || {},
          raw: node,
        }
        symbolsByFilePath.get(clean).push(symRecord)
        symbolToFilePath.set(node.id, clean)
      }
    } else {
      // type === 'file' or default
      if (rawPath) {
        const clean = normalizePath(rawPath)
        graphFileMapByPath.set(clean, node)
      }
    }
  }

  const mergedFiles = []
  const pathToCanonicalFileId = new Map()

  for (const rawFile of manifest.files) {
    const cleanPath = normalizePath(rawFile.path)
    if (!cleanPath) continue

    const graphNode = graphFileMapByPath.get(cleanPath)
    const folder = getDirectoryFromPath(cleanPath, rawFile.folder)
    const directory = getNestedDirectoryFromPath(cleanPath)
    const name = rawFile.name || cleanPath.split('/').pop() || cleanPath
    const symbols = symbolsByFilePath.get(cleanPath) || []

    let fileRecord
    if (graphNode) {
      // Parsed source file with canonical graph node
      fileRecord = {
        id: graphNode.id,
        path: cleanPath,
        name: graphNode.data?.label || name,
        folder,
        directory,
        kind: graphNode.data?.kind || inferFileKind(cleanPath),
        status: graphNode.data?.status || 'parsed',
        isParsed: true,
        sizeBytes: rawFile.size || 0,
        blobSha: rawFile.sha || null,
        symbols,
        rawNode: graphNode,
      }
    } else {
      // Manifest file present in repository but unparsed (docs, configs, assets, unparsed source)
      fileRecord = {
        id: rawFile.id || cleanPath,
        path: cleanPath,
        name,
        folder,
        directory,
        kind: inferFileKind(cleanPath),
        status: 'unparsed',
        isParsed: false,
        sizeBytes: rawFile.size || 0,
        blobSha: rawFile.sha || null,
        symbols,
        rawNode: null,
      }
    }

    mergedFiles.push(fileRecord)
    pathToCanonicalFileId.set(cleanPath, fileRecord.id)
  }

  // Lift symbol-level dependency edges to clean file-to-file relationships for canvas
  const resolveEndpoint = (rawId) => {
    if (symbolToFilePath.has(rawId)) {
      const parentPath = symbolToFilePath.get(rawId)
      return pathToCanonicalFileId.get(parentPath) || rawId
    }
    if (typeof rawId === 'string') {
      const candidatePath = extractCanonicalPath(rawId)
      if (pathToCanonicalFileId.has(candidatePath)) {
        return pathToCanonicalFileId.get(candidatePath)
      }
      if (rawId.includes('#')) {
        return rawId.split('#')[0] || rawId
      }
    }
    return rawId
  }

  const liftedEdges = []
  for (const edge of graphEdges || []) {
    // Structural ownership edges (file -> symbol, class -> method) are internal; omit from canvas
    const edgeType = edge.data?.edgeType || edge.type
    if (
      edgeType === 'contains' ||
      edgeType === 'defines' ||
      edgeType === 'member_of'
    ) {
      continue
    }

    const sourceId = resolveEndpoint(edge.source)
    const targetId = resolveEndpoint(edge.target)

    // Skip self-edges
    if (sourceId === targetId) {
      continue
    }

    liftedEdges.push({
      ...edge,
      source: sourceId,
      target: targetId,
    })
  }

  return {
    repository: manifest.repository || graphSummary?.repository,
    commitSha: manifest.commitSha || graphSummary?.commitSha,
    files: mergedFiles,
    edges: liftedEdges,
    rawEdges: graphEdges || [],
    manifestSummary: manifest.summary || null,
  }
}

/**
 * Computes the ordered list of ancestor directory IDs for a file path,
 * from top-level folder down to its immediate containing directory.
 *
 * Examples:
 * - ".gitignore" -> ["root"]
 * - "Backend/app.js" -> ["Backend"]
 * - "Backend/controllers/graphController.js" -> ["Backend", "Backend/controllers"]
 * - "Frontend/src/components/map/FileNode.jsx" ->
 *     ["Frontend", "Frontend/src", "Frontend/src/components", "Frontend/src/components/map"]
 *
 * @param {string} filePath
 * @param {string} [explicitFolder]
 * @returns {string[]}
 */
export function getAncestorDirectories(filePath, explicitFolder) {
  const directory = getNestedDirectoryFromPath(filePath)

  const buildCumulative = (dirPath) => {
    if (!dirPath || dirPath === 'root') return ['root']
    const segments = dirPath.split('/').filter(Boolean)
    if (segments.length === 0) return ['root']
    const chain = []
    for (let i = 0; i < segments.length; i++) {
      chain.push(segments.slice(0, i + 1).join('/'))
    }
    return chain
  }

  if (explicitFolder && typeof explicitFolder === 'string') {
    if (explicitFolder === 'root') return ['root']
    if (directory === explicitFolder) return [explicitFolder]
    if (directory.startsWith(`${explicitFolder}/`)) {
      return buildCumulative(directory)
    }
    if (directory === `src/${explicitFolder}` || directory.startsWith(`src/${explicitFolder}/`)) {
      return buildCumulative(directory.slice(4))
    }
    return [explicitFolder]
  }

  return buildCumulative(directory)
}

/**
 * Resolves the currently visible React Flow node ID for a file, given the set
 * of expanded directory IDs. Walks the file's directory ancestry top-down and
 * stops at the first collapsed ancestor folder; if all ancestors are expanded,
 * returns the file's own node ID.
 *
 * @param {object} file
 * @param {string|Array|Set|object|null} expandedFolders
 * @returns {string}
 */
export function resolveVisibleNodeId(file, expandedFolders) {
  const ancestors =
    Array.isArray(file?.ancestors) && file.ancestors.length > 0
      ? file.ancestors
      : [file?.folder || 'root']

  for (const dirId of ancestors) {
    if (!isFolderExpanded(dirId, expandedFolders)) {
      return folderNodeId(dirId)
    }
  }
  return fileNodeId(file.id)
}

/**
 * Derives recursive presentation-layer directory hierarchy from canonical repository items and edges.
 * Preserves full nested folder structure: Repository -> Folder -> Subfolder(s) -> Files.
 * Works uniformly for both mock sampleRepository and live manifest/backend repositories.
 *
 * @param {object|Array} repositoryOrItems
 * @param {Array} [edgesInput]
 * @returns {object} { fileMap, folders, folderMap, rootFiles, directoryTree, stats, folderEdges }
 */
export function deriveDirectoryHierarchy(repositoryOrItems, edgesInput = [], options = {}) {
  const items = Array.isArray(repositoryOrItems)
    ? repositoryOrItems
    : repositoryOrItems?.files || []
  const edges = Array.isArray(repositoryOrItems?.edges)
    ? repositoryOrItems.edges
    : edgesInput
  const hasManifest = Boolean(repositoryOrItems?.manifestSummary || repositoryOrItems?.manifest)
  const isPlainTestLayout = !hasManifest && !repositoryOrItems?.name && Array.isArray(repositoryOrItems?.files)
  const filterNonCode = options.filterNonCodeFolders !== undefined
    ? Boolean(options.filterNonCodeFolders)
    : (!hasManifest && !isPlainTestLayout)

  const edgeParticipantFileIds = new Set()
  for (const edge of edges || []) {
    if (edge.source) edgeParticipantFileIds.add(edge.source)
    if (edge.target) edgeParticipantFileIds.add(edge.target)
  }

  const codeEligibleDirs = filterNonCode
    ? computeCodeEligibleDirectories(items, edges)
    : null

  const fileMap = new Map()
  const folderMap = new Map()
  const rootFiles = []
  const directoryTree = new Map()

  const ensureDirNode = (dirId, parentId, depth) => {
    if (folderMap.has(dirId)) return folderMap.get(dirId)
    const isRoot = dirId === 'root'
    const segments = dirId.split('/').filter(Boolean)
    const name = isRoot ? 'Root Files' : segments[segments.length - 1] || dirId
    const node = {
      id: dirId,
      name,
      label: isRoot ? 'Root Files' : name,
      parentId: parentId || null,
      depth,
      isRoot,
      subfolders: [],
      subfolderIds: new Set(),
      directFiles: [],
      files: [],
      fileIds: new Set(),
      allFiles: [],
    }
    folderMap.set(dirId, node)
    return node
  }

  for (const rawItem of items) {
    const id = rawItem.id || rawItem.path
    const path = normalizePath(rawItem.path || rawItem.data?.path || id)
    const explicitFolder = rawItem.folder || rawItem.data?.folder
    const ancestors = getAncestorDirectories(path, explicitFolder)
    const topFolder = ancestors[0]
    const directDir = ancestors[ancestors.length - 1]
    const directory = rawItem.directory || getNestedDirectoryFromPath(path)
    const name =
      rawItem.name ||
      rawItem.label ||
      rawItem.data?.label ||
      (path ? path.split('/').pop() : id)
    const kind = rawItem.kind || rawItem.data?.kind || rawItem.type || 'file'
    const status = rawItem.status || (rawItem.isParsed ? 'parsed' : 'unparsed')
    const isRoot = topFolder === 'root'

    const normalizedFile = {
      id,
      path,
      name,
      folder: topFolder,
      directDir,
      ancestors,
      directory,
      kind,
      status,
      isRoot,
      isParsed: Boolean(rawItem.isParsed),
      symbols: rawItem.symbols || [],
      raw: rawItem,
    }

    fileMap.set(id, normalizedFile)
    if (path) {
      if (!fileMap.has(path)) fileMap.set(path, normalizedFile)
    }
    const canonicalPath = extractCanonicalPath(id)
    if (canonicalPath) {
      if (!fileMap.has(canonicalPath)) fileMap.set(canonicalPath, normalizedFile)
    }

    if (isRoot) {
      rootFiles.push(normalizedFile)
    }

    const isEdgeParticipant =
      edgeParticipantFileIds.has(id) ||
      edgeParticipantFileIds.has(path) ||
      edgeParticipantFileIds.has(`file:${path}`)
    const isWorkspaceFile =
      !filterNonCode ||
      isEligibleWorkspaceFile(normalizedFile) ||
      isEdgeParticipant

    // Build recursive directory tree along ancestors
    for (let depth = 0; depth < ancestors.length; depth++) {
      const dirId = ancestors[depth]

      // Descendant-based directory inclusion: omit branches with zero eligible code descendants
      if (filterNonCode && !codeEligibleDirs.has(dirId)) {
        continue
      }

      const parentId = depth > 0 ? ancestors[depth - 1] : null
      if (filterNonCode && parentId && !codeEligibleDirs.has(parentId)) {
        continue
      }

      const dirNode = ensureDirNode(dirId, parentId, depth)
      dirNode.allFiles.push(normalizedFile)

      if (isWorkspaceFile) {
        dirNode.files.push(normalizedFile)
        dirNode.fileIds.add(id)
      }

      if (parentId) {
        const parentNode = folderMap.get(parentId)
        if (parentNode && !parentNode.subfolderIds.has(dirId)) {
          parentNode.subfolderIds.add(dirId)
          parentNode.subfolders.push(dirNode)
        }
      }

      if (depth === ancestors.length - 1 && isWorkspaceFile) {
        dirNode.directFiles.push(normalizedFile)
      }
    }

    // Preserve flat nested directory lookup map
    if (!directoryTree.has(directory)) {
      directoryTree.set(directory, [])
    }
    directoryTree.get(directory).push(normalizedFile)
  }

  // Deterministic sort for every directory node's subfolders and files
  for (const dirNode of folderMap.values()) {
    dirNode.subfolders.sort((a, b) => a.name.localeCompare(b.name))
    dirNode.directFiles.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    dirNode.files.sort((a, b) => a.path.localeCompare(b.path))
  }

  // Top-level directories sorted alphabetically; 'root' labeled 'Root Files' placed distinctly last
  const folders = [...folderMap.values()]
    .filter((d) => d.parentId === null)
    .sort((a, b) => {
      if (a.id === 'root') return 1
      if (b.id === 'root') return -1
      return a.id.localeCompare(b.id)
    })

  // Stats calculation for EVERY directory & nested subfolder in the tree
  const stats = new Map()
  for (const dirNode of folderMap.values()) {
    const parsedCount = dirNode.files.filter((f) => f.isParsed).length
    const unparsedCount = dirNode.files.length - parsedCount
    stats.set(dirNode.id, {
      fileCount: dirNode.files.length,
      directFileCount: dirNode.directFiles.length,
      subfolderCount: dirNode.subfolders.length,
      incoming: 0,
      outgoing: 0,
      internal: 0,
      parsedCount,
      unparsedCount,
    })
  }

  const folderEdgesMap = new Map()

  for (const edge of edges) {
    const source = resolveFileFromMap(fileMap, edge.source)
    const target = resolveFileFromMap(fileMap, edge.target)
    if (!source || !target) continue

    // Update cross-boundary incoming/outgoing stats for EVERY directory in the tree
    const sourceAncestors = new Set(source.ancestors)
    const targetAncestors = new Set(target.ancestors)

    for (const dirId of source.ancestors) {
      if (!targetAncestors.has(dirId)) {
        const s = stats.get(dirId)
        if (s) s.outgoing += 1
      } else {
        // Source and target are both contained within dirId
        const s = stats.get(dirId)
        if (s) s.internal += 1
      }
    }
    for (const dirId of target.ancestors) {
      if (!sourceAncestors.has(dirId)) {
        const t = stats.get(dirId)
        if (t) t.incoming += 1
      }
    }

    // Aggregate top-level folder-to-folder edges
    if (source.folder !== target.folder) {
      const key = `${source.folder}\u0000${target.folder}`
      const canonicalEdgeId = edge.id || `canonical:${source.id}->${target.id}`
      const rawType = edge.data?.edgeType || edge.type || 'imports'
      const underlyingRecord = {
        id: canonicalEdgeId,
        sourceId: source.id,
        targetId: target.id,
        sourcePath: source.path || source.id,
        targetPath: target.path || target.id,
        sourceName: source.name || (source.path ? source.path.split('/').pop() : source.id),
        targetName: target.name || (target.path ? target.path.split('/').pop() : target.id),
        sourceDirectory: source.directory || source.folder || 'root',
        targetDirectory: target.directory || target.folder || 'root',
        sourceSubsystem: source.folder || 'root',
        targetSubsystem: target.folder || 'root',
        type: rawType,
        metadata: edge.metadata || edge.data?.metadata || null,
        evidence: edge.evidence || edge.data?.evidence || null,
        raw: edge,
      }

      const existing = folderEdgesMap.get(key)
      if (existing) {
        existing.count += 1
        existing.underlyingEdges.push(underlyingRecord)
        if (rawType === 'http_request') existing.hasHttpRequest = true
      } else {
        folderEdgesMap.set(key, {
          source: source.folder,
          target: target.folder,
          count: 1,
          hasHttpRequest: rawType === 'http_request',
          underlyingEdges: [underlyingRecord],
        })
      }
    }
  }

  const folderEdges = [...folderEdgesMap.values()].sort(
    (a, b) =>
      a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  )

  return {
    fileMap,
    folders,
    folderMap,
    rootFiles,
    directoryTree,
    stats,
    folderEdges,
  }
}

export function buildFileMap(repository, options = {}) {
  return deriveDirectoryHierarchy(repository, repository?.edges, options).fileMap
}

export function getFolders(repository, options = {}) {
  return deriveDirectoryHierarchy(repository, repository?.edges, options).folders
}

export function getFolderStats(repository, options = {}) {
  return deriveDirectoryHierarchy(repository, repository?.edges, options).stats
}

export function getFolderEdges(repository, options = {}) {
  return deriveDirectoryHierarchy(repository, repository?.edges, options).folderEdges
}

const CONTAINER_PAD_X = 24
const CONTAINER_PAD_TOP = EXPANDED_HEADER_HEIGHT + 16
const CONTAINER_PAD_BOTTOM = 20

/**
 * Recursively computes the bounding box and child positions of a directory subtree.
 * - Collapsed folder: fixed FOLDER_WIDTH x FOLDER_HEIGHT.
 * - Expanded leaf folder (files only): clean single- or multi-column grid.
 * - Expanded parent folder (contains subfolders): local Dagre LR layout over its direct
 *   subfolders and connected direct files, with standalone zero-edge direct files arranged
 *   neatly in a horizontal shelf below the dependency flow.
 */
function layoutDirectorySubtree(dirNode, expandedFolders, edges, fileMap) {
  if (!isFolderExpanded(dirNode.id, expandedFolders)) {
    return {
      width: FOLDER_WIDTH,
      height: FOLDER_HEIGHT,
      childLayouts: [],
    }
  }

  // Case 1: Leaf folder (no subfolders — direct files only)
  if (dirNode.subfolders.length === 0) {
    const count = dirNode.directFiles.length
    const width = expandedFolderWidth(count)
    const height = expandedFolderHeight(count)
    const childLayouts = dirNode.directFiles.map((file, index) => {
      const pos = getChildFilePosition(index, count)
      return {
        type: 'file',
        file,
        x: pos.x,
        y: pos.y,
        width: FILE_WIDTH,
        height: FILE_HEIGHT,
      }
    })
    return { width, height, childLayouts }
  }

  // Case 2: Parent folder with subfolders (recursive bottom-up layout!)
  const subLayoutsById = new Map()
  for (const sub of dirNode.subfolders) {
    subLayoutsById.set(
      sub.id,
      layoutDirectorySubtree(sub, expandedFolders, edges, fileMap),
    )
  }

  // Map every descendant file in this folder to its direct child key (subfolder or direct file)
  const fileToDirectChildKey = new Map()
  for (const sub of dirNode.subfolders) {
    const childKey = `sub:${sub.id}`
    for (const fId of sub.fileIds) {
      fileToDirectChildKey.set(fId, childKey)
    }
  }
  for (const file of dirNode.directFiles) {
    fileToDirectChildKey.set(file.id, `file:${file.id}`)
  }

  // Discover local child-to-child edges & which direct files participate in ANY edge
  const localEdgeWeights = new Map()
  const connectedChildKeys = new Set()

  for (const edge of edges) {
    const src = resolveFileFromMap(fileMap, edge.source)
    const tgt = resolveFileFromMap(fileMap, edge.target)
    if (!src || !tgt) continue

    const srcKey = fileToDirectChildKey.get(src.id)
    const tgtKey = fileToDirectChildKey.get(tgt.id)

    if (srcKey) connectedChildKeys.add(srcKey)
    if (tgtKey) connectedChildKeys.add(tgtKey)

    if (srcKey && tgtKey && srcKey !== tgtKey) {
      const pairKey = `${srcKey}\u0000${tgtKey}`
      localEdgeWeights.set(pairKey, (localEdgeWeights.get(pairKey) || 0) + 1)
    }
  }

  // All subfolders + connected direct files participate in the local Dagre dependency flow
  const mainSubfolders = dirNode.subfolders
  const connectedDirectFiles = dirNode.directFiles.filter((f) =>
    connectedChildKeys.has(`file:${f.id}`),
  )
  const standaloneDirectFiles = dirNode.directFiles.filter(
    (f) => !connectedChildKeys.has(`file:${f.id}`),
  )

  const localGraph = new dagre.graphlib.Graph()
  localGraph.setGraph({
    rankdir: 'LR',
    nodesep: 38,
    ranksep: 96,
    marginx: 0,
    marginy: 0,
  })
  localGraph.setDefaultEdgeLabel(() => ({}))

  for (const sub of mainSubfolders) {
    const subLayout = subLayoutsById.get(sub.id)
    localGraph.setNode(`sub:${sub.id}`, {
      width: subLayout.width,
      height: subLayout.height,
    })
  }
  for (const file of connectedDirectFiles) {
    localGraph.setNode(`file:${file.id}`, {
      width: FILE_WIDTH,
      height: FILE_HEIGHT,
    })
  }

  for (const [pairKey, weight] of localEdgeWeights.entries()) {
    const [srcKey, tgtKey] = pairKey.split('\u0000')
    localGraph.setEdge(srcKey, tgtKey, { weight })
  }

  const rawChildPositions = []
  let minX = Infinity
  let minY = Infinity
  let maxX = 0
  let maxY = 0

  if (
    mainSubfolders.length > 1 &&
    localEdgeWeights.size === 0 &&
    connectedDirectFiles.length === 0
  ) {
    // Zero intra-folder dependency edges: arrange subfolders in a balanced multi-column grid
    // rather than letting Dagre stack them in a single towering vertical pole.
    const colCount = mainSubfolders.length <= 4 ? 2 : 3
    const colGap = 36
    const rowGap = 24

    const colY = new Array(colCount).fill(0)
    const colWidths = new Array(colCount).fill(0)
    const colItems = Array.from({ length: colCount }, () => [])

    for (const sub of mainSubfolders) {
      const subLayout = subLayoutsById.get(sub.id)
      let bestCol = 0
      for (let c = 1; c < colCount; c++) {
        if (colY[c] < colY[bestCol]) {
          bestCol = c
        }
      }

      const curY = colY[bestCol]
      colItems[bestCol].push({ sub, subLayout, y: curY })
      colY[bestCol] += subLayout.height + rowGap
      colWidths[bestCol] = Math.max(colWidths[bestCol], subLayout.width)
    }

    const colX = new Array(colCount).fill(0)
    for (let c = 1; c < colCount; c++) {
      colX[c] = colX[c - 1] + colWidths[c - 1] + colGap
    }

    for (let c = 0; c < colCount; c++) {
      for (const item of colItems[c]) {
        const x = colX[c]
        const y = item.y
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x + item.subLayout.width)
        maxY = Math.max(maxY, y + item.subLayout.height)
        rawChildPositions.push({
          type: 'folder',
          folder: item.sub,
          x,
          y,
          width: item.subLayout.width,
          height: item.subLayout.height,
          childLayouts: item.subLayout.childLayouts,
        })
      }
    }
  } else if (mainSubfolders.length > 0 || connectedDirectFiles.length > 0) {
    dagre.layout(localGraph)

    for (const sub of mainSubfolders) {
      const key = `sub:${sub.id}`
      const node = localGraph.node(key)
      const subLayout = subLayoutsById.get(sub.id)
      const x = Math.round(node.x - node.width / 2)
      const y = Math.round(node.y - node.height / 2)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + node.width)
      maxY = Math.max(maxY, y + node.height)
      rawChildPositions.push({
        type: 'folder',
        folder: sub,
        x,
        y,
        width: subLayout.width,
        height: subLayout.height,
        childLayouts: subLayout.childLayouts,
      })
    }

    for (const file of connectedDirectFiles) {
      const key = `file:${file.id}`
      const node = localGraph.node(key)
      const x = Math.round(node.x - node.width / 2)
      const y = Math.round(node.y - node.height / 2)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + node.width)
      maxY = Math.max(maxY, y + node.height)
      rawChildPositions.push({
        type: 'file',
        file,
        x,
        y,
        width: FILE_WIDTH,
        height: FILE_HEIGHT,
      })
    }
  }

  if (!Number.isFinite(minX)) minX = 0
  if (!Number.isFinite(minY)) minY = 0

  const mainWidth = Math.max(0, maxX - minX)
  const mainHeight = Math.max(0, maxY - minY)

  // Shift main items to start at (CONTAINER_PAD_X, CONTAINER_PAD_TOP)
  const childLayouts = rawChildPositions.map((item) => ({
    ...item,
    x: item.x - minX + CONTAINER_PAD_X,
    y: item.y - minY + CONTAINER_PAD_TOP,
  }))

  // Arrange standalone (zero-edge) direct files neatly in a horizontal shelf below main items
  let totalInnerWidth = mainWidth
  let totalInnerHeight = mainHeight

  if (standaloneDirectFiles.length > 0) {
    const shelfGapY = mainHeight > 0 ? 28 : 0
    const colGap = 14
    const shelfStartY = CONTAINER_PAD_TOP + mainHeight + shelfGapY
    const availableWidth = Math.max(mainWidth, FILE_WIDTH * 2 + colGap)
    const maxCols = Math.max(
      1,
      Math.min(
        4,
        Math.floor((availableWidth + colGap) / (FILE_WIDTH + colGap)),
      ),
    )
    const cols = Math.min(maxCols, standaloneDirectFiles.length)
    const rows = Math.ceil(standaloneDirectFiles.length / cols)

    standaloneDirectFiles.forEach((file, idx) => {
      const col = idx % cols
      const row = Math.floor(idx / cols)
      childLayouts.push({
        type: 'file',
        file,
        x: CONTAINER_PAD_X + col * (FILE_WIDTH + colGap),
        y: shelfStartY + row * FILE_STEP,
        width: FILE_WIDTH,
        height: FILE_HEIGHT,
      })
    })

    const shelfWidth = cols * FILE_WIDTH + (cols - 1) * colGap
    const shelfHeight = rows * FILE_STEP - (FILE_STEP - FILE_HEIGHT)
    totalInnerWidth = Math.max(totalInnerWidth, shelfWidth)
    totalInnerHeight = mainHeight + shelfGapY + shelfHeight
  }

  const width = Math.max(
    EXPANDED_FOLDER_WIDTH,
    Math.round(totalInnerWidth + CONTAINER_PAD_X * 2),
  )
  const height = Math.round(
    CONTAINER_PAD_TOP + totalInnerHeight + CONTAINER_PAD_BOTTOM,
  )

  return { width, height, childLayouts }
}

export function getLayout(repository, expandedFolders, options = {}) {
  const hierarchy = deriveDirectoryHierarchy(repository, repository?.edges, options)
  const {
    folders,
    folderMap,
    rootFiles,
    directoryTree,
    folderEdges,
    stats,
    fileMap,
  } = hierarchy
  const edges = Array.isArray(repository?.edges) ? repository.edges : []

  // Recursively compute sizes & child layouts for every top-level directory
  const subtreeLayouts = new Map()
  for (const folder of folders) {
    subtreeLayouts.set(
      folder.id,
      layoutDirectorySubtree(folder, expandedFolders, edges, fileMap),
    )
  }

  const graph = new dagre.graphlib.Graph()

  graph.setGraph({
    rankdir: 'LR',
    nodesep: 84,
    ranksep: 180,
    marginx: 64,
    marginy: 64,
  })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const folder of folders) {
    const layout = subtreeLayouts.get(folder.id)
    graph.setNode(folder.id, {
      width: layout.width,
      height: layout.height,
    })
  }

  for (const edge of folderEdges) {
    graph.setEdge(edge.source, edge.target, { weight: edge.count })
  }

  dagre.layout(graph)

  const positions = new Map()
  for (const folder of folders) {
    const node = graph.node(folder.id)
    const layout = subtreeLayouts.get(folder.id)
    positions.set(folder.id, {
      x: Math.round(node.x - node.width / 2),
      y: Math.round(node.y - node.height / 2),
      width: node.width,
      height: node.height,
      childLayouts: layout.childLayouts,
    })
  }

  return {
    positions,
    folders,
    folderMap,
    rootFiles,
    directoryTree,
    folderEdges,
    stats,
    fileMap,
  }
}

export function getFileNeighbours(repository, fileId) {
  const fileMap = buildFileMap(repository)
  const targetFile = resolveFileFromMap(fileMap, fileId)
  const effectiveId = targetFile?.id || fileId
  const effectivePath = targetFile?.path || extractCanonicalPath(fileId)

  const imports = new Set()
  const importedBy = new Set()
  const edges = Array.isArray(repository?.edges) ? repository.edges : []

  for (const edge of edges) {
    const src = resolveFileFromMap(fileMap, edge.source)
    const tgt = resolveFileFromMap(fileMap, edge.target)
    if (!src || !tgt) continue

    if (src.id === effectiveId || src.path === effectivePath) imports.add(tgt.id)
    if (tgt.id === effectiveId || tgt.path === effectivePath) importedBy.add(src.id)
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
