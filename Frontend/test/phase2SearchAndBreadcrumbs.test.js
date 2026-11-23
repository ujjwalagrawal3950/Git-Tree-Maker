import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSearchIndex,
  searchRepository,
  deriveBreadcrumbs,
} from '../src/lib/searchIndex.js'
import { mergeManifestWithGraph } from '../src/lib/repositoryGraph.js'
import { buildElements } from '../src/components/map/buildElements.js'

function createSampleMonorepo() {
  const manifest = {
    repository: 'cartograph/full-monorepo',
    commitSha: 'd00d000000000000000000000000000000000000',
    files: [
      { path: '.gitignore', name: '.gitignore' },
      { path: 'README.md', name: 'README.md' },
      // Backend files
      { path: 'Backend/.gitignore', name: '.gitignore' },
      { path: 'Backend/app.js', name: 'app.js' },
      { path: 'Backend/package.json', name: 'package.json' },
      // Backend subfolders
      { path: 'Backend/config/env.js', name: 'env.js' },
      { path: 'Backend/config/DbConnect.js', name: 'DbConnect.js' },
      { path: 'Backend/controllers/graphController.js', name: 'graphController.js' },
      { path: 'Backend/controllers/userController.js', name: 'userController.js' },
      { path: 'Backend/routes/graphRoutes.js', name: 'graphRoutes.js' },
      { path: 'Backend/services/graph/GraphQueryService.js', name: 'GraphQueryService.js' },
      // Frontend files
      { path: 'Frontend/package.json', name: 'package.json' },
      { path: 'Frontend/src/App.jsx', name: 'App.jsx' },
      { path: 'Frontend/src/components/DetailPanel.jsx', name: 'DetailPanel.jsx' },
      { path: 'Frontend/src/components/map/DependencyMap.jsx', name: 'DependencyMap.jsx' },
      { path: 'Frontend/src/lib/api.js', name: 'api.js' },
    ],
  }

  const graphNodes = [
    {
      id: 'file:Backend/controllers/graphController.js',
      type: 'file',
      path: 'Backend/controllers/graphController.js',
      data: { label: 'graphController.js', kind: 'source', status: 'parsed' },
    },
    {
      id: 'file:Backend/controllers/graphController.js#getNodes',
      type: 'symbol',
      path: 'Backend/controllers/graphController.js',
      data: { label: 'getNodes', name: 'getNodes', kind: 'function' },
    },
    {
      id: 'file:Backend/controllers/graphController.js#getEdges',
      type: 'symbol',
      path: 'Backend/controllers/graphController.js',
      data: { label: 'getEdges', name: 'getEdges', kind: 'function' },
    },
    {
      id: 'file:Frontend/src/components/map/DependencyMap.jsx',
      type: 'file',
      path: 'Frontend/src/components/map/DependencyMap.jsx',
      data: { label: 'DependencyMap.jsx', kind: 'component', status: 'parsed' },
    },
  ]

  const graphEdges = [
    {
      id: 'e1',
      source: 'file:Backend/controllers/graphController.js',
      target: 'file:Backend/services/graph/GraphQueryService.js',
      data: { edgeType: 'imports' },
    },
  ]

  return mergeManifestWithGraph({ manifest, graphNodes, graphEdges })
}

test('Phase 2 Search: buildSearchIndex indexes files, folders, and declared symbols', () => {
  const repo = createSampleMonorepo()
  const index = buildSearchIndex(repo)

  assert.ok(index.items.length > 0, 'Index must contain items')
  assert.equal(index.repoName, 'cartograph/full-monorepo')

  // Check folder presence
  const backendFolder = index.items.find(
    (i) => i.type === 'folder' && i.id === 'Backend',
  )
  assert.ok(backendFolder, 'Index must contain Backend folder')

  const controllersFolder = index.items.find(
    (i) => i.type === 'folder' && i.id === 'Backend/controllers',
  )
  assert.ok(controllersFolder, 'Index must contain Backend/controllers folder')
  assert.deepEqual(controllersFolder.ancestors, ['Backend', 'Backend/controllers'])

  // Check file presence
  const graphCtrlFile = index.items.find(
    (i) => i.type === 'file' && i.name === 'graphController.js',
  )
  assert.ok(graphCtrlFile, 'Index must contain graphController.js')
  assert.deepEqual(graphCtrlFile.ancestors, ['Backend', 'Backend/controllers'])

  // Check symbol presence
  const getNodesSym = index.items.find(
    (i) => i.type === 'symbol' && i.name === 'getNodes',
  )
  assert.ok(getNodesSym, 'Index must contain getNodes symbol')
  assert.equal(getNodesSym.fileId, 'file:Backend/controllers/graphController.js')
  assert.deepEqual(getNodesSym.ancestors, ['Backend', 'Backend/controllers'])
})

test('Phase 2 Search: searchRepository ranks exact, prefix, and substring matches with relevance', () => {
  const repo = createSampleMonorepo()
  const index = buildSearchIndex(repo)

  // 1. Exact match on filename
  const exactRes = searchRepository(index, 'graphController.js')
  assert.ok(exactRes.length > 0)
  assert.equal(exactRes[0].name, 'graphController.js')
  assert.equal(exactRes[0].type, 'file')

  // 2. Prefix search
  const prefixRes = searchRepository(index, 'graph')
  assert.ok(prefixRes.length >= 3)
  const names = prefixRes.map((r) => r.name)
  assert.ok(names.includes('graphController.js'))
  assert.ok(names.includes('graphRoutes.js'))
  assert.ok(names.includes('GraphQueryService.js'))

  // 3. Symbol search
  const symRes = searchRepository(index, 'getNodes')
  assert.ok(symRes.length > 0)
  assert.equal(symRes[0].name, 'getNodes')
  assert.equal(symRes[0].type, 'symbol')
  assert.equal(symRes[0].filePath, 'Backend/controllers/graphController.js')

  // 4. Folder search
  const folderRes = searchRepository(index, 'controllers')
  assert.ok(folderRes.length > 0)
  assert.ok(folderRes.some((r) => r.type === 'folder' && r.id === 'Backend/controllers'))

  // 5. Empty and whitespace queries
  assert.deepEqual(searchRepository(index, ''), [])
  assert.deepEqual(searchRepository(index, '   '), [])
})

test('Phase 2 Breadcrumbs: deriveBreadcrumbs derives full hierarchical clickable paths', () => {
  const repo = createSampleMonorepo()

  // 1. Selected deeply nested file
  const fileCrumbs = deriveBreadcrumbs(
    repo,
    'file:Backend/controllers/graphController.js',
    new Set(['Backend', 'Backend/controllers']),
  )
  assert.deepEqual(
    fileCrumbs.map((c) => ({ label: c.label, type: c.type })),
    [
      { label: 'cartograph/full-monorepo', type: 'repo' },
      { label: 'Backend', type: 'folder' },
      { label: 'controllers', type: 'folder' },
      { label: 'graphController.js', type: 'file' },
    ],
  )
  assert.equal(fileCrumbs[fileCrumbs.length - 1].isLast, true)

  // 2. Selected subfolder
  const folderCrumbs = deriveBreadcrumbs(
    repo,
    'folder:Backend/controllers',
    new Set(['Backend', 'Backend/controllers']),
  )
  assert.deepEqual(
    folderCrumbs.map((c) => ({ label: c.label, type: c.type })),
    [
      { label: 'cartograph/full-monorepo', type: 'repo' },
      { label: 'Backend', type: 'folder' },
      { label: 'controllers', type: 'folder' },
    ],
  )

  // 3. No selection (shows deepest active expanded folder)
  const expandedOnlyCrumbs = deriveBreadcrumbs(
    repo,
    null,
    new Set(['Backend', 'Backend/config']),
  )
  assert.deepEqual(
    expandedOnlyCrumbs.map((c) => ({ label: c.label, type: c.type })),
    [
      { label: 'cartograph/full-monorepo', type: 'repo' },
      { label: 'Backend', type: 'folder' },
      { label: 'config', type: 'folder' },
    ],
  )

  // 4. No selection and no expanded folders (root overview)
  const rootCrumbs = deriveBreadcrumbs(repo, null, new Set())
  assert.equal(rootCrumbs.length, 1)
  assert.equal(rootCrumbs[0].type, 'repo')
  assert.equal(rootCrumbs[0].isLast, true)
})

test('Phase 2 Navigation Integration: Selecting search result auto-expands ancestors and reveals file in canvas layout', () => {
  const repo = createSampleMonorepo()
  const index = buildSearchIndex(repo)

  // User searches for graphController.js
  const searchResults = searchRepository(index, 'graphController.js')
  const targetItem = searchResults[0]
  assert.ok(targetItem)

  // Target item provides ancestors needed to make it visible
  const expanded = new Set(targetItem.ancestors)
  assert.ok(expanded.has('Backend'))
  assert.ok(expanded.has('Backend/controllers'))

  // Build canvas elements with expanded ancestors
  const { nodes, edges } = buildElements(repo, expanded, targetItem.id)

  // The controller file node MUST be rendered inside its parent folder container
  const ctrlNode = nodes.find((n) => n.id === `file:${targetItem.id}`)
  assert.ok(ctrlNode, 'graphController.js node must be rendered in canvas elements')
  assert.equal(ctrlNode.parentId, 'folder:Backend/controllers')
  assert.equal(ctrlNode.data.selected, true, 'Target node must be marked selected')

  // Ancestor folder nodes must be marked selected (not dimmed)
  const backendNode = nodes.find((n) => n.id === 'folder:Backend')
  const ctrlFolderNode = nodes.find((n) => n.id === 'folder:Backend/controllers')
  assert.equal(backendNode.data.selected, true)
  assert.equal(ctrlFolderNode.data.selected, true)
})
