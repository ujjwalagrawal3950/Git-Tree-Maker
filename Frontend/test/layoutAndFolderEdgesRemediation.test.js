import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveDirectoryHierarchy,
  getLayout,
} from '../src/lib/repositoryGraph.js'
import { buildElements } from '../src/components/map/buildElements.js'

test('Frontend Remediation: internal dependency count is computed on collapsed folders', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'src/components/AddToCart.jsx', folder: 'components' },
      { id: 'f2', path: 'src/components/Button.jsx', folder: 'components' },
      { id: 'f3', path: 'src/lib/api.js', folder: 'lib' },
    ],
    edges: [
      // Internal edge within components
      { source: 'f1', target: 'f2', type: 'imports' },
      // Cross-folder edge: components -> lib
      { source: 'f1', target: 'f3', type: 'imports' },
    ],
  }

  const { stats } = deriveDirectoryHierarchy(repository)

  const componentsStats = stats.get('components')
  assert.ok(componentsStats, 'components folder stats should exist')
  assert.equal(componentsStats.internal, 1, 'components should have 1 internal dependency')
  assert.equal(componentsStats.outgoing, 1, 'components should have 1 outgoing dependency')
  assert.equal(componentsStats.incoming, 0, 'components should have 0 incoming dependencies')

  const libStats = stats.get('lib')
  assert.ok(libStats, 'lib folder stats should exist')
  assert.equal(libStats.internal, 0, 'lib should have 0 internal dependencies')
  assert.equal(libStats.incoming, 1, 'lib should have 1 incoming dependency')
})

test('Frontend Remediation: buildElements hides canvas self-edges when folder is collapsed and passes internal count', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'src/components/AddToCart.jsx', folder: 'components' },
      { id: 'f2', path: 'src/components/Button.jsx', folder: 'components' },
    ],
    edges: [
      { source: 'f1', target: 'f2', type: 'imports' },
    ],
  }

  // Folder is collapsed (not in expandedFolders)
  const { nodes, edges } = buildElements(repository, new Set(), null)

  const folderNode = nodes.find((n) => n.id === 'folder:components')
  assert.ok(folderNode, 'folder:components should exist')
  assert.equal(folderNode.data.internal, 1, 'folderNode data should contain internal count 1')

  // When collapsed, f1 and f2 resolve to folder:components. The self-edge should NOT be drawn on canvas
  assert.equal(edges.length, 0, 'Self-edges should be suppressed on canvas for collapsed folders')
})

test('Frontend Remediation: subfolder-to-subfolder and cross-folder edges are preserved and aggregated', () => {
  const repository = {
    files: [
      { id: 'f1', path: 'Frontend/src/components/Button.jsx' },
      { id: 'f2', path: 'Frontend/src/lib/api.js' },
      { id: 'f3', path: 'Backend/controllers/graphController.js' },
    ],
    edges: [
      { source: 'f1', target: 'f2', type: 'imports' },
      { source: 'f2', target: 'f3', type: 'calls' },
    ],
  }

  // Expand Frontend to see subfolders
  const { nodes, edges } = buildElements(repository, new Set(['Frontend']), null)

  assert.ok(nodes.length > 0)
  // Cross folder edges exist
  assert.ok(edges.length > 0)
})
