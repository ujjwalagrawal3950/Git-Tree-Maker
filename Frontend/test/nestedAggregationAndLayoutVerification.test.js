import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveDirectoryHierarchy,
  getLayout,
} from '../src/lib/repositoryGraph.js'
import { buildElements } from '../src/components/map/buildElements.js'

// ============================================================================
// 1. Deeply Nested Folder Aggregation Verification
// ============================================================================

test('Folder Aggregation: Deeply nested directory structure calculates exact non-duplicated internal and boundary stats', () => {
  const repository = {
    files: [
      { id: 'loginForm', path: 'apps/web/src/features/auth/components/LoginForm.tsx' },
      { id: 'submitBtn', path: 'apps/web/src/features/auth/components/SubmitButton.tsx' },
      { id: 'useAuth', path: 'apps/web/src/features/auth/hooks/useAuth.ts' },
      { id: 'validator', path: 'packages/shared/src/utils/validation.ts' },
    ],
    edges: [
      // 1. Internal to components
      { source: 'loginForm', target: 'submitBtn', type: 'imports' },
      // 2. Cross-directory between components and hooks, but internal to auth
      { source: 'loginForm', target: 'useAuth', type: 'imports' },
      // 3. Cross-package between apps and packages
      { source: 'useAuth', target: 'validator', type: 'imports' },
    ],
  }

  const { stats } = deriveDirectoryHierarchy(repository)

  // Scope: apps/web/src/features/auth/components
  const compStats = stats.get('apps/web/src/features/auth/components')
  assert.ok(compStats, 'components directory stats must exist')
  assert.equal(compStats.internal, 1, 'components has exactly 1 internal dependency (loginForm -> submitBtn)')
  assert.equal(compStats.outgoing, 1, 'components has 1 outgoing dependency (loginForm -> useAuth)')
  assert.equal(compStats.incoming, 0)

  // Scope: apps/web/src/features/auth (contains both components and hooks)
  const authStats = stats.get('apps/web/src/features/auth')
  assert.ok(authStats, 'auth directory stats must exist')
  assert.equal(authStats.internal, 2, 'auth contains both internal dependencies (loginForm -> submitBtn and loginForm -> useAuth)')
  assert.equal(authStats.outgoing, 1, 'auth has 1 outgoing cross-boundary edge to packages (useAuth -> validator)')

  // Scope: packages/shared/src/utils
  const utilStats = stats.get('packages/shared/src/utils')
  assert.ok(utilStats, 'utils directory stats must exist')
  assert.equal(utilStats.internal, 0)
  assert.equal(utilStats.incoming, 1, 'utils has 1 incoming dependency from auth')
})

test('Folder Aggregation: Collapsing hides canvas self-loops; expanding restores individual direct file edges', () => {
  const repository = {
    files: [
      { id: 'f_a', path: 'Frontend/src/components/Header.jsx' },
      { id: 'f_b', path: 'Frontend/src/components/Nav.jsx' },
      { id: 'f_c', path: 'Frontend/src/lib/api.js' },
    ],
    edges: [
      { source: 'f_a', target: 'f_b', type: 'imports' },
      { source: 'f_a', target: 'f_c', type: 'imports' },
    ],
  }

  // State 1: All collapsed
  const collapsed = buildElements(repository, new Set(), null)
  // Both f_a and f_b collapse to folder:Frontend; f_c collapses to folder:Frontend
  // Since both ends of f_a -> f_b and f_a -> f_c are inside Frontend, no self-loops appear on canvas
  assert.equal(collapsed.edges.length, 0, 'No self-loops on canvas when top folder is collapsed')
  const topFolder = collapsed.nodes.find((n) => n.id === 'folder:Frontend')
  assert.ok(topFolder)
  assert.equal(topFolder.data.internal, 2, 'Top folder node data accurately tracks 2 internal edges')

  // State 2: Expand Frontend and components
  const expanded = new Set(['Frontend', 'Frontend/src', 'Frontend/src/components', 'Frontend/src/lib'])
  const elements = buildElements(repository, expanded, null)

  // Individual direct edges must be restored
  const headerToNav = elements.edges.find((e) => e.source === 'file:f_a' && e.target === 'file:f_b')
  const headerToApi = elements.edges.find((e) => e.source === 'file:f_a' && e.target === 'file:f_c')

  assert.ok(headerToNav, 'Direct file-to-file link Header -> Nav must be restored on canvas')
  assert.ok(headerToApi, 'Direct file-to-file link Header -> api must be restored on canvas')
  assert.equal(headerToNav.label, 'imports')
  assert.equal(headerToApi.label, 'imports')
})

// ============================================================================
// 2. Layout Non-Overlap and Determinism Verification
// ============================================================================

test('Layout: Connected and standalone file nodes NEVER overlap in multi-column leaf folders with long filenames', () => {
  // 15 files in a single leaf folder with realistic long filenames and dense dependency relationships
  const files = [
    { id: 'f1', path: 'components/AuthenticationAndAuthorizationSecurityController.js' },
    { id: 'f2', path: 'components/UserLifecycleAndOrganizationSubscriptionController.js' },
    { id: 'f3', path: 'components/RepositoryGraphExplorationAndVisualizationController.js' },
    { id: 'f4', path: 'components/WebhookEventDeliveryAndLedgerReconciliationController.js' },
    { id: 'f5', path: 'components/TokenVerificationAndClaimsExtractionService.js' },
    { id: 'f6', path: 'components/DeterministicUnifiedGraphBuilderService.js' },
    { id: 'f7', path: 'components/IncrementalCrossBatchDependencyPublisherService.js' },
    { id: 'f8', path: 'components/LanguageParserRegistryAndTaskSchedulerService.js' },
    { id: 'f9', path: 'components/CryptographicHashAndFencingTokenGenerator.js' },
    { id: 'f10', path: 'components/ComprehensiveApplicationHttpExceptionHierarchy.js' },
    { id: 'f11', path: 'components/EnvironmentVariableValidationAndSchemaDefinition.js' },
    { id: 'f12', path: 'components/DatabaseConnectionPoolAndLifecycleManager.js' },
    { id: 'f13', path: 'components/DocumentationAndArchitectureGuidelinesReadme.md' },
    { id: 'f14', path: 'components/ComponentPackageManifestDefinition.json' },
    { id: 'f15', path: 'components/TypeScriptCompilerOptionsConfiguration.json' },
  ]

  const edges = [
    { source: 'f1', target: 'f5', type: 'imports' },
    { source: 'f2', target: 'f5', type: 'imports' },
    { source: 'f3', target: 'f6', type: 'imports' },
    { source: 'f3', target: 'f7', type: 'imports' },
    { source: 'f4', target: 'f9', type: 'imports' },
    { source: 'f5', target: 'f9', type: 'imports' },
    { source: 'f6', target: 'f10', type: 'imports' },
    { source: 'f7', target: 'f10', type: 'imports' },
    { source: 'f8', target: 'f10', type: 'imports' },
    { source: 'f9', target: 'f11', type: 'imports' },
    { source: 'f12', target: 'f11', type: 'imports' },
  ]

  const repo = { files, edges }
  const expanded = new Set(['components'])
  const { positions } = getLayout(repo, expanded)

  const compLayout = positions.get('components')
  assert.ok(compLayout)
  const childLayouts = compLayout.childLayouts

  assert.equal(childLayouts.length, 15, 'All 15 child files in the leaf folder must be positioned')

  // Helper: check if two 2D boxes intersect with a strict collision tolerance
  const boxesIntersect = (b1, b2) => {
    return (
      b1.x < b2.x + b2.width &&
      b1.x + b1.width > b2.x &&
      b1.y < b2.y + b2.height &&
      b1.y + b1.height > b2.y
    )
  }

  // Pairwise non-overlap assertion across all file nodes
  for (let i = 0; i < childLayouts.length; i++) {
    for (let j = i + 1; j < childLayouts.length; j++) {
      const b1 = childLayouts[i]
      const b2 = childLayouts[j]
      const overlaps = boxesIntersect(b1, b2)
      assert.equal(
        overlaps,
        false,
        `Node collision detected between '${b1.file.id}' (${b1.x},${b1.y}) and '${b2.file.id}' (${b2.x},${b2.y})`
      )
    }
  }
})

test('Layout: Node coordinates are 100% deterministic across repeated runs with shuffled file arrays', () => {
  const files = [
    { id: 'a', path: 'src/A.js' },
    { id: 'b', path: 'src/B.js' },
    { id: 'c', path: 'src/C.js' },
    { id: 'd', path: 'src/D.js' },
    { id: 'e', path: 'src/E.js' },
  ]
  const edges = [
    { source: 'a', target: 'b', type: 'imports' },
    { source: 'b', target: 'c', type: 'imports' },
    { source: 'c', target: 'd', type: 'imports' },
    { source: 'd', target: 'e', type: 'imports' },
  ]

  const expanded = new Set(['src'])

  // Run 1: original order
  const run1 = getLayout({ files, edges }, expanded)
  const pos1 = JSON.stringify([...run1.positions.entries()].map(([k, v]) => [k, v.x, v.y, v.width, v.height]))

  // Run 2-5: reversed and shuffled orders
  for (let run = 2; run <= 5; run++) {
    const shuffledFiles = [...files].sort(() => (run % 2 === 0 ? 1 : -1))
    const shuffledEdges = [...edges].sort(() => (run % 3 === 0 ? 1 : -1))
    const runN = getLayout({ files: shuffledFiles, edges: shuffledEdges }, expanded)
    const posN = JSON.stringify([...runN.positions.entries()].map(([k, v]) => [k, v.x, v.y, v.width, v.height]))
    assert.equal(
      posN,
      pos1,
      `Layout must be 100% deterministic regardless of input file or edge ordering (Run ${run} failed)`
    )
  }
})
