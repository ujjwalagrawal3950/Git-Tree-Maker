import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTopologyMaps,
  identifyEntryPoints,
  identifyHubs,
  calculateImpactRadius,
} from '../src/lib/architecturalIntelligence.js'

test('Verification 1: Entry points require explicit authoritative framework/config evidence', () => {
  const repo = {
    repository: 'test/entry-points',
    files: [
      // 1. Authoritative Next.js / framework entry with explicit evidence
      {
        id: 'file:app/page.jsx',
        path: 'app/page.jsx',
        name: 'page.jsx',
        kind: 'entry',
        isParsed: true,
        entryPointEvidence: 'Next.js App Router root page route',
      },
      // 2. Authoritative package.json main entry with explicit evidence
      {
        id: 'file:src/index.js',
        path: 'src/index.js',
        name: 'index.js',
        isEntryPoint: true,
        entryPointEvidence: 'package.json "main" target',
      },
      // 3. Ordinary filename matching naming pattern (MUST ONLY BE CANDIDATE)
      {
        id: 'file:src/app.js',
        path: 'src/app.js',
        name: 'app.js',
        kind: 'source',
      },
      // 4. Ordinary file in manifest with zero in-degree and outgoing calls (MUST ONLY BE CANDIDATE)
      {
        id: 'file:src/runner.js',
        path: 'src/runner.js',
        name: 'runner.js',
        kind: 'source',
      },
      // 5. Normal internal library (NEITHER)
      {
        id: 'file:src/utils.js',
        path: 'src/utils.js',
        name: 'utils.js',
        kind: 'source',
      },
    ],
    edges: [
      { source: 'file:src/runner.js', target: 'file:src/utils.js' },
      { source: 'file:src/runner.js', target: 'file:src/app.js' },
      { source: 'file:src/app.js', target: 'file:src/utils.js' },
    ],
  }

  const { verified, candidates } = identifyEntryPoints(repo)

  // Explicit evidence files must be verified
  const verifiedPaths = verified.map((v) => v.path)
  assert.ok(verifiedPaths.includes('app/page.jsx'), 'Authoritative page.jsx must be verified')
  assert.ok(verifiedPaths.includes('src/index.js'), 'Explicit isEntryPoint index.js must be verified')
  assert.equal(verified.length, 2)

  // Ordinary filenames must ONLY produce candidates
  const candidatePaths = candidates.map((c) => c.path)
  assert.ok(candidatePaths.includes('src/app.js'), 'app.js must be candidate, not verified')
  assert.ok(candidatePaths.includes('src/runner.js'), 'zero-indegree runner.js must be candidate, not verified')
  assert.equal(verified.some((v) => v.path === 'src/app.js'), false, 'app.js must not be in verified')
  assert.equal(verified.some((v) => v.path === 'src/runner.js'), false, 'runner.js must not be in verified')
  assert.equal(candidates.some((c) => c.path === 'src/utils.js'), false, 'utils.js must not be an entry point')
})

test('Verification 2: Hub detection guards small repositories from false hub claims', () => {
  // Small 3-file linear chain: A -> B -> C
  const smallRepo = {
    repository: 'test/small-chain',
    files: [
      { id: 'f:a', path: 'a.js', name: 'a.js' },
      { id: 'f:b', path: 'b.js', name: 'b.js' },
      { id: 'f:c', path: 'c.js', name: 'c.js' },
    ],
    edges: [
      { source: 'f:a', target: 'f:b' },
      { source: 'f:b', target: 'f:c' },
    ],
  }

  const hubs = identifyHubs(smallRepo)
  // Max in-degree is 1, so no hubs are emitted
  assert.equal(hubs.length, 0, 'Linear chain with max in-degree 1 must emit 0 hubs')

  // Repo with genuine central convergence (5 files all importing core.js)
  const repoWithHub = {
    repository: 'test/with-hub',
    files: [
      { id: 'f:core', path: 'core.js', name: 'core.js' },
      { id: 'f:u1', path: 'u1.js', name: 'u1.js' },
      { id: 'f:u2', path: 'u2.js', name: 'u2.js' },
      { id: 'f:u3', path: 'u3.js', name: 'u3.js' },
      { id: 'f:u4', path: 'u4.js', name: 'u4.js' },
      { id: 'f:u5', path: 'u5.js', name: 'u5.js' },
    ],
    edges: [
      { source: 'f:u1', target: 'f:core' },
      { source: 'f:u2', target: 'f:core' },
      { source: 'f:u3', target: 'f:core' },
      { source: 'f:u4', target: 'f:core' },
      { source: 'f:u5', target: 'f:core' },
    ],
  }

  const centralHubs = identifyHubs(repoWithHub)
  assert.equal(centralHubs.length, 1)
  assert.equal(centralHubs[0].name, 'core.js')
  assert.equal(centralHubs[0].inDegree, 5)
  assert.equal(centralHubs[0].role, 'core_library')
})

test('Verification 3: Impact radius handles multi-path, cycles, and self-dependencies correctly', () => {
  // Diamond graph:
  // D is imported by B and C
  // B and C are imported by A
  // A has a self-edge A -> A
  // Cycle between B and E: B -> E -> B
  const repo = {
    repository: 'test/diamond-cycles',
    files: [
      { id: 'f:D', path: 'D.js', name: 'D.js' },
      { id: 'f:B', path: 'B.js', name: 'B.js' },
      { id: 'f:C', path: 'C.js', name: 'C.js' },
      { id: 'f:A', path: 'A.js', name: 'A.js' },
      { id: 'f:E', path: 'E.js', name: 'E.js' },
    ],
    edges: [
      { source: 'f:B', target: 'f:D' },
      { source: 'f:C', target: 'f:D' },
      { source: 'f:A', target: 'f:B' },
      { source: 'f:A', target: 'f:C' },
      { source: 'f:A', target: 'f:A' }, // self-dependency
      { source: 'f:E', target: 'f:B' }, // cycle B <-> E
      { source: 'f:B', target: 'f:E' },
    ],
  }

  const impact = calculateImpactRadius('f:D', repo)

  // Modifying D should reach B and C (Level 1), and then A and E (Level 2)
  assert.equal(impact.directDependentsCount, 2)
  const l1Ids = impact.directDependents.map((f) => f.id).sort()
  assert.deepEqual(l1Ids, ['f:B', 'f:C'])

  // A must be visited once and only once despite being reachable via both B and C
  assert.equal(impact.totalAffectedCount, 4, 'B, C, A, E must all be reached exactly once')
  assert.equal(impact.cyclesDetected, true, 'Cycle between B and E must be detected')
  assert.equal(impact.truncated, false, 'Complete traversal was not truncated')
})

test('Verification 4: Incomplete/truncated traversal explicitly reports lower-bound guarantees', () => {
  // Chain of 5 callers: D <- C <- B <- A <- root
  const chainRepo = {
    repository: 'test/long-chain',
    files: [
      { id: 'f:D', path: 'D.js', name: 'D.js' },
      { id: 'f:C', path: 'C.js', name: 'C.js' },
      { id: 'f:B', path: 'B.js', name: 'B.js' },
      { id: 'f:A', path: 'A.js', name: 'A.js' },
      { id: 'f:root', path: 'root.js', name: 'root.js' },
    ],
    edges: [
      { source: 'f:C', target: 'f:D' },
      { source: 'f:B', target: 'f:C' },
      { source: 'f:A', target: 'f:B' },
      { source: 'f:root', target: 'f:A' },
    ],
  }

  // 1. Truncation by depth limit (maxDepth = 2)
  const depthBounded = calculateImpactRadius('f:D', chainRepo, null, { maxDepth: 2, maxNodes: 100 })
  assert.equal(depthBounded.truncated, true, 'Must report truncated when callers exist beyond maxDepth')
  assert.equal(depthBounded.truncationReason, 'max_depth_exceeded')
  assert.equal(depthBounded.isLowerBound, true)
  assert.equal(depthBounded.maxDepthReached, 2)
  assert.equal(depthBounded.totalAffectedCount, 2, 'Depth 2 only reached C and B')

  // 2. Truncation by node limit (maxNodes = 2)
  const nodeBounded = calculateImpactRadius('f:D', chainRepo, null, { maxDepth: 10, maxNodes: 2 })
  assert.equal(nodeBounded.truncated, true, 'Must report truncated when node limit reached')
  assert.equal(nodeBounded.truncationReason, 'max_nodes_exceeded')
  assert.equal(nodeBounded.isLowerBound, true)
})
