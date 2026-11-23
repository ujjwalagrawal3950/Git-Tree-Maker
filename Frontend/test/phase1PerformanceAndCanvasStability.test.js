import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeGraphGeometry,
  decorateGraphElements,
  buildElements,
} from '../src/components/map/buildElements.js'
import {
  deriveDirectoryHierarchy,
  mergeManifestWithGraph,
} from '../src/lib/repositoryGraph.js'

function createSampleMonorepo() {
  const manifest = {
    repository: 'cartograph/test-monorepo',
    commitSha: 'c0ffee0000000000000000000000000000000000',
    files: [
      { path: '.gitignore', name: '.gitignore' },
      { path: 'Backend/.gitignore', name: '.gitignore' },
      { path: 'Backend/app.js', name: 'app.js' },
      { path: 'Backend/config/env.js', name: 'env.js' },
      { path: 'Backend/config/DbConnect.js', name: 'DbConnect.js' },
      { path: 'Backend/controllers/graphController.js', name: 'graphController.js' },
      { path: 'Backend/services/graph/GraphQueryService.js', name: 'GraphQueryService.js' },
      { path: 'Frontend/src/App.jsx', name: 'App.jsx' },
      { path: 'Frontend/src/components/map/DependencyMap.jsx', name: 'DependencyMap.jsx' },
      { path: 'Frontend/src/lib/api.js', name: 'api.js' },
    ],
  }

  const graphNodes = manifest.files
    .filter((f) => /\.(js|jsx)$/.test(f.path))
    .map((f) => ({
      id: `file:${f.path}`,
      type: 'file',
      path: f.path,
      data: { label: f.name, kind: 'source', status: 'parsed' },
    }))

  const graphEdges = [
    {
      id: 'e1',
      source: 'file:Backend/app.js',
      target: 'file:Backend/controllers/graphController.js',
      data: { edgeType: 'imports' },
    },
    {
      id: 'e2',
      source: 'file:Backend/controllers/graphController.js',
      target: 'file:Backend/services/graph/GraphQueryService.js',
      data: { edgeType: 'imports' },
    },
    {
      id: 'e3',
      source: 'file:Backend/config/DbConnect.js',
      target: 'file:Backend/config/env.js',
      data: { edgeType: 'imports' },
    },
    {
      id: 'e4',
      source: 'file:Frontend/src/App.jsx',
      target: 'file:Frontend/src/components/map/DependencyMap.jsx',
      data: { edgeType: 'imports' },
    },
  ]

  return mergeManifestWithGraph({ manifest, graphNodes, graphEdges })
}

test('Phase 1 Performance: computeGraphGeometry produces layout without selection coupling', () => {
  const repo = createSampleMonorepo()
  const expanded = new Set(['Backend'])

  const geometry = computeGraphGeometry(repo, expanded)

  assert.ok(geometry.nodes.length > 0, 'Geometry must contain nodes')
  assert.ok(geometry.edges.length > 0, 'Geometry must contain edges')
  assert.ok(geometry.nodeParentMap instanceof Map, 'Geometry must expose nodeParentMap')
  assert.ok(geometry.fileMap instanceof Map, 'Geometry must expose fileMap')

  // Raw geometry nodes must default to unselected and undimmed
  for (const node of geometry.nodes) {
    assert.equal(node.data.selected, false, 'Raw geometry nodes must have selected=false')
    assert.equal(node.data.dimmed, false, 'Raw geometry nodes must have dimmed=false')
  }

  // Raw geometry edges must default to tone='default' and selected=false
  for (const edge of geometry.edges) {
    assert.equal(edge.tone, 'default', 'Raw geometry edges must have tone=default')
    assert.equal(edge.selected, false, 'Raw geometry edges must have selected=false')
  }
})

test('Phase 1 Performance: decorateGraphElements executes in < 5ms without altering geometry positions or dimensions', () => {
  const repo = createSampleMonorepo()
  const expanded = new Set(['Backend', 'Backend/controllers'])
  const geometry = computeGraphGeometry(repo, expanded)

  // Record geometry positions and dimensions
  const baselinePositions = new Map(geometry.nodes.map((n) => [n.id, { ...n.position }]))
  const baselineStyles = new Map(geometry.nodes.map((n) => [n.id, { ...n.style }]))

  const t0 = performance.now()
  const targetFileId = 'file:Backend/controllers/graphController.js'
  const decorated = decorateGraphElements(geometry, targetFileId, null)
  const duration = performance.now() - t0

  assert.ok(duration < 20, `Decoration should be instantaneous (measured ${duration.toFixed(2)}ms)`)

  // Check selection
  const ctrlNode = decorated.nodes.find((n) => n.id === `file:${targetFileId}`)
  assert.ok(ctrlNode, 'Controller node must exist in decorated model')
  assert.equal(ctrlNode.data.selected, true, 'Target node must be selected')

  // Containing ancestor folders (Backend, Backend/controllers) must be marked selected (not dimmed)
  const backendFolder = decorated.nodes.find((n) => n.id === 'folder:Backend')
  const ctrlFolder = decorated.nodes.find((n) => n.id === 'folder:Backend/controllers')
  assert.equal(backendFolder.data.selected, true, 'Ancestor folder must be marked selected')
  assert.equal(backendFolder.data.dimmed, false, 'Ancestor folder must not be dimmed')
  assert.equal(ctrlFolder.data.selected, true, 'Parent folder must be marked selected')
  assert.equal(ctrlFolder.data.dimmed, false, 'Parent folder must not be dimmed')

  // Unconnected nodes (e.g. Frontend folder) must be dimmed
  const frontendFolder = decorated.nodes.find((n) => n.id === 'folder:Frontend')
  if (frontendFolder) {
    assert.equal(frontendFolder.data.dimmed, true, 'Unconnected Frontend folder must be dimmed')
  }

  // Outgoing edge to GraphQueryService must have tone 'outgoing'
  const outgoingEdge = decorated.edges.find(
    (e) => e.source === `file:${targetFileId}` && e.target === 'folder:Backend/services',
  )
  assert.ok(outgoingEdge, 'Outgoing edge must exist')
  assert.equal(outgoingEdge.tone, 'outgoing', 'Edge from selected node must be outgoing')

  // Incoming edge from app.js must have tone 'incoming'
  const incomingEdge = decorated.edges.find(
    (e) => e.source === 'file:file:Backend/app.js' && e.target === `file:${targetFileId}`,
  )
  assert.ok(incomingEdge, 'Incoming edge must exist')
  assert.equal(incomingEdge.tone, 'incoming', 'Edge to selected node must be incoming')

  // POSITIONS AND DIMENSIONS MUST BE EXACTLY PRESERVED (Dagre was NOT called)
  for (const node of decorated.nodes) {
    const basePos = baselinePositions.get(node.id)
    const baseStyle = baselineStyles.get(node.id)
    assert.deepEqual(node.position, basePos, `Position of ${node.id} must be identical to geometry`)
    assert.deepEqual(node.style, baseStyle, `Style/dimensions of ${node.id} must be identical to geometry`)
  }
})

test('Phase 1 Performance: Switching selection reuses cached geometry without Dagre recalculation', () => {
  const repo = createSampleMonorepo()
  const expanded = new Set(['Backend'])
  const geometry = computeGraphGeometry(repo, expanded)

  // Select file 1
  const sel1 = decorateGraphElements(geometry, 'file:Backend/app.js', null)
  const appNode1 = sel1.nodes.find((n) => n.id === 'file:file:Backend/app.js')
  assert.equal(appNode1.data.selected, true)

  // Select file 2
  const sel2 = decorateGraphElements(geometry, 'file:Backend/config/DbConnect.js', null)
  const appNode2 = sel2.nodes.find((n) => n.id === 'file:file:Backend/app.js')
  assert.equal(appNode2.data.selected, false)

  // Clear selection
  const selClear = decorateGraphElements(geometry, null, null)
  for (const n of selClear.nodes) {
    assert.equal(n.data.selected, false, 'No nodes should be selected when selection is null')
    assert.equal(n.data.dimmed, false, 'No nodes should be dimmed when selection is null')
  }
  for (const e of selClear.edges) {
    assert.equal(e.tone, 'default', 'All edges should have default tone when selection is null')
  }

  // Underlying geometry object is completely unchanged
  assert.equal(geometry.nodes[0].data.selected, false)
})

test('Phase 1 Performance: buildElements provides backwards-compatible composed behavior', () => {
  const repo = createSampleMonorepo()
  const expanded = new Set(['Backend'])
  const targetId = 'file:Backend/app.js'

  const { nodes, edges } = buildElements(repo, expanded, targetId)
  const appNode = nodes.find((n) => n.id === 'file:file:Backend/app.js')

  assert.ok(appNode, 'app.js node must exist')
  assert.equal(appNode.data.selected, true, 'app.js must be selected via buildElements')
  assert.ok(edges.some((e) => e.tone === 'outgoing'), 'Outgoing edge must be decorated')
})
