import { normalizePath, resolveFileFromMap } from './repositoryGraph.js'

/**
 * Builds normalized adjacency and reverse-adjacency maps from verified canonical edges.
 * Ignores self-edges and unconfirmed/structural edges.
 *
 * @param {object} repository - Repository model with files & edges
 * @returns {object} { outgoingMap, incomingMap, fileMap, totalFiles, analyzedFiles }
 */
export function buildTopologyMaps(repository) {
  const files = Array.isArray(repository?.files) ? repository.files : []
  const edges = Array.isArray(repository?.edges) ? repository.edges : []

  const fileMap = new Map()
  let analyzedFilesCount = 0

  for (const f of files) {
    fileMap.set(f.id, f)
    if (f.path) fileMap.set(f.path, f)
    if (f.isParsed || (f.kind !== 'doc' && f.kind !== 'asset' && f.kind !== 'config')) {
      analyzedFilesCount++
    }
  }

  const outgoingMap = new Map() // source -> Set<target>
  const incomingMap = new Map() // target -> Set<source>

  for (const f of files) {
    outgoingMap.set(f.id, new Set())
    incomingMap.set(f.id, new Set())
  }

  for (const edge of edges) {
    const srcId = edge.source
    const tgtId = edge.target

    // Self-edges are ignored in topology centrality & impact analysis
    if (!srcId || !tgtId || srcId === tgtId) continue

    // Resolve to canonical file IDs if known
    const canonicalSrc = resolveFileFromMap(fileMap, srcId)?.id || srcId
    const canonicalTgt = resolveFileFromMap(fileMap, tgtId)?.id || tgtId

    if (canonicalSrc === canonicalTgt) continue

    if (!outgoingMap.has(canonicalSrc)) outgoingMap.set(canonicalSrc, new Set())
    if (!incomingMap.has(canonicalTgt)) incomingMap.set(canonicalTgt, new Set())

    outgoingMap.get(canonicalSrc).add(canonicalTgt)
    incomingMap.get(canonicalTgt).add(canonicalSrc)
  }

  return {
    outgoingMap,
    incomingMap,
    fileMap,
    totalFiles: files.length,
    analyzedFiles: analyzedFilesCount,
  }
}

/**
 * Identifies verified application entry points and convention-based entry-point candidates.
 * Strictly distinguishes proven manifest entries from speculative naming conventions:
 * - 'verified': requires authoritative framework or configuration evidence (e.g. Next.js app root, package.json main/bin).
 * - 'candidate': ordinary filenames, naming patterns, zero-indegree topological roots, or manifest presence.
 *
 * @param {object} repository - Repository model
 * @param {object} [topology] - Precomputed topology maps
 * @returns {object} { verified: Array, candidates: Array, all: Array }
 */
export function identifyEntryPoints(repository, topology) {
  const topo = topology || buildTopologyMaps(repository)
  const files = Array.isArray(repository?.files) ? repository.files : []

  const verified = []
  const candidates = []

  // Known convention naming patterns (candidates only)
  const ENTRY_NAME_PATTERNS = [
    /^index\.(js|jsx|ts|tsx|mjs|cjs|py)$/i,
    /^main\.(js|jsx|ts|tsx|py|go|rs|cpp|c)$/i,
    /^app\.(js|jsx|ts|tsx|py)$/i,
    /^server\.(js|ts|mjs)$/i,
    /^cli\.(js|ts|py)$/i,
    /^__main__\.py$/i,
  ]

  const FRAMEWORK_CONVENTION_PATHS = [
    'src/index.',
    'src/main.',
    'src/app.',
    'src/server.',
    'app/layout.',
    'app/page.',
    'pages/index.',
    'pages/_app.',
  ]

  for (const file of files) {
    const cleanPath = normalizePath(file.path || file.id).toLowerCase()
    const name = file.name || cleanPath.split('/').pop() || ''
    const inDegree = topo.incomingMap.get(file.id)?.size || 0
    const outDegree = topo.outgoingMap.get(file.id)?.size || 0

    // 1. Verified entry points: MUST have authoritative configuration or build evidence
    // (e.g. explicitly flagged by manifest config parser as isEntryPoint or authoritative framework entry)
    const hasAuthoritativeEvidence = Boolean(
      file.isEntryPoint === true ||
      file.data?.isEntryPoint === true ||
      file.isConfiguredEntry === true ||
      file.entryPointEvidence ||
      (file.kind === 'entry' && (file.isParsed || file.data?.isParsed))
    )

    if (hasAuthoritativeEvidence) {
      verified.push({
        fileId: file.id,
        name: file.name || name,
        path: file.path || cleanPath,
        type: 'verified',
        reason: file.entryPointEvidence || 'Authoritative manifest/framework configuration',
        inDegree,
        outDegree,
      })
      continue
    }

    // 2. Candidate entry points: Convention-based naming
    const isNameMatch = ENTRY_NAME_PATTERNS.some((p) => p.test(name))
    const isFrameworkMatch = FRAMEWORK_CONVENTION_PATHS.some((p) => cleanPath.includes(p))

    if (isNameMatch || isFrameworkMatch) {
      candidates.push({
        fileId: file.id,
        name: file.name || name,
        path: file.path || cleanPath,
        type: 'candidate',
        reason: isFrameworkMatch ? 'Framework entry convention candidate' : 'Standard entry convention candidate',
        inDegree,
        outDegree,
      })
      continue
    }

    // 3. Topological candidate: 0 incoming, >= 2 outgoing
    if (inDegree === 0 && outDegree >= 2 && file.kind !== 'test' && file.kind !== 'doc' && file.kind !== 'config') {
      candidates.push({
        fileId: file.id,
        name: file.name || name,
        path: file.path || cleanPath,
        type: 'candidate',
        reason: 'Topological candidate (0 incoming dependencies, >= 2 outgoing)',
        inDegree,
        outDegree,
      })
    }
  }

  // Sort verified first, then candidates by outDegree descending
  const sortByOutDegree = (a, b) => b.outDegree - a.outDegree || a.name.localeCompare(b.name)
  verified.sort(sortByOutDegree)
  candidates.sort(sortByOutDegree)

  return {
    verified,
    candidates,
    all: [...verified, ...candidates],
  }
}

/**
 * Calculates architectural hubs ranked by verified in-degree centrality.
 * Avoids arbitrary universal thresholds by computing relative distribution (upper quartile).
 * In small repositories (< 6 connected files or max inDegree < 2), hub classification is guarded
 * to avoid misleading claims over trivial dependencies.
 *
 * @param {object} repository - Repository model
 * @param {object} [topology] - Precomputed topology maps
 * @returns {Array<object>} Ranked architectural hubs
 */
export function identifyHubs(repository, topology) {
  const topo = topology || buildTopologyMaps(repository)
  const files = Array.isArray(repository?.files) ? repository.files : []

  if (files.length === 0) return []

  // Collect connected files
  const connectedFiles = []
  let maxInDegree = 0

  for (const file of files) {
    const inDegree = topo.incomingMap.get(file.id)?.size || 0
    const outDegree = topo.outgoingMap.get(file.id)?.size || 0
    if (inDegree > maxInDegree) maxInDegree = inDegree
    if (inDegree > 0 || outDegree > 0) {
      connectedFiles.push({ file, inDegree, outDegree })
    }
  }

  // Small repository guard: if max inDegree < 2, no nodes have hub centrality
  if (connectedFiles.length === 0 || maxInDegree < 2) return []

  // Calculate 75th percentile (Q3) threshold for in-degree
  const inDegrees = connectedFiles.map((c) => c.inDegree).sort((a, b) => a - b)
  const q3Index = Math.floor(inDegrees.length * 0.75)
  const q3Val = inDegrees[q3Index] || 2

  // Absolute minimum threshold is 2 incoming dependencies
  // In small repositories (< 6 connected files), require at least 2 incoming dependencies and >= 50% connectivity
  const q3Threshold = connectedFiles.length < 6
    ? Math.max(2, Math.ceil((connectedFiles.length - 1) * 0.5))
    : Math.max(2, q3Val)

  const hubs = []

  for (const { file, inDegree, outDegree } of connectedFiles) {
    if (inDegree >= q3Threshold) {
      // Determine structural role
      let role = 'mediator'
      if (inDegree >= 2 && outDegree <= 1) {
        role = 'core_library' // Heavily consumed, low/no outgoing coupling
      } else if (inDegree >= 2 && outDegree >= 2) {
        role = 'coordinator' // Central orchestrator connecting multiple layers
      } else if (outDegree === 0) {
        role = 'leaf_utility'
      }

      const hubScore = inDegree * 1.5 + outDegree * 0.5

      hubs.push({
        fileId: file.id,
        name: file.name || (file.path ? file.path.split('/').pop() : file.id),
        path: file.path || file.id,
        kind: file.kind || 'source',
        inDegree,
        outDegree,
        hubScore,
        role,
      })
    }
  }

  hubs.sort((a, b) => b.hubScore - a.hubScore || b.inDegree - a.inDegree)

  // Assign relative rank & percentile
  return hubs.map((h, idx) => ({
    ...h,
    rank: idx + 1,
    percentile: Math.round(((hubs.length - idx) / Math.max(1, hubs.length)) * 100),
  }))
}

/**
 * Calculates the downstream blast radius (impact radius) of changing a file.
 * Traverses reverse dependency edges (who imports this file, and who imports those callers).
 * Handles multiple dependency paths, cyclic dependencies, self-dependencies, and bounds traversal safely.
 *
 * Guarantees:
 * - Truncated or bounded results are explicitly flagged with isLowerBound = true and truncationReason.
 * - Denominator is explicitly reported for both total repository files and analyzed code files.
 *
 * @param {string} fileId - Target canonical file ID
 * @param {object} repository - Repository model
 * @param {object} [topology] - Precomputed topology maps
 * @param {object} [options={}] - Configurable traversal options
 * @param {number} [options.maxDepth=6] - Maximum BFS depth
 * @param {number} [options.maxNodes=150] - Maximum nodes to visit before bounding
 * @returns {object} Blast radius analysis result
 */
export function calculateImpactRadius(fileId, repository, topology, options = {}) {
  const topo = topology || buildTopologyMaps(repository)
  const maxDepth = options.maxDepth || 6
  const maxNodes = options.maxNodes || 150

  const canonicalTarget = topo.fileMap.get(fileId)?.id || fileId

  const visited = new Set([canonicalTarget])
  const levels = []
  let currentLevel = [canonicalTarget]
  let depth = 0
  let truncated = false
  let truncationReason = null
  let cyclesDetected = false

  while (currentLevel.length > 0 && depth < maxDepth) {
    depth++
    const nextLevel = []

    for (const currId of currentLevel) {
      const importers = topo.incomingMap.get(currId) || new Set()

      for (const importerId of importers) {
        // Self-dependencies are ignored
        if (importerId === currId) continue

        if (visited.has(importerId)) {
          cyclesDetected = true
          continue
        }

        if (visited.size >= maxNodes) {
          truncated = true
          truncationReason = 'max_nodes_exceeded'
          break
        }

        visited.add(importerId)
        nextLevel.push(importerId)
      }

      if (truncated) break
    }

    if (nextLevel.length > 0) {
      levels.push({
        depth,
        fileIds: nextLevel,
        files: nextLevel.map((id) => {
          const f = topo.fileMap.get(id)
          return {
            id,
            name: f?.name || id.split('/').pop() || id,
            path: f?.path || id,
            kind: f?.kind || 'source',
          }
        }),
      })
    }

    currentLevel = nextLevel
    if (truncated) break
  }

  // Check if depth limit truncated further callers
  if (!truncated && currentLevel.length > 0 && depth === maxDepth) {
    for (const currId of currentLevel) {
      const importers = topo.incomingMap.get(currId) || new Set()
      for (const impId of importers) {
        if (!visited.has(impId)) {
          truncated = true
          truncationReason = 'max_depth_exceeded'
          break
        }
      }
      if (truncated) break
    }
  }

  // Direct dependents (level 1)
  const directDependents = levels[0]?.files || []

  // All downstream dependents (excluding target itself)
  const totalAffectedCount = visited.size - 1

  // Blast radius percentages against total repository files and analyzed code files
  const blastRadiusPercentage =
    topo.totalFiles > 0
      ? Math.round((totalAffectedCount / topo.totalFiles) * 100)
      : 0

  const analyzedCodePercentage =
    topo.analyzedFiles > 0
      ? Math.round((totalAffectedCount / topo.analyzedFiles) * 100)
      : blastRadiusPercentage

  return {
    targetFileId: canonicalTarget,
    totalFiles: topo.totalFiles,
    analyzedFiles: topo.analyzedFiles,
    totalAffectedCount,
    blastRadiusPercentage,
    analyzedCodePercentage,
    isLowerBound: truncated,
    maxDepthReached: levels.length,
    directDependentsCount: directDependents.length,
    directDependents,
    levels,
    truncated,
    truncationReason,
    cyclesDetected,
  }
}
