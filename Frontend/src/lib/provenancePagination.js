export const DEFAULT_PAGE_SIZE = 25

/**
 * Computes type counts, filtered list, and windowed/paginated visible slice
 * for large aggregated provenance lists.
 *
 * @param {Array<object>} underlyingEdges
 * @param {object} [options]
 * @param {string} [options.searchQuery='']
 * @param {string} [options.selectedTypeFilter='ALL']
 * @param {number} [options.currentPage=1]
 * @param {number} [options.pageSize=25]
 * @param {boolean} [options.showAll=false]
 * @returns {{
 *   typeCounts: Array<{ type: string, count: number }>,
 *   filteredEdges: Array<object>,
 *   visibleEdges: Array<object>,
 *   totalPages: number,
 *   effectivePage: number,
 *   pageSize: number
 * }}
 */
export function paginateUnderlyingEdges(underlyingEdges = [], options = {}) {
  const edges = Array.isArray(underlyingEdges) ? underlyingEdges : []
  const searchQuery = (options.searchQuery || '').trim().toLowerCase()
  const selectedTypeFilter = options.selectedTypeFilter || 'ALL'
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE
  const showAll = Boolean(options.showAll)

  // 1. Group underlying types for breakdown
  const countsMap = new Map()
  for (const edge of edges) {
    const t = edge.type || 'imports'
    countsMap.set(t, (countsMap.get(t) || 0) + 1)
  }
  const typeCounts = Array.from(countsMap.entries()).map(([type, count]) => ({
    type,
    count,
  }))

  // 2. Filter by selected type and search query
  let filteredEdges = edges
  if (selectedTypeFilter !== 'ALL') {
    filteredEdges = filteredEdges.filter(
      (e) => (e.type || 'imports') === selectedTypeFilter,
    )
  }

  if (searchQuery) {
    filteredEdges = filteredEdges.filter((e) => {
      const srcPath = (e.sourcePath || '').toLowerCase()
      const tgtPath = (e.targetPath || '').toLowerCase()
      const srcName = (e.sourceName || '').toLowerCase()
      const tgtName = (e.targetName || '').toLowerCase()
      const rule = (
        typeof e.evidence === 'string'
          ? e.evidence
          : e.evidence?.rule || (Array.isArray(e.evidence) && e.evidence[0]?.resolver?.rule) || ''
      ).toLowerCase()
      const httpMethod = (
        e.metadata?.httpMethod ||
        e.data?.httpMethod ||
        e.raw?.metadata?.httpMethod ||
        (Array.isArray(e.evidence) && e.evidence[0]?.target?.httpMethod) ||
        ''
      ).toLowerCase()
      const composedPath = (
        e.metadata?.composedRoutePath ||
        e.data?.composedRoutePath ||
        e.raw?.metadata?.composedRoutePath ||
        (Array.isArray(e.evidence) && e.evidence[0]?.target?.composedRoutePath) ||
        ''
      ).toLowerCase()

      return (
        srcPath.includes(searchQuery) ||
        tgtPath.includes(searchQuery) ||
        srcName.includes(searchQuery) ||
        tgtName.includes(searchQuery) ||
        rule.includes(searchQuery) ||
        httpMethod.includes(searchQuery) ||
        composedPath.includes(searchQuery)
      )
    })
  }

  // 3. Compute pagination
  const totalPages = Math.ceil(filteredEdges.length / pageSize) || 1
  const rawPage = typeof options.currentPage === 'number' ? options.currentPage : 1
  const effectivePage = Math.min(Math.max(1, rawPage), totalPages)

  // 4. Compute visible window
  let visibleEdges
  if (showAll || filteredEdges.length <= pageSize) {
    visibleEdges = filteredEdges
  } else {
    const start = (effectivePage - 1) * pageSize
    visibleEdges = filteredEdges.slice(start, start + pageSize)
  }

  return {
    typeCounts,
    filteredEdges,
    visibleEdges,
    totalPages,
    effectivePage,
    pageSize,
  }
}
