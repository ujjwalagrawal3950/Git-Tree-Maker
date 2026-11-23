import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveDirectoryHierarchy,
  extractCanonicalPath,
  resolveFileFromMap,
  getLayout,
} from '../src/lib/repositoryGraph.js'
import {
  computeGraphGeometry,
  decorateGraphElements,
} from '../src/components/map/buildElements.js'

test('Step 1.1: Valid file-level edge between different top-level folders produces folder-level aggregate edge', () => {
  const repository = {
    repository: 'acme/cartograph',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { id: 'f_frontend', path: 'Frontend/src/lib/api.js' },
      { id: 'f_backend', path: 'Backend/controllers/graphController.js' },
    ],
    edges: [
      {
        id: 'edge_canonical_1',
        source: 'f_frontend',
        target: 'f_backend',
        type: 'imports',
        evidence: [{ line: 12, raw: 'import graphController from ...' }],
      },
    ],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  assert.equal(hierarchy.folderEdges.length, 1, 'Must produce 1 top-level folder edge')
  assert.equal(hierarchy.folderEdges[0].source, 'Frontend')
  assert.equal(hierarchy.folderEdges[0].target, 'Backend')
  assert.equal(hierarchy.folderEdges[0].count, 1)

  // In Architecture Overview (all folders collapsed):
  const geometry = computeGraphGeometry(repository, new Set())
  const folderEdge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.ok(folderEdge, 'Folder-level aggregate edge Frontend -> Backend must exist on canvas')
  assert.equal(folderEdge.count, 1)
  assert.equal(folderEdge.isAggregated, true)
  assert.equal(folderEdge.isCrossSubsystem, true)
  assert.equal(folderEdge.underlyingEdges.length, 1)
  assert.equal(folderEdge.underlyingEdges[0].id, 'edge_canonical_1')
})

test('Step 1.2: Cross-subsystem edge with file: prefix, bare path, and revision-scoped IDs resolves consistently', () => {
  const repoId = 'org/repo'
  const commit = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d'

  const repository = {
    repository: repoId,
    commitSha: commit,
    files: [
      {
        id: `${repoId}@${commit}:Frontend/src/components/App.jsx`,
        path: 'Frontend/src/components/App.jsx',
        name: 'App.jsx',
      },
      {
        id: `${repoId}@${commit}:Backend/services/GraphService.js`,
        path: 'Backend/services/GraphService.js',
        name: 'GraphService.js',
      },
    ],
    edges: [
      // Edge 1 uses "file:" URI prefix
      {
        id: 'edge_uri_prefix',
        source: 'file:Frontend/src/components/App.jsx',
        target: 'file:Backend/services/GraphService.js',
        type: 'calls',
        data: { edgeType: 'calls' },
      },
      // Edge 2 uses bare relative path
      {
        id: 'edge_bare_path',
        source: 'Frontend/src/components/App.jsx',
        target: 'Backend/services/GraphService.js',
        type: 'imports',
      },
      // Edge 3 uses revision-scoped ID with symbol anchor
      {
        id: 'edge_revision_symbol',
        source: `${repoId}@${commit}:Frontend/src/components/App.jsx#render`,
        target: `${repoId}@${commit}:Backend/services/GraphService.js#query`,
        type: 'references',
      },
    ],
  }

  // 1. deriveDirectoryHierarchy verification
  const hierarchy = deriveDirectoryHierarchy(repository)
  assert.equal(hierarchy.folderEdges.length, 1, 'All 3 edge formats must resolve to Frontend -> Backend')
  assert.equal(hierarchy.folderEdges[0].source, 'Frontend')
  assert.equal(hierarchy.folderEdges[0].target, 'Backend')
  assert.equal(hierarchy.folderEdges[0].count, 3, 'All 3 edges must aggregate into count 3')
  assert.equal(hierarchy.folderEdges[0].underlyingEdges.length, 3)

  // Subsystem stats check
  const frontendStats = hierarchy.stats.get('Frontend')
  const backendStats = hierarchy.stats.get('Backend')
  assert.equal(frontendStats.outgoing, 3, 'Frontend must have 3 outgoing dependencies')
  assert.equal(backendStats.incoming, 3, 'Backend must have 3 incoming dependencies')

  // 2. Canvas geometry verification
  const geometry = computeGraphGeometry(repository, new Set())
  const canvasEdge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.ok(canvasEdge, 'Canvas edge between folder:Frontend and folder:Backend must exist')
  assert.equal(canvasEdge.count, 3)
  assert.equal(canvasEdge.underlyingEdges.length, 3)
  assert.deepEqual(
    canvasEdge.underlyingEdges.map((u) => u.id).sort(),
    ['edge_bare_path', 'edge_revision_symbol', 'edge_uri_prefix'].sort(),
  )
})

test('Step 1.3: Multiple file-level edges between the same folder pair produce one aggregate with accurate count', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'Frontend/src/a.js' },
      { id: 'f2', path: 'Frontend/src/b.js' },
      { id: 'b1', path: 'Backend/routes/a.js' },
      { id: 'b2', path: 'Backend/routes/b.js' },
    ],
    edges: [
      { id: 'e1', source: 'f1', target: 'b1', type: 'imports' },
      { id: 'e2', source: 'f1', target: 'b2', type: 'calls' },
      { id: 'e3', source: 'f2', target: 'b1', type: 'imports' },
      { id: 'e4', source: 'f2', target: 'b2', type: 'references' },
    ],
  }

  const geometry = computeGraphGeometry(repository, new Set())
  const folderEdges = geometry.edges.filter(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.equal(folderEdges.length, 1, 'Must collapse to exactly ONE aggregate edge')
  assert.equal(folderEdges[0].count, 4, 'Aggregate count must be 4')
  assert.equal(folderEdges[0].label, 'imports (4)')
  assert.equal(folderEdges[0].underlyingEdges.length, 4)
})

test('Step 1.4: Intra-folder edge does NOT produce a cross-folder aggregate edge and correctly records internal count', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'Frontend/src/views/Home.jsx' },
      { id: 'f2', path: 'Frontend/src/components/Header.jsx' },
      { id: 'f3', path: 'Frontend/src/components/Footer.jsx' },
    ],
    edges: [
      { id: 'e_int_1', source: 'f1', target: 'f2', type: 'renders' },
      { id: 'e_int_2', source: 'f1', target: 'f3', type: 'renders' },
    ],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  assert.equal(hierarchy.folderEdges.length, 0, 'Intra-folder edges must not create top-level folder edges')
  const frontendStats = hierarchy.stats.get('Frontend')
  assert.equal(frontendStats.internal, 2, 'Frontend internal count must be 2')
  assert.equal(frontendStats.outgoing, 0, 'Frontend outgoing must be 0')
  assert.equal(frontendStats.incoming, 0, 'Frontend incoming must be 0')

  // When Frontend is collapsed, self-edges collapse and are suppressed on canvas
  const collapsed = computeGraphGeometry(repository, new Set())
  assert.equal(collapsed.edges.length, 0, 'No self-edges drawn on canvas when folder is collapsed')
})

test('Step 1.5: Deeply nested paths map to intended subsystem identities and nested directories', () => {
  const repository = {
    files: [
      { id: 'deep_src', path: 'Frontend/src/features/dashboard/widgets/Chart.jsx' },
      { id: 'deep_tgt', path: 'Backend/src/api/v1/metrics/timeseries.js' },
    ],
    edges: [
      { id: 'deep_edge', source: 'deep_src', target: 'deep_tgt', type: 'imports' },
    ],
  }

  const geometry = computeGraphGeometry(repository, new Set())
  const edge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.ok(edge, 'Deeply nested files must aggregate to top-level folder:Frontend -> folder:Backend')
  assert.equal(edge.sourceSubsystem, 'Frontend')
  assert.equal(edge.targetSubsystem, 'Backend')

  const rec = edge.underlyingEdges[0]
  assert.equal(rec.sourceDirectory, 'Frontend/src/features/dashboard/widgets')
  assert.equal(rec.targetDirectory, 'Backend/src/api/v1/metrics')
  assert.equal(rec.sourceSubsystem, 'Frontend')
  assert.equal(rec.targetSubsystem, 'Backend')
})

test('Step 1.6: Missing or external/unresolved relationships do not produce invalid folder edges', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'Frontend/src/index.js' },
    ],
    edges: [
      // External package edge (e.g., node_modules or third-party)
      { id: 'e_ext', source: 'f1', target: 'external:lodash', type: 'imports' },
      // Unresolved import
      { id: 'e_unresolved', source: 'f1', target: 'unresolved:nonexistent/module.js', type: 'imports' },
    ],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  assert.equal(hierarchy.folderEdges.length, 0, 'External/unresolved edges must not create synthetic folder edges')

  const geometry = computeGraphGeometry(repository, new Set())
  assert.equal(geometry.edges.length, 0, 'No phantom edges on canvas for external/unresolved targets')
})

test('Step 1.7: Cross-directory-only filtering suppresses only intra-directory edges without altering layout', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'Frontend/src/components/A.jsx', folder: 'Frontend', directory: 'Frontend/src/components' },
      { id: 'f2', path: 'Frontend/src/components/B.jsx', folder: 'Frontend', directory: 'Frontend/src/components' },
      { id: 'f3', path: 'Frontend/src/lib/utils.js', folder: 'Frontend', directory: 'Frontend/src/lib' },
      { id: 'b1', path: 'Backend/app.js', folder: 'Backend', directory: 'Backend' },
    ],
    edges: [
      // Same directory edge
      { id: 'e_same_dir', source: 'f1', target: 'f2', type: 'imports' },
      // Cross directory within same subsystem
      { id: 'e_cross_dir', source: 'f1', target: 'f3', type: 'imports' },
      // Cross subsystem edge
      { id: 'e_cross_sub', source: 'f1', target: 'b1', type: 'calls' },
    ],
  }

  // Fully expand Frontend and Backend to examine file-level edges
  const expanded = new Set([
    'Frontend',
    'Frontend/src',
    'Frontend/src/components',
    'Frontend/src/lib',
    'Backend',
  ])
  const unfiltered = computeGraphGeometry(repository, expanded, { crossDirectoryOnly: false })
  const filtered = computeGraphGeometry(repository, expanded, { crossDirectoryOnly: true })

  // Verify node coordinates are byte-for-byte identical (Zero layout shift guarantee)
  assert.equal(unfiltered.nodes.length, filtered.nodes.length)
  for (let i = 0; i < unfiltered.nodes.length; i++) {
    assert.equal(unfiltered.nodes[i].id, filtered.nodes[i].id)
    assert.deepEqual(unfiltered.nodes[i].position, filtered.nodes[i].position)
  }

  // Unfiltered should contain the intra-directory edge (f1 -> f2)
  const unfilteredSameDir = unfiltered.edges.find((e) => e.source === 'file:f1' && e.target === 'file:f2')
  assert.ok(unfilteredSameDir, 'Same-directory edge must be present when filter is OFF')

  // Filtered must suppress the intra-directory edge, but keep cross-directory and cross-subsystem edges
  const filteredSameDir = filtered.edges.find((e) => e.source === 'file:f1' && e.target === 'file:f2')
  assert.equal(filteredSameDir, undefined, 'Same-directory edge must be suppressed when filter is ON')

  const filteredCrossDir = filtered.edges.find((e) => e.source === 'file:f1' && e.target === 'file:f3')
  assert.ok(filteredCrossDir, 'Cross-directory edge must remain visible')

  const filteredCrossSub = filtered.edges.find((e) => e.source === 'file:f1' && e.target === 'file:b1')
  assert.ok(filteredCrossSub, 'Cross-subsystem edge must remain visible')
})

test('Step 1.8: Aggregate provenance retains complete canonical IDs, paths, and evidence', () => {
  const repository = {
    files: [
      { id: 'f_app', path: 'Frontend/src/App.jsx' },
      { id: 'b_api', path: 'Backend/routes/api.js' },
    ],
    edges: [
      {
        id: 'canonical:f_app->b_api:1',
        source: 'Frontend/src/App.jsx',
        target: 'Backend/routes/api.js',
        type: 'calls',
        evidence: [
          {
            file: 'Frontend/src/App.jsx',
            line: 42,
            column: 8,
            symbol: 'fetchGraphSummary',
            snippet: 'await fetchGraphSummary()',
          },
        ],
      },
    ],
  }

  const geometry = computeGraphGeometry(repository, new Set())
  const folderEdge = geometry.edges[0]
  assert.ok(folderEdge)

  const record = folderEdge.underlyingEdges[0]
  assert.equal(record.id, 'canonical:f_app->b_api:1')
  assert.equal(record.sourcePath, 'Frontend/src/App.jsx')
  assert.equal(record.targetPath, 'Backend/routes/api.js')
  assert.equal(record.type, 'calls')
  assert.ok(record.evidence)
  assert.equal(record.evidence[0].line, 42)
  assert.equal(record.evidence[0].snippet, 'await fetchGraphSummary()')
})

test('Step 1.9: Mode switching: Overview presents aggregate folder edge, Detailed view expands to underlying file nodes', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'Frontend/src/main.jsx' },
      { id: 'b1', path: 'Backend/server.js' },
    ],
    edges: [
      { id: 'edge_main_server', source: 'f1', target: 'b1', type: 'calls' },
    ],
  }

  // 1. Architecture Overview (all folders collapsed)
  const overview = computeGraphGeometry(repository, new Set())
  assert.equal(overview.edges.length, 1)
  assert.equal(overview.edges[0].source, 'folder:Frontend')
  assert.equal(overview.edges[0].target, 'folder:Backend')
  assert.equal(overview.edges[0].isAggregated, true)

  // 2. Detailed View (folders expanded down to files)
  const detailed = computeGraphGeometry(repository, new Set(['Frontend', 'Frontend/src', 'Backend']))
  assert.equal(detailed.edges.length, 1)
  assert.equal(detailed.edges[0].source, 'file:f1')
  assert.equal(detailed.edges[0].target, 'file:b1')
  assert.equal(detailed.edges[0].isAggregated, false)
  assert.equal(detailed.edges[0].underlyingEdges[0].id, 'edge_main_server')
})

test('Step 1.10: Edge filtering and selection decoration do not re-run Dagre or alter node positions', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'Frontend/src/a.jsx' },
      { id: 'f2', path: 'Frontend/src/b.jsx' },
      { id: 'b1', path: 'Backend/c.js' },
    ],
    edges: [
      { id: 'e1', source: 'f1', target: 'f2', type: 'imports' },
      { id: 'e2', source: 'f1', target: 'b1', type: 'imports' },
    ],
  }

  const geometry = computeGraphGeometry(repository, new Set(['Frontend', 'Backend']))
  const decoratedNoSelection = decorateGraphElements(geometry, null, null)
  const decoratedWithSelection = decorateGraphElements(geometry, 'file:f1', null)

  // Positions must match exactly between unselected and selected
  assert.equal(decoratedNoSelection.nodes.length, decoratedWithSelection.nodes.length)
  for (let i = 0; i < decoratedNoSelection.nodes.length; i++) {
    assert.deepEqual(
      decoratedNoSelection.nodes[i].position,
      decoratedWithSelection.nodes[i].position,
      'Node positions must remain strictly invariant during selection decoration',
    )
  }
})
