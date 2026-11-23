import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeManifestWithGraph,
  deriveDirectoryHierarchy,
} from '../src/lib/repositoryGraph.js'

test('Stage 1 - Scenario 1: Backend, Docs and Frontend all appear when present in the manifest', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { path: 'Backend/app.js', name: 'app.js', size: 1024 },
      { path: 'Backend/server.js', name: 'server.js', size: 2048 },
      { path: 'Docs/architecture.md', name: 'architecture.md', size: 512 },
      { path: 'Frontend/src/main.jsx', name: 'main.jsx', size: 800 },
      { path: 'Frontend/package.json', name: 'package.json', size: 300 },
    ],
  }

  const merged = mergeManifestWithGraph({ manifest })
  const hierarchy = deriveDirectoryHierarchy(merged)

  const folderIds = hierarchy.folders.map((f) => f.id)
  assert.ok(folderIds.includes('Backend'), 'Backend directory must appear')
  assert.ok(folderIds.includes('Docs'), 'Docs directory must appear')
  assert.ok(folderIds.includes('Frontend'), 'Frontend directory must appear')

  const backendFolder = hierarchy.folders.find((f) => f.id === 'Backend')
  assert.equal(backendFolder.files.length, 2)

  const docsFolder = hierarchy.folders.find((f) => f.id === 'Docs')
  assert.equal(docsFolder.files.length, 1)

  const frontendFolder = hierarchy.folders.find((f) => f.id === 'Frontend')
  assert.equal(frontendFolder.files.length, 2)
})

test('Stage 1 - Scenario 2: Root-level .gitignore and README.md are preserved in distinct Root Files group', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { path: '.gitignore', name: '.gitignore', size: 50 },
      { path: 'README.md', name: 'README.md', size: 1200 },
      { path: 'package.json', name: 'package.json', size: 400 },
      { path: 'Backend/app.js', name: 'app.js', size: 1024 },
    ],
  }

  const merged = mergeManifestWithGraph({ manifest })
  const hierarchy = deriveDirectoryHierarchy(merged)

  assert.equal(hierarchy.rootFiles.length, 3, 'Must have exactly 3 root-level files')
  const rootPaths = hierarchy.rootFiles.map((f) => f.path)
  assert.ok(rootPaths.includes('.gitignore'))
  assert.ok(rootPaths.includes('README.md'))
  assert.ok(rootPaths.includes('package.json'))

  const rootFolder = hierarchy.folders.find((f) => f.id === 'root')
  assert.ok(rootFolder, 'Root folder must exist')
  assert.equal(rootFolder.isRoot, true, 'Must be marked as isRoot: true')
  assert.equal(rootFolder.label, 'Root Files', 'Label must be Root Files, not ordinary child directory')
})

test('Stage 1 - Scenario 3: Nested directories are preserved', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { path: 'Backend/controllers/ingestionController.js', name: 'ingestionController.js' },
      { path: 'Backend/routes/api/v1/routes.js', name: 'routes.js' },
      { path: 'Frontend/src/components/common/Button.jsx', name: 'Button.jsx' },
    ],
  }

  const merged = mergeManifestWithGraph({ manifest })
  const hierarchy = deriveDirectoryHierarchy(merged)

  const c1 = hierarchy.fileMap.get('Backend/controllers/ingestionController.js')
  assert.equal(c1.folder, 'Backend')
  assert.equal(c1.directory, 'Backend/controllers')
  assert.equal(c1.path, 'Backend/controllers/ingestionController.js')

  const r1 = hierarchy.fileMap.get('Backend/routes/api/v1/routes.js')
  assert.equal(r1.folder, 'Backend')
  assert.equal(r1.directory, 'Backend/routes/api/v1')

  const b1 = hierarchy.fileMap.get('Frontend/src/components/common/Button.jsx')
  assert.equal(b1.folder, 'Frontend')
  assert.equal(b1.directory, 'Frontend/src/components/common')

  assert.ok(hierarchy.directoryTree.has('Backend/controllers'))
  assert.ok(hierarchy.directoryTree.has('Backend/routes/api/v1'))
  assert.ok(hierarchy.directoryTree.has('Frontend/src/components/common'))
})

test('Stage 1 - Scenario 4: Documentation and unsupported files remain visible', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { path: 'Docs/specs/architecture.md', name: 'architecture.md' },
      { path: 'Docs/manual.txt', name: 'manual.txt' },
      { path: '.gitignore', name: '.gitignore' },
      { path: 'assets/logo.png', name: 'logo.png' },
    ],
  }

  const merged = mergeManifestWithGraph({ manifest })
  const hierarchy = deriveDirectoryHierarchy(merged)

  const docFile = hierarchy.fileMap.get('Docs/specs/architecture.md')
  assert.ok(docFile)
  assert.equal(docFile.kind, 'doc')
  assert.equal(docFile.status, 'unparsed')

  const gitignoreFile = hierarchy.fileMap.get('.gitignore')
  assert.ok(gitignoreFile)
  assert.equal(gitignoreFile.kind, 'config')

  const assetFile = hierarchy.fileMap.get('assets/logo.png')
  assert.ok(assetFile)
  assert.equal(assetFile.kind, 'asset')
})

test('Stage 1 - Scenario 5: Files without dependency edges remain visible', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { path: 'Backend/isolatedHelper.js', name: 'isolatedHelper.js' },
      { path: 'Backend/connectedFile.js', name: 'connectedFile.js' },
    ],
  }

  const graphNodes = [
    { id: 'node:connected', type: 'file', path: 'Backend/connectedFile.js', data: { label: 'connectedFile.js' } },
  ]
  const graphEdges = [] // 0 edges

  const merged = mergeManifestWithGraph({
    manifest,
    graphNodes,
    graphEdges,
  })
  const hierarchy = deriveDirectoryHierarchy(merged)

  assert.equal(hierarchy.folders.length, 1)
  const backendFolder = hierarchy.folders[0]
  assert.equal(backendFolder.files.length, 2, 'Both connected and isolated files must be retained')
  assert.ok(backendFolder.files.some((f) => f.path === 'Backend/isolatedHelper.js'))
  assert.ok(backendFolder.files.some((f) => f.path === 'Backend/connectedFile.js'))
})

test('Stage 1 - Scenario 6: Unparsed files remain visible with correct status', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { path: 'Backend/parsed.js', name: 'parsed.js' },
      { path: 'Backend/pending.js', name: 'pending.js' },
    ],
  }

  const graphNodes = [
    { id: 'node:parsed', type: 'file', path: 'Backend/parsed.js', data: { status: 'complete' } },
  ]

  const merged = mergeManifestWithGraph({
    manifest,
    graphNodes,
  })
  const hierarchy = deriveDirectoryHierarchy(merged)

  const parsed = hierarchy.fileMap.get('node:parsed') || hierarchy.fileMap.get('Backend/parsed.js')
  assert.ok(parsed)
  assert.equal(parsed.isParsed, true)
  assert.equal(parsed.status, 'complete')

  const unparsed = hierarchy.fileMap.get('Backend/pending.js')
  assert.ok(unparsed)
  assert.equal(unparsed.isParsed, false)
  assert.equal(unparsed.status, 'unparsed')
})

test('Stage 1 - Scenario 7: Duplicate basenames remain distinct', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'a1b2c3d4e5f60000000000000000000000000000',
    files: [
      { path: 'package.json', name: 'package.json' },
      { path: 'Backend/package.json', name: 'package.json' },
      { path: 'Frontend/package.json', name: 'package.json' },
    ],
  }

  const merged = mergeManifestWithGraph({ manifest })
  const hierarchy = deriveDirectoryHierarchy(merged)

  assert.equal(hierarchy.fileMap.size, 3)

  const rootPkg = hierarchy.fileMap.get('package.json')
  const backendPkg = hierarchy.fileMap.get('Backend/package.json')
  const frontendPkg = hierarchy.fileMap.get('Frontend/package.json')

  assert.ok(rootPkg)
  assert.ok(backendPkg)
  assert.ok(frontendPkg)

  assert.equal(rootPkg.folder, 'root')
  assert.equal(backendPkg.folder, 'Backend')
  assert.equal(frontendPkg.folder, 'Frontend')

  assert.notEqual(rootPkg.id, backendPkg.id)
  assert.notEqual(backendPkg.id, frontendPkg.id)
})

test('Stage 1 - Scenario 8: Graph and manifest from different commits are not silently combined', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'commit_AAAAAAAAAA11111111111111111111111111',
    files: [{ path: 'app.js', name: 'app.js' }],
  }

  const graphSummary = {
    repository: 'acme/monorepo',
    commitSha: 'commit_BBBBBBBBBB22222222222222222222222222', // Mismatched commit
  }

  assert.throws(
    () => {
      mergeManifestWithGraph({
        manifest,
        graphSummary,
      })
    },
    (err) => {
      assert.ok(err.message.includes('Commit mismatch'))
      return true
    },
  )
})

test('Stage 1 - Scenario 9: Missing or unavailable manifest data produces an explicit error', () => {
  assert.throws(
    () => {
      mergeManifestWithGraph({ manifest: null })
    },
    (err) => {
      assert.ok(err.message.includes('manifest is missing or invalid'))
      return true
    },
  )

  assert.throws(
    () => {
      mergeManifestWithGraph({ manifest: {} })
    },
    (err) => {
      assert.ok(err.message.includes('manifest is missing or invalid'))
      return true
    },
  )
})

test('Stage 1 - Scenario 10: Existing graph exploration behavior does not regress', () => {
  const manifest = {
    repository: 'acme/monorepo',
    commitSha: 'commit_1234567890abcdef1234567890abcdef1234',
    files: [
      { path: 'src/index.js', name: 'index.js' },
      { path: 'src/App.js', name: 'App.js' },
    ],
  }

  const graphSummary = {
    repository: 'acme/monorepo',
    commitSha: 'commit_1234567890abcdef1234567890abcdef1234',
  }

  const graphNodes = [
    { id: 'canonical:src/index.js', type: 'file', path: 'src/index.js', data: { label: 'index.js', status: 'complete' } },
    { id: 'canonical:src/App.js', type: 'file', path: 'src/App.js', data: { label: 'App.js', status: 'complete' } },
  ]

  const graphEdges = [
    { id: 'e1', source: 'canonical:src/index.js', target: 'canonical:src/App.js', count: 1, tone: 'outgoing' },
  ]

  const merged = mergeManifestWithGraph({
    manifest,
    graphSummary,
    graphNodes,
    graphEdges,
  })

  // Canonical IDs preserved
  assert.equal(merged.files[0].id, 'canonical:src/index.js')
  assert.equal(merged.files[1].id, 'canonical:src/App.js')
  assert.equal(merged.edges.length, 1)
  assert.equal(merged.edges[0].id, 'e1')

  const hierarchy = deriveDirectoryHierarchy(merged)
  assert.equal(hierarchy.folders.length, 1)
  assert.equal(hierarchy.folders[0].id, 'src')
  assert.equal(hierarchy.folders[0].files.length, 2)
})
