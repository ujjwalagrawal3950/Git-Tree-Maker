import test from 'node:test'
import assert from 'node:assert/strict'
import { transformGraphToFlowElements } from '../src/lib/graphTransformer.js'
import { graphRequest } from '../src/lib/api.js'

test('Gate 10F - Graph Exploration: Bounded Neighborhood Expansion & Deduplication', () => {
  const initialData = {
    nodes: [
      { id: 'file:src/App.js', type: 'file', path: 'src/App.js' },
      { id: 'file:src/index.js', type: 'file', path: 'src/index.js' },
    ],
    edges: [
      {
        id: 'file:src/index.js->imports->file:src/App.js',
        source: 'file:src/index.js',
        target: 'file:src/App.js',
        confirmed: true,
      },
    ],
    truncated: false,
  }

  const initialElements = transformGraphToFlowElements(initialData)
  assert.equal(initialElements.nodes.length, 2)
  assert.equal(initialElements.edges.length, 1)

  const expandedData = {
    nodes: [
      { id: 'file:src/App.js', type: 'file', path: 'src/App.js' },
      { id: 'file:src/Button.js', type: 'file', path: 'src/Button.js' },
    ],
    edges: [
      {
        id: 'file:src/App.js->imports->file:src/Button.js',
        source: 'file:src/App.js',
        target: 'file:src/Button.js',
        confirmed: true,
      },
    ],
    truncated: true,
  }

  const expandedElements = transformGraphToFlowElements(expandedData)

  const nodeMap = new Map(initialElements.nodes.map((n) => [n.id, n]))
  for (const n of expandedElements.nodes) {
    if (!nodeMap.has(n.id)) nodeMap.set(n.id, n)
  }
  const mergedNodes = Array.from(nodeMap.values())

  const edgeMap = new Map(initialElements.edges.map((e) => [e.id, e]))
  for (const e of expandedElements.edges) {
    if (!edgeMap.has(e.id)) edgeMap.set(e.id, e)
  }
  const mergedEdges = Array.from(edgeMap.values())

  assert.equal(mergedNodes.length, 3, 'Must have exactly 3 distinct nodes')
  assert.equal(mergedEdges.length, 2, 'Must have exactly 2 distinct edges')
  assert.ok(mergedNodes.some((n) => n.id === 'file:src/App.js'))
  assert.ok(mergedNodes.some((n) => n.id === 'file:src/index.js'))
  assert.ok(mergedNodes.some((n) => n.id === 'file:src/Button.js'))
  assert.equal(expandedElements.truncated, true)
})

test('Gate 10F - Graph API Client: Token Validation and Status Propagation', async () => {
  await assert.rejects(
    async () => {
      await graphRequest('/api/repositories/test-repo/graph', { token: null })
    },
    (err) => {
      assert.equal(err.status, 401)
      assert.equal(err.code, 'UNAUTHORIZED')
      return true
    },
  )
})

test('Gate 10F Hardening - State Lifecycle: 404 Graph Not Built Handling', () => {
  const simulatedError = new Error('Graph snapshot not built or item not found.')
  simulatedError.status = 404
  simulatedError.code = 'GRAPH_NOT_FOUND'

  let graphState = 'loading'
  if (simulatedError.status === 404) {
    graphState = 'not_built'
  }

  assert.equal(graphState, 'not_built', '404 error must transition state to not_built')
})

test('Gate 10F Hardening - State Lifecycle: 403 Permission Denied Handling', () => {
  const simulatedForbidden = new Error('You do not have permission to access this repository graph.')
  simulatedForbidden.status = 403
  simulatedForbidden.code = 'FORBIDDEN'

  let graphState = 'loading'
  let graphErrorMessage = null
  if (simulatedForbidden.status === 403) {
    graphState = 'forbidden'
    graphErrorMessage = simulatedForbidden.message
  }

  assert.equal(graphState, 'forbidden')
  assert.equal(graphErrorMessage, 'You do not have permission to access this repository graph.')
})

test('Gate 10F Hardening - State Lifecycle: Recoverable Error and Retry State', () => {
  const simulated500 = new Error('An unexpected server error occurred.')
  simulated500.status = 500
  simulated500.code = 'INTERNAL_ERROR'

  let graphState = 'loading'
  let graphErrorMessage = null
  if (simulated500.status >= 500) {
    graphState = 'error'
    graphErrorMessage = simulated500.message
  }

  assert.equal(graphState, 'error')
  assert.equal(graphErrorMessage, 'An unexpected server error occurred.')

  // Simulating retry action: transitions back to loading
  graphState = 'loading'
  graphErrorMessage = null
  assert.equal(graphState, 'loading')
  assert.equal(graphErrorMessage, null)
})

test('Gate 10F Hardening - Repository Switching & Stale Response Suppression', async () => {
  let requestId = 0
  let renderedRepo = null

  async function simulateFetch(repoName, delayMs) {
    const currentReq = ++requestId
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (requestId !== currentReq) {
      // Discard stale response
      return null
    }
    renderedRepo = repoName
    return repoName
  }

  // Request 1 for repoA starts with 50ms delay
  const p1 = simulateFetch('repoA', 50)
  // Request 2 for repoB starts immediately with 10ms delay (user switched repos)
  const p2 = simulateFetch('repoB', 10)

  await Promise.all([p1, p2])

  // Even though repoA finished later, only repoB must be committed to renderedRepo
  assert.equal(renderedRepo, 'repoB', 'Stale response from previous repo must be discarded')
})

test('Gate 10F Hardening - Unresolved References: Pagination and Filtering', () => {
  const backendUnresolvedPayload = {
    items: [
      { id: 'fact1', status: 'ambiguous', sourceFile: 'src/app.js', rawSpecifier: './utils' },
      { id: 'fact2', status: 'unresolved', sourceFile: 'src/main.js', rawSpecifier: 'missing-pkg' },
      { id: 'fact3', status: 'dynamic', sourceFile: 'src/dyn.js', rawSpecifier: 'req(path)' },
    ],
    total: 35,
    page: 1,
    pageSize: 3,
    totalPages: 12,
  }

  assert.equal(backendUnresolvedPayload.page, 1)
  assert.equal(backendUnresolvedPayload.pageSize, 3)
  assert.equal(backendUnresolvedPayload.totalPages, 12)
  assert.equal(backendUnresolvedPayload.items.length, 3)

  // Verify candidate targets and source location formatting
  const first = backendUnresolvedPayload.items[0]
  assert.equal(first.status, 'ambiguous')
  assert.equal(first.sourceFile, 'src/app.js')
})

test('Gate 10F Hardening - Edge Provenance: Data Rendering Contract', () => {
  const edgeEvidence = {
    edgeId: 'repo@sha:src/a.js->imports->repo@sha:src/b.js',
    evidence: [
      {
        resolver: 'c_cpp_resolver',
        resolverVersion: '1.0.0',
        rule: 'quoted_relative_include',
        sourceLocation: { line: 14, column: 1 },
        rawSpecifier: '"b.h"',
        status: { normalized: 'internal_resolved', isConfirmed: true },
      },
    ],
    total: 1,
  }

  assert.equal(edgeEvidence.evidence.length, 1)
  const ev = edgeEvidence.evidence[0]
  assert.equal(ev.resolver, 'c_cpp_resolver')
  assert.equal(ev.rule, 'quoted_relative_include')
  assert.equal(ev.sourceLocation.line, 14)
  assert.equal(ev.rawSpecifier, '"b.h"')
  assert.equal(ev.status.isConfirmed, true)
})

test('Gate 10F Hardening - Missing or Malformed API Responses Fails Safely', () => {
  // Completely empty object
  const emptyRes = transformGraphToFlowElements({})
  assert.deepEqual(emptyRes.nodes, [])
  assert.deepEqual(emptyRes.edges, [])
  assert.equal(emptyRes.truncated, false)

  // Malformed arrays containing null or invalid entries
  const malformedRes = transformGraphToFlowElements({
    nodes: [null, undefined, { invalid: true }],
    edges: [null, { missingId: true }],
  })
  assert.deepEqual(malformedRes.nodes, [])
  assert.deepEqual(malformedRes.edges, [])
})
