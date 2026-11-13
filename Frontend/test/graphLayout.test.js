import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutGraphElements, getNodeDimensions } from '../src/lib/graphLayout.js'

test('Gate 10F - Graph Layout: Determinism Across Repeated Invocations', () => {
  const nodes = [
    { id: 'node:A', type: 'file' },
    { id: 'node:B', type: 'symbol' },
    { id: 'node:C', type: 'external' },
    { id: 'node:D', type: 'file' },
  ]

  const edges = [
    { id: 'e1', source: 'node:A', target: 'node:B' },
    { id: 'e2', source: 'node:B', target: 'node:C' },
    { id: 'e3', source: 'node:A', target: 'node:D' },
  ]

  // Run 1
  const run1 = layoutGraphElements(nodes, edges, { direction: 'LR' })

  // Run 2 with reversed input array order to test stability
  const reversedNodes = [...nodes].reverse()
  const reversedEdges = [...edges].reverse()
  const run2 = layoutGraphElements(reversedNodes, reversedEdges, { direction: 'LR' })

  assert.equal(run1.length, 4)
  assert.equal(run2.length, 4)

  const map1 = new Map(run1.map((n) => [n.id, n.position]))
  const map2 = new Map(run2.map((n) => [n.id, n.position]))

  for (const id of ['node:A', 'node:B', 'node:C', 'node:D']) {
    const pos1 = map1.get(id)
    const pos2 = map2.get(id)
    assert.deepEqual(pos1, pos2, `Node ${id} position must be strictly deterministic`)
  }
})

test('Gate 10F - Graph Layout: Direction & Geometry Verification', () => {
  const nodes = [
    { id: 'node:Source', type: 'file' },
    { id: 'node:Target', type: 'file' },
  ]

  const edges = [{ id: 'e1', source: 'node:Source', target: 'node:Target' }]

  const laidOut = layoutGraphElements(nodes, edges, { direction: 'LR' })
  const sourceNode = laidOut.find((n) => n.id === 'node:Source')
  const targetNode = laidOut.find((n) => n.id === 'node:Target')

  // In LR layout, source should be to the left of target (source.x < target.x)
  assert.ok(
    sourceNode.position.x < targetNode.position.x,
    `Source node (${sourceNode.position.x}) must precede target node (${targetNode.position.x}) in LR layout`,
  )
})

test('Gate 10F - Graph Layout: Non-overlapping Nodes in Fixture', () => {
  const nodes = [
    { id: 'node:1', type: 'file' },
    { id: 'node:2', type: 'file' },
    { id: 'node:3', type: 'file' },
    { id: 'node:4', type: 'file' },
  ]

  const edges = [
    { id: 'e1', source: 'node:1', target: 'node:2' },
    { id: 'e2', source: 'node:1', target: 'node:3' },
    { id: 'e3', source: 'node:2', target: 'node:4' },
    { id: 'e4', source: 'node:3', target: 'node:4' },
  ]

  const positioned = layoutGraphElements(nodes, edges, { direction: 'LR' })

  // Check pairwise bounding box intersection
  for (let i = 0; i < positioned.length; i++) {
    for (let j = i + 1; j < positioned.length; j++) {
      const a = positioned[i]
      const b = positioned[j]
      const dimA = getNodeDimensions(a.type)
      const dimB = getNodeDimensions(b.type)

      const aLeft = a.position.x
      const aRight = a.position.x + dimA.width
      const aTop = a.position.y
      const aBottom = a.position.y + dimA.height

      const bLeft = b.position.x
      const bRight = b.position.x + dimB.width
      const bTop = b.position.y
      const bBottom = b.position.y + dimB.height

      const overlaps =
        aLeft < bRight && aRight > bLeft && aTop < bBottom && aBottom > bTop

      assert.ok(
        !overlaps,
        `Nodes ${a.id} and ${b.id} must not overlap in Dagre layout`,
      )
    }
  }
})

test('Gate 10F - Graph Layout: Empty and Disconnected Nodes', () => {
  const empty = layoutGraphElements([], [])
  assert.deepEqual(empty, [])

  const disconnected = [
    { id: 'solo:1', type: 'file' },
    { id: 'solo:2', type: 'symbol' },
  ]
  const result = layoutGraphElements(disconnected, [])
  assert.equal(result.length, 2)
  assert.ok(typeof result[0].position.x === 'number')
  assert.ok(typeof result[1].position.x === 'number')
})

