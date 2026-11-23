import test from 'node:test'
import assert from 'node:assert/strict'
import {
  paginateUnderlyingEdges,
  DEFAULT_PAGE_SIZE,
} from '../src/lib/provenancePagination.js'

test('ProvenancePanel Optimization 1: Small list (<= 25 items) returns all items in visible window', () => {
  const edges = [
    { id: 'e1', sourcePath: 'src/App.jsx', targetPath: 'src/Button.jsx', type: 'imports' },
    { id: 'e2', sourcePath: 'src/App.jsx', targetPath: 'src/Header.jsx', type: 'renders' },
    { id: 'e3', sourcePath: 'src/App.jsx', targetPath: 'src/api.js', type: 'calls' },
  ]

  const result = paginateUnderlyingEdges(edges, { currentPage: 1 })

  assert.equal(result.filteredEdges.length, 3)
  assert.equal(result.visibleEdges.length, 3)
  assert.equal(result.totalPages, 1)
  assert.equal(result.effectivePage, 1)
  assert.equal(result.pageSize, DEFAULT_PAGE_SIZE)

  // Type counts
  assert.equal(result.typeCounts.length, 3)
  const typesMap = new Map(result.typeCounts.map((t) => [t.type, t.count]))
  assert.equal(typesMap.get('imports'), 1)
  assert.equal(typesMap.get('renders'), 1)
  assert.equal(typesMap.get('calls'), 1)
})

test('ProvenancePanel Optimization 2: Large list (100 items) produces 4 pages of 25 items with correct windowing', () => {
  const largeEdges = Array.from({ length: 100 }, (_, i) => ({
    id: `e_${i + 1}`,
    sourcePath: `src/Comp_${i + 1}.tsx`,
    targetPath: `src/Target_${i + 1}.tsx`,
    type: i % 2 === 0 ? 'imports' : 'calls',
  }))

  // Page 1
  const page1 = paginateUnderlyingEdges(largeEdges, { currentPage: 1, pageSize: 25 })
  assert.equal(page1.filteredEdges.length, 100)
  assert.equal(page1.totalPages, 4)
  assert.equal(page1.effectivePage, 1)
  assert.equal(page1.visibleEdges.length, 25)
  assert.equal(page1.visibleEdges[0].id, 'e_1')
  assert.equal(page1.visibleEdges[24].id, 'e_25')

  // Page 2
  const page2 = paginateUnderlyingEdges(largeEdges, { currentPage: 2, pageSize: 25 })
  assert.equal(page2.effectivePage, 2)
  assert.equal(page2.visibleEdges.length, 25)
  assert.equal(page2.visibleEdges[0].id, 'e_26')
  assert.equal(page2.visibleEdges[24].id, 'e_50')

  // Page 4 (last page)
  const page4 = paginateUnderlyingEdges(largeEdges, { currentPage: 4, pageSize: 25 })
  assert.equal(page4.effectivePage, 4)
  assert.equal(page4.visibleEdges.length, 25)
  assert.equal(page4.visibleEdges[0].id, 'e_76')
  assert.equal(page4.visibleEdges[24].id, 'e_100')
})

test('ProvenancePanel Optimization 3: Type filtering isolates specific relationship kinds and recalculates pagination', () => {
  const mixedEdges = [
    ...Array.from({ length: 60 }, (_, i) => ({ id: `imp_${i}`, type: 'imports' })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `call_${i}`, type: 'calls' })),
  ]

  // Filter to calls only
  const callsOnly = paginateUnderlyingEdges(mixedEdges, {
    selectedTypeFilter: 'calls',
    pageSize: 25,
  })

  assert.equal(callsOnly.filteredEdges.length, 15)
  assert.equal(callsOnly.visibleEdges.length, 15)
  assert.equal(callsOnly.totalPages, 1)
  assert.ok(callsOnly.visibleEdges.every((e) => e.type === 'calls'))

  // Filter to imports only
  const importsOnly = paginateUnderlyingEdges(mixedEdges, {
    selectedTypeFilter: 'imports',
    pageSize: 25,
  })

  assert.equal(importsOnly.filteredEdges.length, 60)
  assert.equal(importsOnly.totalPages, 3) // 25 + 25 + 10 = 3 pages
  assert.equal(importsOnly.visibleEdges.length, 25)
})

test('ProvenancePanel Optimization 4: Case-insensitive search query filters by path, name, or rule', () => {
  const edges = [
    { id: '1', sourcePath: 'Frontend/src/views/UserView.jsx', targetPath: 'Backend/controllers/userController.js' },
    { id: '2', sourcePath: 'Frontend/src/views/AuthView.jsx', targetPath: 'Backend/controllers/authController.js' },
    { id: '3', sourcePath: 'Frontend/src/lib/api.js', targetPath: 'Backend/routes/apiRoutes.js', evidence: { rule: 'ast_route_match' } },
  ]

  // Search by target file name
  const res1 = paginateUnderlyingEdges(edges, { searchQuery: 'userController' })
  assert.equal(res1.filteredEdges.length, 1)
  assert.equal(res1.visibleEdges[0].id, '1')

  // Search by rule substring
  const res2 = paginateUnderlyingEdges(edges, { searchQuery: 'route_match' })
  assert.equal(res2.filteredEdges.length, 1)
  assert.equal(res2.visibleEdges[0].id, '3')

  // Search by common substring
  const res3 = paginateUnderlyingEdges(edges, { searchQuery: 'controller' })
  assert.equal(res3.filteredEdges.length, 2)

  // Search with zero matches
  const res4 = paginateUnderlyingEdges(edges, { searchQuery: 'nonexistent_file' })
  assert.equal(res4.filteredEdges.length, 0)
  assert.equal(res4.visibleEdges.length, 0)
  assert.equal(res4.totalPages, 1)
})

test('ProvenancePanel Optimization 5: showAll=true unrolls all filtered items without pagination clipping', () => {
  const edges = Array.from({ length: 80 }, (_, i) => ({ id: `e_${i}`, type: 'imports' }))
  const res = paginateUnderlyingEdges(edges, { showAll: true, pageSize: 25 })

  assert.equal(res.visibleEdges.length, 80, 'showAll must return full list')
})

test('ProvenancePanel Optimization 6: Out-of-bounds page requests clamp safely within [1, totalPages]', () => {
  const edges = Array.from({ length: 40 }, (_, i) => ({ id: `e_${i}` }))

  // Requesting page 999
  const clampedHigh = paginateUnderlyingEdges(edges, { currentPage: 999, pageSize: 25 })
  assert.equal(clampedHigh.effectivePage, 2, 'Page 999 must clamp to page 2 (totalPages)')

  // Requesting page -5
  const clampedLow = paginateUnderlyingEdges(edges, { currentPage: -5, pageSize: 25 })
  assert.equal(clampedLow.effectivePage, 1, 'Page -5 must clamp to page 1')
})

test('ProvenancePanel Optimization 7: Null or empty underlyingEdges is handled cleanly without exceptions', () => {
  const emptyRes = paginateUnderlyingEdges(null)
  assert.equal(emptyRes.filteredEdges.length, 0)
  assert.equal(emptyRes.visibleEdges.length, 0)
  assert.equal(emptyRes.totalPages, 1)
  assert.equal(emptyRes.effectivePage, 1)
  assert.equal(emptyRes.typeCounts.length, 0)
})
