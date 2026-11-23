import test from 'node:test'
import assert from 'node:assert/strict'
import {
  expandedFolderWidth,
  expandedFolderHeight,
  getChildFilePosition,
  getFolderColumnCount,
} from '../src/lib/repositoryGraph.js'
import { buildElements } from '../src/components/map/buildElements.js'
import { sampleRepository } from '../src/data/sampleRepository.js'

test('Architecture: Large directory (19 files) formats into spacious 3-column layout instead of single-column tower', () => {
  const fileCount = 19

  // Columns calculation
  const cols = getFolderColumnCount(fileCount)
  assert.equal(cols, 3, '19 files must use 3 columns')

  // Width & height calculation
  const width = expandedFolderWidth(fileCount)
  const height = expandedFolderHeight(fileCount)

  // Expected 3-column container width should be > 700px, not cramped 280px
  assert.ok(width >= 780, `Width (${width}) must be spacious for 3 columns`)
  // Expected height should be around 460-500px, not 900+px tall tower
  assert.ok(height <= 500, `Height (${height}) must be balanced, not an endless 900px pole`)

  // Check child positions: files are distributed across 3 columns
  const pos0 = getChildFilePosition(0, fileCount)
  const pos7 = getChildFilePosition(7, fileCount)
  const pos14 = getChildFilePosition(14, fileCount)

  assert.ok(pos0.x < pos7.x, 'Column 0 x must be less than Column 1 x')
  assert.ok(pos7.x < pos14.x, 'Column 1 x must be less than Column 2 x')
  assert.equal(pos0.y, 44, 'Row 0 top alignment')
})

test('Architecture: Edges carry clear, descriptive relationship labels', () => {
  const customRepo = {
    name: 'acme/service',
    files: [
      { id: 'app.jsx', path: 'src/app.jsx', folder: 'app' },
      { id: 'hero.jsx', path: 'src/components/hero.jsx', folder: 'components' },
      { id: 'api.js', path: 'src/lib/api.js', folder: 'lib' },
    ],
    edges: [
      { source: 'app.jsx', target: 'hero.jsx', data: { edgeType: 'renders' } },
      { source: 'app.jsx', target: 'api.js', data: { edgeType: 'calls' } },
      { source: 'hero.jsx', target: 'api.js', data: { edgeType: 'imports' } },
    ],
  }

  const { edges } = buildElements(customRepo, new Set(['app', 'components', 'lib']), null)

  assert.equal(edges.length, 3, 'Must have 3 directed edges')

  const rendersEdge = edges.find((e) => e.source === 'file:app.jsx' && e.target === 'file:hero.jsx')
  assert.ok(rendersEdge, 'Renders edge must exist')
  assert.equal(rendersEdge.label, 'renders', 'Label must be "renders"')

  const callsEdge = edges.find((e) => e.source === 'file:app.jsx' && e.target === 'file:api.js')
  assert.ok(callsEdge, 'Calls edge must exist')
  assert.equal(callsEdge.label, 'calls', 'Label must be "calls"')

  const importsEdge = edges.find((e) => e.source === 'file:hero.jsx' && e.target === 'file:api.js')
  assert.ok(importsEdge, 'Imports edge must exist')
  assert.equal(importsEdge.label, 'imports', 'Label must be "imports"')
})

test('Architecture: Expand All activates multi-folder architecture with direct file-to-file links', () => {
  // Expand app, components, and lib simultaneously
  const expanded = new Set(['app', 'components', 'lib'])
  const { nodes, edges } = buildElements(sampleRepository, expanded, null)

  // Verify file nodes exist across multiple folders simultaneously
  const fileNodes = nodes.filter((n) => n.type === 'file')
  assert.ok(fileNodes.length > 10, 'Multiple folders expanded must show child file nodes')

  // Direct file-to-file link between app and components
  const pageToHero = edges.find(
    (e) => e.source === 'file:app/page.jsx' && e.target === 'file:components/Hero.jsx',
  )
  assert.ok(pageToHero, 'Direct link from app/page.jsx to components/Hero.jsx must exist')
  assert.equal(pageToHero.label, 'imports')

  // Direct file-to-file link between components and lib
  const buttonToCn = edges.find(
    (e) => e.source === 'file:components/Button.jsx' && e.target === 'file:lib/cn.js',
  )
  assert.ok(buttonToCn, 'Direct link from components/Button.jsx to lib/cn.js must exist')
  assert.equal(buttonToCn.label, 'imports')
})
