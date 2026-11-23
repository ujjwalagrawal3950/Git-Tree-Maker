import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeManifestWithGraph,
  deriveDirectoryHierarchy,
} from '../src/lib/repositoryGraph.js'

test('Separation: Directory containers contain only files, never symbols (Backend count = 4, not 11)', () => {
  const manifest = {
    repository: 'acme/repo',
    commitSha: 'c0ffee0000000000000000000000000000000000',
    files: [
      { path: 'Backend/app.js', name: 'app.js' },
      { path: 'Backend/env.js', name: 'env.js' },
      { path: 'Backend/errors.js', name: 'errors.js' },
      { path: 'Backend/security.js', name: 'security.js' },
      { path: 'Docs/README.md', name: 'README.md' },
      { path: 'Frontend/src/main.jsx', name: 'main.jsx' },
      { path: '.gitignore', name: '.gitignore' },
    ],
  }

  // Graph nodes containing 4 backend file nodes and 7 declared symbol nodes
  const graphNodes = [
    { id: 'file:Backend/app.js', type: 'file', path: 'Backend/app.js', data: { label: 'app.js' } },
    { id: 'file:Backend/env.js', type: 'file', path: 'Backend/env.js', data: { label: 'env.js' } },
    { id: 'file:Backend/errors.js', type: 'file', path: 'Backend/errors.js', data: { label: 'errors.js' } },
    { id: 'file:Backend/security.js', type: 'file', path: 'Backend/security.js', data: { label: 'security.js' } },

    // Declared symbols owned by Backend/security.js
    { id: 'file:Backend/security.js#crypto', type: 'symbol', path: 'Backend/security.js', data: { label: 'crypto', kind: 'constant' } },
    { id: 'file:Backend/security.js#requestId', type: 'symbol', path: 'Backend/security.js', data: { label: 'requestId', kind: 'function' } },
    { id: 'file:Backend/security.js#apiLimiter', type: 'symbol', path: 'Backend/security.js', data: { label: 'apiLimiter', kind: 'constant' } },
    { id: 'file:Backend/security.js#webhookLimiter', type: 'symbol', path: 'Backend/security.js', data: { label: 'webhookLimiter', kind: 'constant' } },
    { id: 'file:Backend/security.js#securityHeaders', type: 'symbol', path: 'Backend/security.js', data: { label: 'securityHeaders', kind: 'function' } },
    { id: 'file:Backend/security.js#cors', type: 'symbol', path: 'Backend/security.js', data: { label: 'cors', kind: 'function' } },
    { id: 'file:Backend/security.js#rateLimit', type: 'symbol', path: 'Backend/security.js', data: { label: 'rateLimit', kind: 'function' } },
  ]

  const merged = mergeManifestWithGraph({ manifest, graphNodes })
  const hierarchy = deriveDirectoryHierarchy(merged)

  const backendFolder = hierarchy.folders.find((f) => f.id === 'Backend')
  assert.ok(backendFolder, 'Backend directory must exist')

  // CRITICAL CHECK: fileCount must be exactly 4 files, NOT 11 (symbols must not be siblings)
  assert.equal(
    backendFolder.files.length,
    4,
    'Backend container must contain exactly 4 files (no symbols as sibling cards)',
  )

  const backendFileNames = backendFolder.files.map((f) => f.name)
  assert.deepEqual(backendFileNames.sort(), ['app.js', 'env.js', 'errors.js', 'security.js'].sort())

  // Symbols must NOT exist as top-level files in fileMap
  assert.equal(hierarchy.fileMap.has('file:Backend/security.js#cors'), false)
  assert.equal(hierarchy.fileMap.has('file:Backend/security.js#crypto'), false)
})

test('Ownership: Declared symbols are attached to their parent file.symbols array', () => {
  const manifest = {
    repository: 'acme/repo',
    commitSha: 'c0ffee0000000000000000000000000000000000',
    files: [
      { path: 'Backend/security.js', name: 'security.js' },
    ],
  }

  const graphNodes = [
    { id: 'file:Backend/security.js', type: 'file', path: 'Backend/security.js', data: { label: 'security.js' } },
    { id: 'file:Backend/security.js#crypto', type: 'symbol', path: 'Backend/security.js', data: { label: 'crypto', kind: 'constant' } },
    { id: 'file:Backend/security.js#requestId', type: 'symbol', path: 'Backend/security.js', data: { label: 'requestId', kind: 'function' } },
    { id: 'file:Backend/security.js#apiLimiter', type: 'symbol', path: 'Backend/security.js', data: { label: 'apiLimiter', kind: 'constant' } },
    { id: 'file:Backend/security.js#webhookLimiter', type: 'symbol', path: 'Backend/security.js', data: { label: 'webhookLimiter', kind: 'constant' } },
    { id: 'file:Backend/security.js#securityHeaders', type: 'symbol', path: 'Backend/security.js', data: { label: 'securityHeaders', kind: 'function' } },
    { id: 'file:Backend/security.js#cors', type: 'symbol', path: 'Backend/security.js', data: { label: 'cors', kind: 'function' } },
    { id: 'file:Backend/security.js#rateLimit', type: 'symbol', path: 'Backend/security.js', data: { label: 'rateLimit', kind: 'function' } },
  ]

  const merged = mergeManifestWithGraph({ manifest, graphNodes })
  const securityFile = merged.files.find((f) => f.path === 'Backend/security.js')

  assert.ok(securityFile, 'security.js file record must exist')
  assert.equal(securityFile.symbols.length, 7, 'security.js must own exactly 7 declared symbols')

  const symbolNames = securityFile.symbols.map((s) => s.name)
  assert.ok(symbolNames.includes('crypto'))
  assert.ok(symbolNames.includes('requestId'))
  assert.ok(symbolNames.includes('apiLimiter'))
  assert.ok(symbolNames.includes('webhookLimiter'))
  assert.ok(symbolNames.includes('securityHeaders'))
  assert.ok(symbolNames.includes('cors'))
  assert.ok(symbolNames.includes('rateLimit'))

  const corsSym = securityFile.symbols.find((s) => s.name === 'cors')
  assert.equal(corsSym.kind, 'function')
  assert.equal(corsSym.path, 'Backend/security.js')
})

test('Edge Lifting: AST call edges to symbols are lifted to file endpoints and intra-file loops omitted', () => {
  const manifest = {
    repository: 'acme/repo',
    commitSha: 'c0ffee0000000000000000000000000000000000',
    files: [
      { path: 'Backend/app.js', name: 'app.js' },
      { path: 'Backend/security.js', name: 'security.js' },
    ],
  }

  const graphNodes = [
    { id: 'file:Backend/app.js', type: 'file', path: 'Backend/app.js', data: { label: 'app.js' } },
    { id: 'file:Backend/security.js', type: 'file', path: 'Backend/security.js', data: { label: 'security.js' } },
    { id: 'file:Backend/security.js#cors', type: 'symbol', path: 'Backend/security.js', data: { label: 'cors', kind: 'function' } },
    { id: 'file:Backend/security.js#rateLimit', type: 'symbol', path: 'Backend/security.js', data: { label: 'rateLimit', kind: 'function' } },
  ]

  const graphEdges = [
    // Structural contains edges
    { id: 'e_contains_1', source: 'file:Backend/security.js', target: 'file:Backend/security.js#cors', data: { edgeType: 'contains' } },
    { id: 'e_contains_2', source: 'file:Backend/security.js', target: 'file:Backend/security.js#rateLimit', data: { edgeType: 'contains' } },

    // Call edges from app.js to symbols in security.js
    { id: 'e_call_cors', source: 'file:Backend/app.js', target: 'file:Backend/security.js#cors', data: { edgeType: 'calls' } },
    { id: 'e_call_rateLimit', source: 'file:Backend/app.js', target: 'file:Backend/security.js#rateLimit', data: { edgeType: 'calls' } },

    // Intra-file call within security.js (e.g. rateLimit calling crypto)
    { id: 'e_intra', source: 'file:Backend/security.js#rateLimit', target: 'file:Backend/security.js#crypto', data: { edgeType: 'calls' } },
  ]

  const merged = mergeManifestWithGraph({ manifest, graphNodes, graphEdges })

  // 1. Structural 'contains' edges should NOT be in canvas edges
  assert.equal(merged.edges.some((e) => e.id === 'e_contains_1'), false)
  assert.equal(merged.edges.some((e) => e.id === 'e_contains_2'), false)

  // 2. Intra-file edges resolving source === target should be omitted
  assert.equal(merged.edges.some((e) => e.id === 'e_intra'), false)

  // 3. Call edges should be lifted to file endpoints
  const liftedCors = merged.edges.find((e) => e.id === 'e_call_cors')
  assert.ok(liftedCors, 'Lifted CORS call edge must exist')
  assert.equal(liftedCors.source, 'file:Backend/app.js')
  assert.equal(liftedCors.target, 'file:Backend/security.js')

  const liftedRateLimit = merged.edges.find((e) => e.id === 'e_call_rateLimit')
  assert.ok(liftedRateLimit, 'Lifted RateLimit call edge must exist')
  assert.equal(liftedRateLimit.source, 'file:Backend/app.js')
  assert.equal(liftedRateLimit.target, 'file:Backend/security.js')
})

test('Exploration: Unparsed documentation files display unparsed status and doc kind', () => {
  const manifest = {
    repository: 'acme/repo',
    commitSha: 'c0ffee0000000000000000000000000000000000',
    files: [
      { path: 'Docs/README.md', name: 'README.md', size: 2048 },
      { path: '.gitignore', name: '.gitignore', size: 128 },
    ],
  }

  const merged = mergeManifestWithGraph({ manifest, graphNodes: [] })

  const readme = merged.files.find((f) => f.path === 'Docs/README.md')
  assert.ok(readme)
  assert.equal(readme.isParsed, false)
  assert.equal(readme.status, 'unparsed')
  assert.equal(readme.kind, 'doc')
  assert.equal(readme.symbols.length, 0)
  assert.equal(readme.sizeBytes, 2048)

  const gitignore = merged.files.find((f) => f.path === '.gitignore')
  assert.ok(gitignore)
  assert.equal(gitignore.isParsed, false)
  assert.equal(gitignore.status, 'unparsed')
  assert.equal(gitignore.kind, 'config')
})
