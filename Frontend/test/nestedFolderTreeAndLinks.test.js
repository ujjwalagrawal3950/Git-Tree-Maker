import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveDirectoryHierarchy,
  mergeManifestWithGraph,
  resolveVisibleNodeId,
} from '../src/lib/repositoryGraph.js'
import { buildElements } from '../src/components/map/buildElements.js'

function createRealisticMonorepo() {
  const manifest = {
    repository: 'ujjwal/cartograph',
    commitSha: 'a6612f3000000000000000000000000000000000',
    files: [
      { path: '.gitignore', name: '.gitignore' },
      { path: 'README.md', name: 'README.md' },
      // Backend direct files
      { path: 'Backend/.gitignore', name: '.gitignore' },
      { path: 'Backend/app.js', name: 'app.js' },
      { path: 'Backend/package.json', name: 'package.json' },
      // Backend subfolders
      { path: 'Backend/config/env.js', name: 'env.js' },
      { path: 'Backend/config/DbConnect.js', name: 'DbConnect.js' },
      { path: 'Backend/controllers/graphController.js', name: 'graphController.js' },
      { path: 'Backend/controllers/userController.js', name: 'userController.js' },
      { path: 'Backend/routes/graphRoutes.js', name: 'graphRoutes.js' },
      { path: 'Backend/routes/userRoutes.js', name: 'userRoutes.js' },
      { path: 'Backend/lib/errors.js', name: 'errors.js' },
      { path: 'Backend/services/graph/GraphQueryService.js', name: 'GraphQueryService.js' },
      { path: 'Backend/services/parser/adapters/c/parserFactory.js', name: 'parserFactory.js' },
      { path: 'Backend/services/parser/adapters/cpp/parserFactory.js', name: 'parserFactory.js' },
      { path: 'Backend/services/parser/adapters/cpp/CppAdapter.js', name: 'CppAdapter.js' },
      // Docs
      { path: 'Docs/architecture.md', name: 'architecture.md' },
      // Frontend
      { path: 'Frontend/package.json', name: 'package.json' },
      { path: 'Frontend/src/App.jsx', name: 'App.jsx' },
      { path: 'Frontend/src/components/DetailPanel.jsx', name: 'DetailPanel.jsx' },
      { path: 'Frontend/src/components/map/DependencyMap.jsx', name: 'DependencyMap.jsx' },
      { path: 'Frontend/src/lib/api.js', name: 'api.js' },
      { path: 'Frontend/src/lib/kinds.js', name: 'kinds.js' },
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
    { id: 'e1', source: 'file:Backend/app.js', target: 'file:Backend/routes/graphRoutes.js', data: { edgeType: 'imports' } },
    { id: 'e2', source: 'file:Backend/app.js', target: 'file:Backend/routes/userRoutes.js', data: { edgeType: 'imports' } },
    { id: 'e3', source: 'file:Backend/routes/graphRoutes.js', target: 'file:Backend/controllers/graphController.js', data: { edgeType: 'imports' } },
    { id: 'e4', source: 'file:Backend/routes/userRoutes.js', target: 'file:Backend/controllers/userController.js', data: { edgeType: 'imports' } },
    { id: 'e5', source: 'file:Backend/controllers/graphController.js', target: 'file:Backend/services/graph/GraphQueryService.js', data: { edgeType: 'imports' } },
    { id: 'e6', source: 'file:Backend/controllers/graphController.js', target: 'file:Backend/lib/errors.js', data: { edgeType: 'imports' } },
    { id: 'e7', source: 'file:Backend/config/DbConnect.js', target: 'file:Backend/config/env.js', data: { edgeType: 'imports' } },
    { id: 'e8', source: 'file:Backend/services/parser/adapters/cpp/CppAdapter.js', target: 'file:Backend/services/parser/adapters/cpp/parserFactory.js', data: { edgeType: 'imports' } },
    { id: 'e9', source: 'file:Frontend/src/App.jsx', target: 'file:Frontend/src/components/DetailPanel.jsx', data: { edgeType: 'imports' } },
    { id: 'e10', source: 'file:Frontend/src/App.jsx', target: 'file:Frontend/src/components/map/DependencyMap.jsx', data: { edgeType: 'imports' } },
    { id: 'e11', source: 'file:Frontend/src/App.jsx', target: 'file:Frontend/src/lib/api.js', data: { edgeType: 'imports' } },
    { id: 'e12', source: 'file:Frontend/src/components/DetailPanel.jsx', target: 'file:Frontend/src/lib/kinds.js', data: { edgeType: 'imports' } },
  ]

  return mergeManifestWithGraph({ manifest, graphNodes, graphEdges })
}

test('Nested Tree: Expanding Backend reveals ONLY its direct subfolders & direct files with links between them', () => {
  const repo = createRealisticMonorepo()
  const { nodes, edges } = buildElements(repo, new Set(['Backend']), null)

  // Direct subfolder nodes inside Backend
  const backendChildFolders = nodes.filter(
    (n) => n.type === 'folder' && n.parentId === 'folder:Backend',
  )
  const subIds = backendChildFolders.map((n) => n.data.folderId).sort()
  assert.deepEqual(subIds, [
    'Backend/config',
    'Backend/controllers',
    'Backend/lib',
    'Backend/routes',
    'Backend/services',
  ])

  // Direct file nodes inside Backend (ONLY Backend's own direct files, NOT controller/service files!)
  const backendDirectFiles = nodes.filter(
    (n) => n.type === 'file' && n.parentId === 'folder:Backend',
  )
  const directFileNames = backendDirectFiles.map((n) => n.data.label).sort()
  assert.deepEqual(directFileNames, ['.gitignore', 'app.js', 'package.json'])

  // Deeply nested files MUST NOT be dumped flat into Backend
  assert.equal(
    nodes.some((n) => n.id === 'file:file:Backend/controllers/graphController.js'),
    false,
    'Nested controller files must stay inside collapsed controllers subfolder',
  )

  // Links MUST connect Backend's direct files and subfolders!
  const appToRoutes = edges.find(
    (e) => e.source === 'file:file:Backend/app.js' && e.target === 'folder:Backend/routes',
  )
  assert.ok(appToRoutes, 'app.js must link directly to Backend/routes subfolder')
  assert.equal(appToRoutes.count, 2)

  const routesToControllers = edges.find(
    (e) => e.source === 'folder:Backend/routes' && e.target === 'folder:Backend/controllers',
  )
  assert.ok(routesToControllers, 'Backend/routes subfolder must link to Backend/controllers subfolder')
  assert.equal(routesToControllers.count, 2)

  const controllersToServices = edges.find(
    (e) => e.source === 'folder:Backend/controllers' && e.target === 'folder:Backend/services',
  )
  assert.ok(controllersToServices, 'Backend/controllers must link to Backend/services')

  const controllersToLib = edges.find(
    (e) => e.source === 'folder:Backend/controllers' && e.target === 'folder:Backend/lib',
  )
  assert.ok(controllersToLib, 'Backend/controllers must link to Backend/lib')
})

test('Nested Tree: Expanding Backend + routes + controllers reveals direct cross-folder file-to-file links', () => {
  const repo = createRealisticMonorepo()
  const expanded = new Set(['Backend', 'Backend/routes', 'Backend/controllers'])
  const { nodes, edges } = buildElements(repo, expanded, null)

  // Both routes and controllers files are visible inside their own subfolder containers
  const graphRouteNode = nodes.find((n) => n.id === 'file:file:Backend/routes/graphRoutes.js')
  const graphCtrlNode = nodes.find((n) => n.id === 'file:file:Backend/controllers/graphController.js')
  assert.ok(graphRouteNode)
  assert.ok(graphCtrlNode)
  assert.equal(graphRouteNode.parentId, 'folder:Backend/routes')
  assert.equal(graphCtrlNode.parentId, 'folder:Backend/controllers')

  // Direct file-to-file link across folders: graphRoutes.js -> graphController.js
  const fileToFileLink = edges.find(
    (e) =>
      e.source === 'file:file:Backend/routes/graphRoutes.js' &&
      e.target === 'file:file:Backend/controllers/graphController.js',
  )
  assert.ok(fileToFileLink, 'graphRoutes.js must link directly to graphController.js across folders')

  // And graphController.js links to collapsed Backend/services subfolder
  const fileToSubfolderLink = edges.find(
    (e) =>
      e.source === 'file:file:Backend/controllers/graphController.js' &&
      e.target === 'folder:Backend/services',
  )
  assert.ok(fileToSubfolderLink, 'graphController.js must link to collapsed Backend/services')
})

test('Nested Tree: Deep nesting maintains parent-before-child order and isolates duplicate basenames', () => {
  const repo = createRealisticMonorepo()
  const expanded = new Set([
    'Backend',
    'Backend/services',
    'Backend/services/parser',
    'Backend/services/parser/adapters',
    'Backend/services/parser/adapters/c',
    'Backend/services/parser/adapters/cpp',
  ])
  const { nodes, edges } = buildElements(repo, expanded, null)

  // Verify strict pre-order: every node with a parentId must appear AFTER its parent node
  const indexById = new Map(nodes.map((n, idx) => [n.id, idx]))
  for (const node of nodes) {
    if (node.parentId) {
      assert.ok(
        indexById.has(node.parentId),
        `Parent ${node.parentId} of ${node.id} must exist`,
      )
      assert.ok(
        indexById.get(node.parentId) < indexById.get(node.id),
        `Parent ${node.parentId} must precede child ${node.id} for React Flow subflows`,
      )
    }
  }

  // Duplicate parserFactory.js files live cleanly in separate c/ and cpp/ subfolder containers
  const cFactory = nodes.find(
    (n) => n.id === 'file:file:Backend/services/parser/adapters/c/parserFactory.js',
  )
  const cppFactory = nodes.find(
    (n) => n.id === 'file:file:Backend/services/parser/adapters/cpp/parserFactory.js',
  )
  assert.ok(cFactory && cppFactory)
  assert.equal(cFactory.parentId, 'folder:Backend/services/parser/adapters/c')
  assert.equal(cppFactory.parentId, 'folder:Backend/services/parser/adapters/cpp')

  // Link inside cpp/ connects CppAdapter.js -> cpp/parserFactory.js
  const cppLink = edges.find(
    (e) =>
      e.source === 'file:file:Backend/services/parser/adapters/cpp/CppAdapter.js' &&
      e.target === 'file:file:Backend/services/parser/adapters/cpp/parserFactory.js',
  )
  assert.ok(cppLink, 'CppAdapter.js must link to cpp/parserFactory.js')
})

test('Nested Tree: Frontend nested hierarchy links App.jsx -> components/map -> lib cleanly', () => {
  const repo = createRealisticMonorepo()
  const expanded = new Set([
    'Frontend',
    'Frontend/src',
    'Frontend/src/components',
    'Frontend/src/lib',
  ])
  const { nodes, edges } = buildElements(repo, expanded, null)

  // Frontend/src/components shows DetailPanel.jsx AND subfolder map (collapsed)
  const mapFolder = nodes.find((n) => n.id === 'folder:Frontend/src/components/map')
  assert.ok(mapFolder, 'map subfolder must be visible inside Frontend/src/components')
  assert.equal(mapFolder.parentId, 'folder:Frontend/src/components')

  // App.jsx links directly to DetailPanel.jsx, collapsed map subfolder, and lib/api.js
  assert.ok(
    edges.some(
      (e) =>
        e.source === 'file:file:Frontend/src/App.jsx' &&
        e.target === 'file:file:Frontend/src/components/DetailPanel.jsx',
    ),
  )
  assert.ok(
    edges.some(
      (e) =>
        e.source === 'file:file:Frontend/src/App.jsx' &&
        e.target === 'folder:Frontend/src/components/map',
    ),
  )
  assert.ok(
    edges.some(
      (e) =>
        e.source === 'file:file:Frontend/src/App.jsx' &&
        e.target === 'file:file:Frontend/src/lib/api.js',
    ),
  )
  assert.ok(
    edges.some(
      (e) =>
        e.source === 'file:file:Frontend/src/components/DetailPanel.jsx' &&
        e.target === 'file:file:Frontend/src/lib/kinds.js',
    ),
  )

  // Subfolder stats for Backend/controllers are computed accurately
  const hierarchy = deriveDirectoryHierarchy(repo)
  const ctrlStats = hierarchy.stats.get('Backend/controllers')
  assert.equal(ctrlStats.fileCount, 2)
  assert.equal(ctrlStats.incoming, 2)
  assert.equal(ctrlStats.outgoing, 2)

  // resolveVisibleNodeId walks ancestors cleanly
  const depMapFile = hierarchy.fileMap.get('file:Frontend/src/components/map/DependencyMap.jsx')
  assert.equal(
    resolveVisibleNodeId(depMapFile, expanded),
    'folder:Frontend/src/components/map',
  )
})
