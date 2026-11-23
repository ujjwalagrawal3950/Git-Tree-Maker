import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeGraphGeometry,
  buildElements,
} from '../src/components/map/buildElements.js'
import { deriveDirectoryHierarchy } from '../src/lib/repositoryGraph.js'

// ============================================================================
// Fixture: Multi-subsystem repository with intra- and cross-boundary edges
// ============================================================================
function createArchitectureFixture() {
  return {
    repository: 'test/architecture-exploration',
    files: [
      // Subsystem: Frontend
      { id: 'f:comp/btn', path: 'Frontend/src/components/Button.jsx', folder: 'Frontend', directory: 'Frontend/src/components' },
      { id: 'f:comp/icon', path: 'Frontend/src/components/Icon.jsx', folder: 'Frontend', directory: 'Frontend/src/components' },
      { id: 'f:lib/api', path: 'Frontend/src/lib/api.js', folder: 'Frontend', directory: 'Frontend/src/lib' },

      // Subsystem: Backend
      { id: 'b:ctrl/graph', path: 'Backend/controllers/graphController.js', folder: 'Backend', directory: 'Backend/controllers' },
      { id: 'b:ctrl/auth', path: 'Backend/controllers/authController.js', folder: 'Backend', directory: 'Backend/controllers' },
      { id: 'b:svc/db', path: 'Backend/services/database.js', folder: 'Backend', directory: 'Backend/services' },

      // Subsystem: Root / Config
      { id: 'root:pkg', path: 'package.json', folder: 'root', directory: 'root' },
      { id: 'root:readme', path: 'README.md', folder: 'root', directory: 'root' },
    ],
    edges: [
      // 1. Intra-directory edge: components/Button.jsx -> components/Icon.jsx
      { id: 'e:btn->icon', source: 'f:comp/btn', target: 'f:comp/icon', type: 'renders' },

      // 2. Cross-directory (same subsystem): components/Button.jsx -> lib/api.js
      { id: 'e:btn->api', source: 'f:comp/btn', target: 'f:lib/api', type: 'imports' },

      // 3. Cross-subsystem: Frontend/lib/api.js -> Backend/controllers/graphController.js
      { id: 'e:api->ctrl', source: 'f:lib/api', target: 'b:ctrl/graph', type: 'calls' },

      // 4. Cross-subsystem 2: Frontend/lib/api.js -> Backend/controllers/authController.js
      { id: 'e:api->auth', source: 'f:lib/api', target: 'b:ctrl/auth', type: 'calls' },

      // 5. Reverse cross-subsystem: Backend/services/database.js -> Frontend/src/lib/api.js (shared types/mock)
      { id: 'e:db->api', source: 'b:svc/db', target: 'f:lib/api', type: 'references' },

      // 6. Root edge: package.json -> Frontend/src/lib/api.js
      { id: 'e:pkg->api', source: 'root:pkg', target: 'f:lib/api', type: 'references' },
    ],
  }
}

// ============================================================================
// Test 1: Cross-Directory Only filtering
// ============================================================================
test('Phase 4: Cross-Directory Only filtering suppresses intra-directory edges without altering node positions', () => {
  const repo = createArchitectureFixture()

  // Fully expand all folders to reveal direct file nodes
  const expanded = new Set([
    'Frontend',
    'Frontend/src',
    'Frontend/src/components',
    'Frontend/src/lib',
    'Backend',
    'Backend/controllers',
    'Backend/services',
    'root',
  ])

  // 1. Unfiltered: all edges present
  const unfiltered = computeGraphGeometry(repo, expanded, { crossDirectoryOnly: false })
  const unfilteredEdgeIds = unfiltered.edges.map((e) => e.id)

  // Intra-directory edge Button -> Icon must be present when unfiltered
  const intraEdge = unfiltered.edges.find(
    (e) => e.source === 'file:f:comp/btn' && e.target === 'file:f:comp/icon',
  )
  assert.ok(intraEdge, 'Intra-directory edge must be present when crossDirectoryOnly is false')
  assert.equal(intraEdge.isCrossDirectory, false)

  // 2. Filtered: crossDirectoryOnly is true
  const filtered = computeGraphGeometry(repo, expanded, { crossDirectoryOnly: true })
  const filteredEdge = filtered.edges.find(
    (e) => e.source === 'file:f:comp/btn' && e.target === 'file:f:comp/icon',
  )
  assert.equal(filteredEdge, undefined, 'Intra-directory edge must be suppressed when crossDirectoryOnly is true')

  // Cross-directory edge Button -> api.js MUST remain present
  const crossDirEdge = filtered.edges.find(
    (e) => e.source === 'file:f:comp/btn' && e.target === 'file:f:lib/api',
  )
  assert.ok(crossDirEdge, 'Cross-directory edge Button -> api.js must remain visible')
  assert.equal(crossDirEdge.isCrossDirectory, true)

  // Cross-subsystem edge api.js -> graphController.js MUST remain present
  const crossSubsystemEdge = filtered.edges.find(
    (e) => e.source === 'file:f:lib/api' && e.target === 'file:b:ctrl/graph',
  )
  assert.ok(crossSubsystemEdge, 'Cross-subsystem edge api.js -> graphController must remain visible')
  assert.equal(crossSubsystemEdge.isCrossSubsystem, true)

  // Safeguard 2: Node positions must NOT change when crossDirectoryOnly is toggled
  assert.equal(unfiltered.nodes.length, filtered.nodes.length, 'Node count must remain identical')
  for (let i = 0; i < unfiltered.nodes.length; i++) {
    const un = unfiltered.nodes[i]
    const fn = filtered.nodes[i]
    assert.equal(un.id, fn.id)
    assert.equal(un.position.x, fn.position.x, `Node ${un.id} x-coord must remain identical`)
    assert.equal(un.position.y, fn.position.y, `Node ${un.id} y-coord must remain identical`)
  }
})

// ============================================================================
// Test 2: Subsystem-to-subsystem dependency aggregation and traceability
// ============================================================================
test('Phase 4: Aggregated folder edges preserve 100% underlying canonical dependency records', () => {
  const repo = createArchitectureFixture()

  // All folders collapsed: macro architectural view
  const collapsed = new Set()
  const geometry = computeGraphGeometry(repo, collapsed)

  // Top-level edge Frontend -> Backend aggregates:
  // e:api->ctrl (calls) and e:api->auth (calls)
  const feToBeEdge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.ok(feToBeEdge, 'Aggregated edge folder:Frontend -> folder:Backend must exist')
  assert.equal(feToBeEdge.isAggregated, true)
  assert.equal(feToBeEdge.count, 2, 'Must count exactly 2 canonical dependencies')
  assert.equal(feToBeEdge.label, 'calls (2)', 'Must display concise label with count')

  // Safeguard 3: Every aggregated edge must retain its underlying canonical dependency records
  assert.ok(Array.isArray(feToBeEdge.underlyingEdges), 'underlyingEdges array must exist')
  assert.equal(feToBeEdge.underlyingEdges.length, 2)

  const rec1 = feToBeEdge.underlyingEdges.find((u) => u.id === 'e:api->ctrl')
  assert.ok(rec1, 'Underlying edge e:api->ctrl must be preserved')
  assert.equal(rec1.sourceId, 'f:lib/api')
  assert.equal(rec1.targetId, 'b:ctrl/graph')
  assert.equal(rec1.sourcePath, 'Frontend/src/lib/api.js')
  assert.equal(rec1.targetPath, 'Backend/controllers/graphController.js')
  assert.equal(rec1.type, 'calls')
  assert.equal(rec1.sourceSubsystem, 'Frontend')
  assert.equal(rec1.targetSubsystem, 'Backend')

  const rec2 = feToBeEdge.underlyingEdges.find((u) => u.id === 'e:api->auth')
  assert.ok(rec2, 'Underlying edge e:api->auth must be preserved')
  assert.equal(rec2.targetPath, 'Backend/controllers/authController.js')
  assert.equal(rec2.type, 'calls')
})

// ============================================================================
// Test 3: Directionality and non-duplication of bidirectional subsystem communication
// ============================================================================
test('Phase 4: Bidirectional subsystem dependencies preserve separate directional channels', () => {
  const repo = createArchitectureFixture()

  // Collapsed macro view
  const geometry = computeGraphGeometry(repo, new Set())

  // Forward channel: Frontend -> Backend (2 calls)
  const forwardEdge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.ok(forwardEdge, 'Forward edge Frontend -> Backend must exist')
  assert.equal(forwardEdge.count, 2)

  // Reverse channel: Backend -> Frontend (1 references)
  const reverseEdge = geometry.edges.find(
    (e) => e.source === 'folder:Backend' && e.target === 'folder:Frontend',
  )
  assert.ok(reverseEdge, 'Reverse edge Backend -> Frontend must exist as distinct edge')
  assert.equal(reverseEdge.count, 1)
  assert.equal(reverseEdge.underlyingEdges[0].id, 'e:db->api')
  assert.equal(reverseEdge.underlyingEdges[0].type, 'references')

  // Verify that hierarchy folderEdges matches canvas aggregation
  const hierarchy = deriveDirectoryHierarchy(repo)
  const hForward = hierarchy.folderEdges.find(
    (e) => e.source === 'Frontend' && e.target === 'Backend',
  )
  const hReverse = hierarchy.folderEdges.find(
    (e) => e.source === 'Backend' && e.target === 'Frontend',
  )
  assert.equal(hForward?.count, 2)
  assert.equal(hReverse?.count, 1)
})

// ============================================================================
// Test 4: Expansion dissolution and root files handling
// ============================================================================
test('Phase 4: Expanding folder dissolves aggregated edge into direct edges and preserves root files', () => {
  const repo = createArchitectureFixture()

  // Expand Frontend so its files are direct nodes, but Backend remains collapsed
  const partialExpanded = new Set(['Frontend', 'Frontend/src', 'Frontend/src/lib'])
  const elements = buildElements(repo, partialExpanded, null)

  // Aggregated edge from folder:Frontend -> folder:Backend must NOT exist because Frontend is expanded
  const oldAggregated = elements.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.equal(oldAggregated, undefined, 'Old aggregate edge must dissolve when folder expands')

  // Instead, direct file:f:lib/api -> folder:Backend should exist with count 2
  const semiAggregated = elements.edges.find(
    (e) => e.source === 'file:f:lib/api' && e.target === 'folder:Backend',
  )
  assert.ok(semiAggregated, 'Edge from file:api -> folder:Backend must exist')
  assert.equal(semiAggregated.count, 2)
  assert.equal(semiAggregated.underlyingEdges.length, 2)

  // Root files handling: root:pkg references f:lib/api
  const rootEdge = elements.edges.find(
    (e) => e.source === 'folder:root' && e.target === 'file:f:lib/api',
  )
  assert.ok(rootEdge, 'Edge from folder:root -> file:api must exist')
  assert.equal(rootEdge.underlyingEdges[0].id, 'e:pkg->api')
})
