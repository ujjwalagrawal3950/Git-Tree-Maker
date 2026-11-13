import test from 'node:test'
import assert from 'node:assert/strict'
import {
  transformNode,
  transformEdge,
  transformGraphToFlowElements,
  applyGraphSelectionTones,
  isEdgeConfirmed,
  NODE_TYPES,
} from '../src/lib/graphTransformer.js'

test('Gate 10F Hardening - Edge Confirmation: Authoritative True vs Explicit False', () => {
  // Explicit true
  const edgeTrue = {
    id: 'e_true',
    source: 'node:A',
    target: 'node:B',
    type: 'imports',
    confirmed: true,
  }
  assert.equal(isEdgeConfirmed(edgeTrue), true)
  assert.notEqual(transformEdge(edgeTrue), null)

  // Explicit false
  const edgeFalse = {
    id: 'e_false',
    source: 'node:A',
    target: 'node:B',
    type: 'imports',
    confirmed: false,
  }
  assert.equal(isEdgeConfirmed(edgeFalse), false)
  assert.equal(transformEdge(edgeFalse), null)

  // isConfirmed: false
  const edgeIsConfirmedFalse = {
    id: 'e_is_false',
    source: 'node:A',
    target: 'node:B',
    type: 'imports',
    isConfirmed: false,
  }
  assert.equal(isEdgeConfirmed(edgeIsConfirmedFalse), false)
  assert.equal(transformEdge(edgeIsConfirmedFalse), null)
})

test('Gate 10F Hardening - Edge Confirmation: Missing Metadata Fails Closed', () => {
  // Completely missing confirmation property and missing evidence
  const edgeMissing = {
    id: 'e_missing',
    source: 'node:A',
    target: 'node:B',
    type: 'imports',
  }
  assert.equal(isEdgeConfirmed(edgeMissing), false, 'Missing confirmation must fail closed')
  assert.equal(transformEdge(edgeMissing), null, 'Must not convert unconfirmed record to flow edge')

  // Empty object or null edge
  assert.equal(isEdgeConfirmed(null), false)
  assert.equal(isEdgeConfirmed({}), false)
})

test('Gate 10F Hardening - Edge Confirmation: Ambiguous, Dynamic, Unsupported, Unresolved Rejected', () => {
  // Ambiguous confirmation string or status
  const edgeAmbiguousVal = {
    id: 'e_ambig_val',
    source: 'node:A',
    target: 'node:B',
    confirmed: 'ambiguous',
  }
  assert.equal(isEdgeConfirmed(edgeAmbiguousVal), false)
  assert.equal(transformEdge(edgeAmbiguousVal), null)

  const edgeAmbiguousStatus = {
    id: 'e_ambig_stat',
    source: 'node:A',
    target: 'node:B',
    status: 'ambiguous',
  }
  assert.equal(isEdgeConfirmed(edgeAmbiguousStatus), false)
  assert.equal(transformEdge(edgeAmbiguousStatus), null)

  // Dynamic status
  const edgeDynamic = {
    id: 'e_dyn',
    source: 'node:A',
    target: 'node:B',
    status: 'dynamic',
    confirmed: true, // Status overrides flag
  }
  assert.equal(isEdgeConfirmed(edgeDynamic), false)
  assert.equal(transformEdge(edgeDynamic), null)

  // Unsupported status
  const edgeUnsupported = {
    id: 'e_unsup',
    source: 'node:A',
    target: 'node:B',
    status: 'unsupported',
  }
  assert.equal(isEdgeConfirmed(edgeUnsupported), false)
  assert.equal(transformEdge(edgeUnsupported), null)

  // Unresolved status
  const edgeUnresolved = {
    id: 'e_unres',
    source: 'node:A',
    target: 'node:B',
    status: 'unresolved',
  }
  assert.equal(isEdgeConfirmed(edgeUnresolved), false)
  assert.equal(transformEdge(edgeUnresolved), null)
})

test('Gate 10F Hardening - Edge Confirmation: Evidence Array Verification', () => {
  // Confirmed evidence array
  const edgeWithConfirmedEvidence = {
    id: 'e_ev_ok',
    source: 'node:A',
    target: 'node:B',
    type: 'imports',
    evidence: [
      {
        resolver: { name: 'c_cpp_resolver' },
        status: { normalized: 'internal_resolved', isConfirmed: true },
      },
    ],
  }
  assert.equal(isEdgeConfirmed(edgeWithConfirmedEvidence), true)
  assert.notEqual(transformEdge(edgeWithConfirmedEvidence), null)

  // Evidence array with ambiguous status
  const edgeWithAmbiguousEvidence = {
    id: 'e_ev_ambig',
    source: 'node:A',
    target: 'node:B',
    type: 'imports',
    evidence: [
      {
        resolver: { name: 'c_cpp_resolver' },
        status: { normalized: 'ambiguous', isConfirmed: false },
      },
    ],
  }
  assert.equal(isEdgeConfirmed(edgeWithAmbiguousEvidence), false)
  assert.equal(transformEdge(edgeWithAmbiguousEvidence), null)

  // Mixed evidence containing unconfirmed/unsupported record
  const edgeWithMixedEvidence = {
    id: 'e_ev_mixed',
    source: 'node:A',
    target: 'node:B',
    type: 'imports',
    evidence: [
      { status: { normalized: 'internal_resolved', isConfirmed: true } },
      { status: { normalized: 'ambiguous', isConfirmed: false } },
    ],
  }
  assert.equal(isEdgeConfirmed(edgeWithMixedEvidence), false, 'Evidence containing ambiguous fact must be rejected')
  assert.equal(transformEdge(edgeWithMixedEvidence), null)
})

test('Gate 10F - Graph Transformer: Node Mapping & Canonical ID Preservation', () => {
  const backendFileNode = {
    id: 'repo@abcdef1234567890abcdef1234567890abcdef12:src/index.js',
    type: 'file',
    path: 'src/index.js',
    language: 'javascript',
  }

  const flowNode = transformNode(backendFileNode)

  // Canonical ID must be preserved byte-for-byte
  assert.equal(flowNode.id, backendFileNode.id)
  assert.equal(flowNode.type, NODE_TYPES.FILE)
  assert.equal(flowNode.data.canonicalId, backendFileNode.id)
  assert.equal(flowNode.data.path, 'src/index.js')
  assert.equal(flowNode.data.language, 'javascript')
  assert.equal(flowNode.data.label, 'index.js')
})

test('Gate 10F - Graph Transformer: Symbol and External Node Types', () => {
  const backendSymbolNode = {
    id: 'repo@sha:src/math.js#calculateSum',
    type: 'symbol',
    name: 'calculateSum',
    qualifiedName: 'src/math.js#calculateSum',
    kind: 'function',
    language: 'javascript',
  }

  const flowSymbol = transformNode(backendSymbolNode)
  assert.equal(flowSymbol.id, backendSymbolNode.id)
  assert.equal(flowSymbol.type, NODE_TYPES.SYMBOL)
  assert.equal(flowSymbol.data.name, 'calculateSum')
  assert.equal(flowSymbol.data.kind, 'function')

  const backendExternalNode = {
    id: 'external:npm:express',
    type: 'external',
    ecosystem: 'npm',
    packageName: 'express',
    versionRequirement: '^4.18.2',
  }

  const flowExternal = transformNode(backendExternalNode)
  assert.equal(flowExternal.id, backendExternalNode.id)
  assert.equal(flowExternal.type, NODE_TYPES.EXTERNAL)
  assert.equal(flowExternal.data.packageName, 'express')
  assert.equal(flowExternal.data.ecosystem, 'npm')
})

test('Gate 10F - Graph Transformer: Edge Mapping, Direction & Confirmation', () => {
  const confirmedEdge = {
    id: 'repo@sha:src/app.js->imports->repo@sha:src/utils.js',
    type: 'imports',
    source: 'repo@sha:src/app.js',
    target: 'repo@sha:src/utils.js',
    confirmed: true,
    evidenceCount: 2,
  }

  const flowEdge = transformEdge(confirmedEdge)

  assert.equal(flowEdge.id, confirmedEdge.id)
  assert.equal(flowEdge.source, confirmedEdge.source)
  assert.equal(flowEdge.target, confirmedEdge.target)
  assert.equal(flowEdge.data.edgeType, 'imports')
  assert.equal(flowEdge.data.evidenceCount, 2)
  assert.equal(flowEdge.data.confirmed, true)
})

test('Gate 10F - Graph Transformer: Deduplication & No Invented Elements', () => {
  const backendData = {
    nodes: [
      { id: 'node:A', type: 'file', path: 'src/A.js' },
      { id: 'node:A', type: 'file', path: 'src/A.js' },
      { id: 'node:B', type: 'file', path: 'src/B.js' },
    ],
    edges: [
      { id: 'edge:A->B', type: 'imports', source: 'node:A', target: 'node:B', confirmed: true },
      { id: 'edge:A->B', type: 'imports', source: 'node:A', target: 'node:B', confirmed: true },
      { id: 'edge:A->C', type: 'imports', source: 'node:A', target: 'node:C', confirmed: false },
    ],
    truncated: true,
  }

  const result = transformGraphToFlowElements(backendData)

  assert.equal(result.nodes.length, 2)
  assert.equal(result.nodes[0].id, 'node:A')
  assert.equal(result.nodes[1].id, 'node:B')

  assert.equal(result.edges.length, 1)
  assert.equal(result.edges[0].id, 'edge:A->B')
  assert.equal(result.truncated, true)
})

test('Gate 10F - Graph Transformer: Selection Tones', () => {
  const edges = [
    { id: 'e1', source: 'node:A', target: 'node:B' },
    { id: 'e2', source: 'node:B', target: 'node:C' },
    { id: 'e3', source: 'node:X', target: 'node:Y' },
  ]

  const tones = applyGraphSelectionTones(edges, 'node:B', null)
  assert.equal(tones[0].tone, 'incoming')
  assert.equal(tones[1].tone, 'outgoing')
  assert.equal(tones[2].tone, 'dim')

  const edgeTones = applyGraphSelectionTones(edges, null, 'e2')
  assert.equal(edgeTones[0].tone, 'dim')
  assert.equal(edgeTones[1].tone, 'outgoing')
  assert.equal(edgeTones[1].selected, true)
  assert.equal(edgeTones[2].tone, 'dim')
})
