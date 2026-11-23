import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveDirectoryHierarchy,
  computeCodeEligibleDirectories,
  isSourceCodePath,
  isRequiredConfigPath,
  isEligibleCodeFile,
  isEligibleWorkspaceFile,
  getLayout,
} from '../src/lib/repositoryGraph.js'
import { computeGraphGeometry } from '../src/components/map/buildElements.js'

test('Step 2.1: Documentation-only directory branch (docs/ with .md files) is excluded from workspace folders', () => {
  const repository = {
    name: 'test/doc-only',
    files: [
      { id: 'docs/README.md', path: 'docs/README.md', name: 'README.md', kind: 'doc' },
      { id: 'docs/guide.md', path: 'docs/guide.md', name: 'guide.md', kind: 'doc' },
      { id: 'src/main.ts', path: 'src/main.ts', name: 'main.ts', kind: 'source', isParsed: true },
    ],
    edges: [],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  const folderIds = hierarchy.folders.map((f) => f.id)

  assert.ok(folderIds.includes('src'), 'src directory must be included')
  assert.ok(!folderIds.includes('docs'), 'docs directory containing only .md must be excluded from folders')
  assert.equal(hierarchy.folderMap.has('docs'), false, 'docs must not exist in folderMap')

  // But fileMap retains full authoritative repository files
  assert.ok(hierarchy.fileMap.has('docs/README.md'), 'docs/README.md must remain accessible in fileMap')
  assert.ok(hierarchy.fileMap.has('docs/guide.md'), 'docs/guide.md must remain accessible in fileMap')
})

test('Step 2.2: Media-only directory branch (media/ with images) is excluded from workspace folders', () => {
  const repository = {
    name: 'test/media-only',
    files: [
      { id: 'media/logo.png', path: 'media/logo.png', name: 'logo.png', kind: 'asset' },
      { id: 'media/banner.jpg', path: 'media/banner.jpg', name: 'banner.jpg', kind: 'asset' },
      { id: 'app.js', path: 'app.js', name: 'app.js', kind: 'source', isParsed: true },
    ],
    edges: [],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  const folderIds = hierarchy.folders.map((f) => f.id)

  assert.ok(!folderIds.includes('media'), 'media folder containing only images must be excluded')
  assert.equal(hierarchy.folderMap.has('media'), false)
  assert.ok(hierarchy.fileMap.has('media/logo.png'), 'media/logo.png must remain indexed in fileMap')
})

test('Step 2.3: Directory named docs containing eligible source code (docs/examples/demo.js) remains visible and discoverable', () => {
  const repository = {
    name: 'test/docs-with-code',
    files: [
      { id: 'docs/overview.md', path: 'docs/overview.md', name: 'overview.md', kind: 'doc' },
      { id: 'docs/examples/demo.js', path: 'docs/examples/demo.js', name: 'demo.js', kind: 'source', isParsed: true },
      { id: 'src/index.js', path: 'src/index.js', name: 'index.js', kind: 'source', isParsed: true },
    ],
    edges: [
      { source: 'src/index.js', target: 'docs/examples/demo.js' },
    ],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  const folderIds = hierarchy.folders.map((f) => f.id)

  assert.ok(folderIds.includes('docs'), 'docs directory must NOT be excluded by name when it has code descendants')
  assert.ok(folderIds.includes('src'), 'src directory must be included')

  const docsNode = hierarchy.folderMap.get('docs')
  assert.ok(docsNode, 'docs directory node must exist')
  assert.ok(docsNode.subfolders.some((s) => s.id === 'docs/examples'), 'docs/examples subfolder must be present')

  const examplesNode = hierarchy.folderMap.get('docs/examples')
  assert.ok(examplesNode, 'docs/examples directory node must exist')
  assert.ok(examplesNode.directFiles.some((f) => f.path === 'docs/examples/demo.js'), 'demo.js must be a directFile in docs/examples')
})

test('Step 2.4: Directory named assets containing eligible source code (assets/scripts/analytics.js) remains visible', () => {
  const repository = {
    name: 'test/assets-with-code',
    files: [
      { id: 'assets/logo.svg', path: 'assets/logo.svg', name: 'logo.svg', kind: 'asset' },
      { id: 'assets/scripts/analytics.js', path: 'assets/scripts/analytics.js', name: 'analytics.js', kind: 'source' },
    ],
    edges: [],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  const folderIds = hierarchy.folders.map((f) => f.id)

  assert.ok(folderIds.includes('assets'), 'assets folder must remain visible when it contains script/source descendant')
  const assetsNode = hierarchy.folderMap.get('assets')
  assert.ok(assetsNode.subfolders.some((s) => s.id === 'assets/scripts'), 'assets/scripts subfolder must exist')
})

test('Step 2.5: Mixed-content folder (src/ with index.ts and logo.png) retains code and omits media clutter from directFiles', () => {
  const repository = {
    name: 'test/mixed-folder',
    files: [
      { id: 'src/index.ts', path: 'src/index.ts', name: 'index.ts', kind: 'source', isParsed: true },
      { id: 'src/logo.png', path: 'src/logo.png', name: 'logo.png', kind: 'asset' },
      { id: 'src/README.md', path: 'src/README.md', name: 'README.md', kind: 'doc' },
    ],
    edges: [],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  const srcNode = hierarchy.folderMap.get('src')
  assert.ok(srcNode, 'src folder node must exist')

  // DirectFiles on canvas must display code, omitting media and docs from visual clutter
  const directPaths = srcNode.directFiles.map((f) => f.path)
  assert.ok(directPaths.includes('src/index.ts'), 'index.ts must be in directFiles')
  assert.ok(!directPaths.includes('src/logo.png'), 'logo.png must be omitted from canvas directFiles')
  assert.ok(!directPaths.includes('src/README.md'), 'README.md must be omitted from canvas directFiles')

  // FileMap must still index all files
  assert.ok(hierarchy.fileMap.has('src/index.ts'))
  assert.ok(hierarchy.fileMap.has('src/logo.png'))
  assert.ok(hierarchy.fileMap.has('src/README.md'))
})

test('Step 2.6: Root-level configuration files (package.json, tsconfig.json) are retained in rootFiles and fileMap without creating synthetic Root Files folder when root has no code', () => {
  const repository = {
    name: 'test/root-config',
    files: [
      { id: 'package.json', path: 'package.json', name: 'package.json', kind: 'config' },
      { id: 'tsconfig.json', path: 'tsconfig.json', name: 'tsconfig.json', kind: 'config' },
      { id: 'README.md', path: 'README.md', name: 'README.md', kind: 'doc' },
      { id: 'src/server.ts', path: 'src/server.ts', name: 'server.ts', kind: 'source', isParsed: true },
    ],
    edges: [],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  const folderIds = hierarchy.folders.map((f) => f.id)

  assert.ok(folderIds.includes('src'), 'src folder must be present')
  assert.ok(!folderIds.includes('root'), 'synthetic root folder must not be created when root has no code files')

  // But rootFiles array and fileMap preserve complete configurations
  const rootPaths = hierarchy.rootFiles.map((f) => f.path)
  assert.ok(rootPaths.includes('package.json'), 'package.json must be in rootFiles')
  assert.ok(rootPaths.includes('tsconfig.json'), 'tsconfig.json must be in rootFiles')
  assert.ok(rootPaths.includes('README.md'), 'README.md must be in rootFiles')

  assert.ok(hierarchy.fileMap.has('package.json'), 'fileMap must contain package.json')
  assert.ok(hierarchy.fileMap.has('tsconfig.json'), 'fileMap must contain tsconfig.json')
})

test('Step 2.7: Nested configuration (Frontend/package.json) remains accessible in fileMap for resolvers', () => {
  const repository = {
    name: 'test/nested-config',
    files: [
      { id: 'Frontend/package.json', path: 'Frontend/package.json', name: 'package.json', kind: 'config' },
      { id: 'Frontend/src/App.jsx', path: 'Frontend/src/App.jsx', name: 'App.jsx', kind: 'source', isParsed: true },
    ],
    edges: [],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  assert.ok(hierarchy.fileMap.has('Frontend/package.json'), 'Frontend/package.json must be indexed in fileMap')
  assert.equal(isRequiredConfigPath('Frontend/package.json'), true, 'Frontend/package.json must be recognized as required config')
})

test('Step 2.8: computeCodeEligibleDirectories correctly identifies branches with eligible code descendants', () => {
  const files = [
    { path: 'docs/api/spec.md' },
    { path: 'docs/api/client.py' },
    { path: 'scripts/deploy.sh' },
    { path: 'media/images/banner.png' },
    { path: 'Backend/services/user.go' },
  ]

  const eligibleDirs = computeCodeEligibleDirectories(files)

  // docs/api/client.py makes docs and docs/api eligible
  assert.ok(eligibleDirs.has('docs'))
  assert.ok(eligibleDirs.has('docs/api'))

  // Backend/services/user.go makes Backend and Backend/services eligible
  assert.ok(eligibleDirs.has('Backend'))
  assert.ok(eligibleDirs.has('Backend/services'))

  // media has only banner.png -> NOT eligible
  assert.ok(!eligibleDirs.has('media'))
  assert.ok(!eligibleDirs.has('media/images'))
})

test('Step 2.9: Repository with zero eligible source files is handled cleanly without synthetic folders', () => {
  const repository = {
    name: 'test/pure-docs',
    files: [
      { id: 'README.md', path: 'README.md', name: 'README.md', kind: 'doc' },
      { id: 'CONTRIBUTING.md', path: 'CONTRIBUTING.md', name: 'CONTRIBUTING.md', kind: 'doc' },
      { id: 'LICENSE', path: 'LICENSE', name: 'LICENSE', kind: 'doc' },
    ],
    edges: [],
  }

  const hierarchy = deriveDirectoryHierarchy(repository)
  assert.equal(hierarchy.folders.length, 0, 'No folders should be created')
  assert.equal(hierarchy.rootFiles.length, 3, 'All root files are preserved')
  assert.ok(hierarchy.fileMap.has('README.md'), 'README.md indexed in fileMap')
  assert.ok(hierarchy.fileMap.has('CONTRIBUTING.md'), 'CONTRIBUTING.md indexed in fileMap')
  assert.ok(hierarchy.fileMap.has('LICENSE'), 'LICENSE indexed in fileMap')
})

test('Step 2.10: Unknown file extensions do not become source-code nodes', () => {
  assert.equal(isSourceCodePath('data.xyz_unknown'), false)
  assert.equal(isSourceCodePath('model.weights'), false)
  assert.equal(isSourceCodePath('bundle.map'), false)

  assert.equal(isSourceCodePath('src/App.tsx'), true)
  assert.equal(isSourceCodePath('backend/main.go'), true)
  assert.equal(isSourceCodePath('server/Service.java'), true)
  assert.equal(isSourceCodePath('lib/util.rs'), true)
  assert.equal(isSourceCodePath('script.py'), true)
})

test('Step 2.11: computeGraphGeometry passes filterOptions and builds clean React Flow elements', () => {
  const repository = {
    name: 'test/geometry-filter',
    files: [
      { id: 'docs/README.md', path: 'docs/README.md', name: 'README.md', kind: 'doc' },
      { id: 'src/index.ts', path: 'src/index.ts', name: 'index.ts', kind: 'source', isParsed: true },
      { id: 'lib/util.ts', path: 'lib/util.ts', name: 'util.ts', kind: 'source', isParsed: true },
    ],
    edges: [
      { source: 'src/index.ts', target: 'lib/util.ts' },
    ],
  }

  const geometry = computeGraphGeometry(repository, null, { filterNonCodeFolders: true })
  const folderNodeIds = geometry.nodes.filter((n) => n.type === 'folder').map((n) => n.data.folderId)

  assert.ok(folderNodeIds.includes('src'), 'src folder node should be in React Flow canvas')
  assert.ok(folderNodeIds.includes('lib'), 'lib folder node should be in React Flow canvas')
  assert.ok(!folderNodeIds.includes('docs'), 'docs folder node should NOT be in React Flow canvas')
})
