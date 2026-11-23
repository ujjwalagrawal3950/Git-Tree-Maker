import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTopologyMaps,
  identifyEntryPoints,
  identifyHubs,
  calculateImpactRadius,
} from '../src/lib/architecturalIntelligence.js'
import { mergeManifestWithGraph } from '../src/lib/repositoryGraph.js'

function createMonorepoWithComplexGraph() {
  const manifest = {
    repository: 'cartograph/intel-repo',
    commitSha: 'beef000000000000000000000000000000000000',
    files: [
      { path: 'package.json', name: 'package.json' },
      { path: 'src/main.js', name: 'main.js' },
      { path: 'src/config/env.js', name: 'env.js' },
      { path: 'src/config/DbConnect.js', name: 'DbConnect.js' },
      { path: 'src/services/UserService.js', name: 'UserService.js' },
      { path: 'src/services/AuthService.js', name: 'AuthService.js' },
      { path: 'src/controllers/UserController.js', name: 'UserController.js' },
      { path: 'src/lib/logger.js', name: 'logger.js' },
      { path: 'src/lib/errors.js', name: 'errors.js' },
      // Cycle test files
      { path: 'src/cycles/alpha.js', name: 'alpha.js' },
      { path: 'src/cycles/beta.js', name: 'beta.js' },
      // Next.js verified entry
      { path: 'app/page.jsx', name: 'page.jsx', kind: 'entry' },
    ],
  }

  const graphNodes = manifest.files.map((f) => ({
    id: `file:${f.path}`,
    type: 'file',
    path: f.path,
    data: { label: f.name, kind: f.kind || 'source', status: 'parsed' },
  }))

  const graphEdges = [
    // logger is a core library (imported by env, DbConnect, UserService, AuthService, UserController)
    { id: 'e1', source: 'file:src/config/env.js', target: 'file:src/lib/logger.js' },
    { id: 'e2', source: 'file:src/config/DbConnect.js', target: 'file:src/lib/logger.js' },
    { id: 'e3', source: 'file:src/services/UserService.js', target: 'file:src/lib/logger.js' },
    { id: 'e4', source: 'file:src/services/AuthService.js', target: 'file:src/lib/logger.js' },
    { id: 'e5', source: 'file:src/controllers/UserController.js', target: 'file:src/lib/logger.js' },

    // env is imported by DbConnect, UserService, AuthService
    { id: 'e6', source: 'file:src/config/DbConnect.js', target: 'file:src/config/env.js' },
    { id: 'e7', source: 'file:src/services/UserService.js', target: 'file:src/config/env.js' },
    { id: 'e8', source: 'file:src/services/AuthService.js', target: 'file:src/config/env.js' },

    // DbConnect is imported by UserService, AuthService
    { id: 'e9', source: 'file:src/services/UserService.js', target: 'file:src/config/DbConnect.js' },
    { id: 'e10', source: 'file:src/services/AuthService.js', target: 'file:src/config/DbConnect.js' },

    // UserService is a coordinator: imported by UserController and main.js, and imports logger, env, DbConnect, errors
    { id: 'e11', source: 'file:src/controllers/UserController.js', target: 'file:src/services/UserService.js' },
    { id: 'e12', source: 'file:src/main.js', target: 'file:src/services/UserService.js' },
    { id: 'e13', source: 'file:src/services/UserService.js', target: 'file:src/lib/errors.js' },

    // main.js imports UserController and AuthService
    { id: 'e14', source: 'file:src/main.js', target: 'file:src/controllers/UserController.js' },
    { id: 'e15', source: 'file:src/main.js', target: 'file:src/services/AuthService.js' },

    // Cyclic edges between alpha and beta
    { id: 'e16', source: 'file:src/cycles/alpha.js', target: 'file:src/cycles/beta.js' },
    { id: 'e17', source: 'file:src/cycles/beta.js', target: 'file:src/cycles/alpha.js' },
  ]

  return mergeManifestWithGraph({ manifest, graphNodes, graphEdges })
}

test('Phase 3 Intelligence: Entry points strictly separate verified entries from candidates', () => {
  const repo = createMonorepoWithComplexGraph()
  const { verified, candidates } = identifyEntryPoints(repo)

  // 1. Verified entry: app/page.jsx (kind === 'entry')
  assert.equal(verified.length, 1)
  assert.equal(verified[0].path, 'app/page.jsx')
  assert.equal(verified[0].type, 'verified')
  assert.ok(verified[0].reason.includes('configuration') || verified[0].reason.includes('entry point'))

  // 2. Candidate entry: src/main.js (name pattern 'main.js')
  const mainCandidate = candidates.find((c) => c.path === 'src/main.js')
  assert.ok(mainCandidate, 'main.js must be recognized as a candidate')
  assert.equal(mainCandidate.type, 'candidate')
  assert.ok(mainCandidate.reason.includes('entry convention'))
  assert.equal(mainCandidate.inDegree, 0, 'main.js has zero incoming dependencies')
  assert.equal(mainCandidate.outDegree, 3, 'main.js imports 3 files')

  // Random library files (e.g. logger.js, DbConnect.js) MUST NOT be marked entry points
  assert.equal(
    verified.some((v) => v.name === 'logger.js') || candidates.some((c) => c.name === 'logger.js'),
    false,
    'logger.js must not be an entry point',
  )
})

test('Phase 3 Intelligence: Hub rankings compute relative centrality and distinguish core libraries from coordinators', () => {
  const repo = createMonorepoWithComplexGraph()
  const hubs = identifyHubs(repo)

  assert.ok(hubs.length > 0, 'Hubs must be detected')

  // Top hub must be logger.js (inDegree = 5)
  const topHub = hubs[0]
  assert.equal(topHub.name, 'logger.js')
  assert.equal(topHub.inDegree, 5)
  assert.equal(topHub.outDegree, 0)
  assert.equal(topHub.role, 'core_library')

  // UserService is a coordinator (high in-degree and high out-degree)
  const userServiceHub = hubs.find((h) => h.name === 'UserService.js')
  assert.ok(userServiceHub, 'UserService.js must be recognized as a hub')
  assert.equal(userServiceHub.inDegree, 2)
  assert.ok(userServiceHub.outDegree >= 3)
  assert.equal(userServiceHub.role, 'coordinator')

  // Ranks must be assigned sequentially
  assert.equal(hubs[0].rank, 1)
  assert.ok(hubs[0].percentile > 0)
})

test('Phase 3 Intelligence: Impact radius follows reverse dependencies with depth levels and cycle detection', () => {
  const repo = createMonorepoWithComplexGraph()
  const loggerId = 'file:src/lib/logger.js'

  // Logger is imported by env, DbConnect, UserService, AuthService, UserController
  // Those files in turn are imported by main.js
  const impact = calculateImpactRadius(loggerId, repo)

  assert.equal(impact.targetFileId, loggerId)
  assert.ok(impact.totalAffectedCount >= 6, 'Logger impact must reach at least 6 files')
  assert.ok(impact.blastRadiusPercentage >= 50, 'Modifying logger impacts >= 50% of the codebase')

  // Level 1: direct importers (env, DbConnect, UserService, AuthService, UserController)
  assert.equal(impact.directDependentsCount, 5)
  const level1Paths = impact.directDependents.map((f) => f.path).sort()
  assert.deepEqual(level1Paths, [
    'src/config/DbConnect.js',
    'src/config/env.js',
    'src/controllers/UserController.js',
    'src/services/AuthService.js',
    'src/services/UserService.js',
  ])

  // Level 2: transitive dependents (main.js)
  const level2 = impact.levels.find((l) => l.depth === 2)
  assert.ok(level2, 'Level 2 transitive callers must exist')
  assert.ok(level2.files.some((f) => f.path === 'src/main.js'))

  // Truncation was not triggered under small graph
  assert.equal(impact.truncated, false)
})

test('Phase 3 Intelligence: Impact radius handles cyclic dependencies and bounds traversal', () => {
  const repo = createMonorepoWithComplexGraph()
  const alphaId = 'file:src/cycles/alpha.js'

  // alpha -> beta -> alpha
  const cycleImpact = calculateImpactRadius(alphaId, repo)
  assert.equal(cycleImpact.cyclesDetected, true, 'Cycle between alpha and beta must be detected')
  assert.equal(cycleImpact.totalAffectedCount, 1, 'Only beta is affected (excluding alpha itself)')

  // Test bounded traversal
  const boundedImpact = calculateImpactRadius('file:src/lib/logger.js', repo, null, {
    maxDepth: 1,
    maxNodes: 2,
  })
  assert.equal(boundedImpact.truncated, true, 'Max nodes bound must trigger truncated flag')
  assert.equal(boundedImpact.maxDepthReached, 1)
})
