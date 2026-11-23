import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveDirectoryHierarchy,
  getDirectoryFromPath,
  getLayout,
  isFolderExpanded,
  FOLDER_WIDTH,
  FOLDER_HEIGHT,
  EXPANDED_FOLDER_WIDTH,
  FILE_WIDTH,
  FILE_HEIGHT,
  expandedFolderHeight,
} from '../src/lib/repositoryGraph.js'
import { buildElements } from '../src/components/map/buildElements.js'
import { sampleRepository } from '../src/data/sampleRepository.js'

test('Step 2: getDirectoryFromPath normalizes paths into presentation directories', () => {
  assert.equal(getDirectoryFromPath('package.json'), 'root')
  assert.equal(getDirectoryFromPath('next.config.mjs'), 'root')
  assert.equal(getDirectoryFromPath('README.md'), 'root')
  assert.equal(getDirectoryFromPath(''), 'root')
  assert.equal(getDirectoryFromPath(null), 'root')

  assert.equal(getDirectoryFromPath('app/layout.jsx'), 'app')
  assert.equal(getDirectoryFromPath('app/products/page.jsx'), 'app')
  assert.equal(getDirectoryFromPath('components/Button.jsx'), 'components')
  assert.equal(getDirectoryFromPath('src/components/Button.jsx'), 'components')
  assert.equal(getDirectoryFromPath('src/hooks/useCart.ts'), 'hooks')
  assert.equal(getDirectoryFromPath('styles/globals.css'), 'styles')
  assert.equal(getDirectoryFromPath('tests/format.test.js'), 'tests')
})

test('Step 2: deriveDirectoryHierarchy reproduces exact stats from reference architecture', () => {
  const hierarchy = deriveDirectoryHierarchy(sampleRepository)
  const stats = hierarchy.stats

  // Reference UI screenshot checks:
  // app: 4 files, in: 0, out: 9
  const appStats = stats.get('app')
  assert.ok(appStats, 'app folder must exist')
  assert.equal(appStats.fileCount, 4)
  assert.equal(appStats.incoming, 0)
  assert.equal(appStats.outgoing, 9)

  // root: 2 files, in: 0, out: 0
  const rootStats = stats.get('root')
  assert.ok(rootStats, 'root folder must exist')
  assert.equal(rootStats.fileCount, 2)
  assert.equal(rootStats.incoming, 0)
  assert.equal(rootStats.outgoing, 0)

  // styles: 1 file, in: 1, out: 0
  const stylesStats = stats.get('styles')
  assert.ok(stylesStats, 'styles folder must exist')
  assert.equal(stylesStats.fileCount, 1)
  assert.equal(stylesStats.incoming, 1)
  assert.equal(stylesStats.outgoing, 0)

  // components: 6 files
  const compStats = stats.get('components')
  assert.ok(compStats, 'components folder must exist')
  assert.equal(compStats.fileCount, 6)

  // hooks: 2 files, in: 2, out: 2
  const hooksStats = stats.get('hooks')
  assert.ok(hooksStats, 'hooks folder must exist')
  assert.equal(hooksStats.fileCount, 2)
  assert.equal(hooksStats.incoming, 2)
  assert.equal(hooksStats.outgoing, 2)

  // tests: 1 file, in: 0, out: 1
  const testsStats = stats.get('tests')
  assert.ok(testsStats, 'tests folder must exist')
  assert.equal(testsStats.fileCount, 1)
  assert.equal(testsStats.incoming, 0)
  assert.equal(testsStats.outgoing, 1)

  // lib: 6 files, in: 9, out: 0
  const libStats = stats.get('lib')
  assert.ok(libStats, 'lib folder must exist')
  assert.equal(libStats.fileCount, 6)
  assert.equal(libStats.incoming, 9)
  assert.equal(libStats.outgoing, 0)
})

test('Step 2: getLayout accurately positions collapsed and expanded containers', () => {
  // Collapsed mode: all folders collapsed
  const layoutCollapsed = getLayout(sampleRepository, null)
  for (const folder of layoutCollapsed.folders) {
    const pos = layoutCollapsed.positions.get(folder.id)
    assert.equal(pos.width, FOLDER_WIDTH, `Collapsed folder ${folder.id} width must be ${FOLDER_WIDTH}`)
    assert.equal(pos.height, FOLDER_HEIGHT, `Collapsed folder ${folder.id} height must be ${FOLDER_HEIGHT}`)
  }

  // Expanded mode: components expanded
  const layoutExpanded = getLayout(sampleRepository, 'components')
  const compPos = layoutExpanded.positions.get('components')
  assert.equal(compPos.width, EXPANDED_FOLDER_WIDTH)
  assert.equal(compPos.height, expandedFolderHeight(6))

  const otherPos = layoutExpanded.positions.get('app')
  assert.equal(otherPos.width, FOLDER_WIDTH)
  assert.equal(otherPos.height, FOLDER_HEIGHT)
})

test('Step 2: buildElements assigns parent-child containment and child file coordinates', () => {
  const { nodes, edges } = buildElements(sampleRepository, 'components', null)

  // Folder nodes exist
  const folderNodes = nodes.filter((n) => n.type === 'folder')
  assert.equal(folderNodes.length, 7, 'Must have 7 folders')

  const compFolderNode = folderNodes.find((n) => n.id === 'folder:components')
  assert.ok(compFolderNode)
  assert.equal(compFolderNode.data.expanded, true)

  // Child file nodes inside expanded folder
  const fileNodes = nodes.filter((n) => n.type === 'file')
  assert.equal(fileNodes.length, 6, 'Must have 6 file nodes for components')

  for (const fileNode of fileNodes) {
    assert.equal(fileNode.parentId, 'folder:components', 'File node parentId must match folder node id')
    assert.equal(fileNode.extent, 'parent')
    assert.equal(fileNode.style.width, FILE_WIDTH)
    assert.equal(fileNode.style.height, FILE_HEIGHT)
    assert.ok(typeof fileNode.position.x === 'number')
    assert.ok(typeof fileNode.position.y === 'number')
  }

  // Edges to/from components route directly to child files when components is expanded
  const edgesToCompFiles = edges.filter((e) => e.target.startsWith('file:components/'))
  assert.ok(edgesToCompFiles.length > 0, 'Incoming edges to expanded folder must target child file nodes')

  const edgesFromCompFiles = edges.filter((e) => e.source.startsWith('file:components/'))
  assert.ok(edgesFromCompFiles.length > 0, 'Outgoing edges from expanded folder must originate from child file nodes')
})

test('Step 2: Multiple expanded directories support', () => {
  const expandedSet = new Set(['components', 'hooks'])
  assert.equal(isFolderExpanded('components', expandedSet), true)
  assert.equal(isFolderExpanded('hooks', expandedSet), true)
  assert.equal(isFolderExpanded('app', expandedSet), false)

  const { nodes } = buildElements(sampleRepository, expandedSet, null)
  const fileNodes = nodes.filter((n) => n.type === 'file')
  // 6 in components + 2 in hooks = 8 file nodes
  assert.equal(fileNodes.length, 8)
})

