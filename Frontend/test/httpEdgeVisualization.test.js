import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveDirectoryHierarchy,
} from '../src/lib/repositoryGraph.js'
import {
  computeGraphGeometry,
  decorateGraphElements,
} from '../src/components/map/buildElements.js'
import { paginateUnderlyingEdges } from '../src/lib/provenancePagination.js'

// Synthetic repository fixture
function createFixtureRepository() {
  return {
    repository: 'test-org/cartograph-web',
    commitSha: 'c1d2e3f4a5b60000000000000000000000000000',
    files: [
      { id: 'f_client_auth', path: 'Frontend/src/api/authClient.js', folder: 'Frontend', directory: 'Frontend/src/api' },
      { id: 'f_client_users', path: 'Frontend/src/api/userClient.js', folder: 'Frontend', directory: 'Frontend/src/api' },
      { id: 'f_client_utils', path: 'Frontend/src/utils/formatters.js', folder: 'Frontend', directory: 'Frontend/src/utils' },
      { id: 'f_server_auth', path: 'Backend/routes/authRoutes.js', folder: 'Backend', directory: 'Backend/routes' },
      { id: 'f_server_users', path: 'Backend/routes/userRoutes.js', folder: 'Backend', directory: 'Backend/routes' },
      { id: 'f_server_db', path: 'Backend/db/connection.js', folder: 'Backend', directory: 'Backend/db' },
    ],
    edges: [
      // Static import inside Frontend
      {
        id: 'edge_static_frontend',
        source: 'f_client_auth',
        target: 'f_client_utils',
        type: 'imports',
        evidence: [{ rule: 'relative_import' }],
      },
      // Static import inside Backend
      {
        id: 'edge_static_backend',
        source: 'f_server_auth',
        target: 'f_server_db',
        type: 'imports',
        evidence: [{ rule: 'relative_import' }],
      },
      // Dynamic HTTP Request 1: Frontend -> Backend (exact POST /api/login)
      {
        id: 'edge_http_login',
        source: 'f_client_auth',
        target: 'f_server_auth',
        type: 'http_request',
        semanticQualifier: 'POST:/api/login',
        metadata: {
          httpMethod: 'POST',
          composedRoutePath: '/api/login',
          classification: 'confirmed_exact',
          isPatternCompatible: false,
          mountChain: [{ prefix: '/api', routerFileId: 'Backend/app.js' }],
        },
        evidence: [
          {
            category: 'http_request',
            resolver: { name: 'HttpRouteResolver', rule: 'exact_literal_match' },
            status: { isConfirmed: true, classification: 'confirmed_exact' },
            target: { httpMethod: 'POST', composedRoutePath: '/api/login' },
          },
        ],
      },
      // Dynamic HTTP Request 2: Frontend -> Backend (pattern GET /api/users/:id)
      {
        id: 'edge_http_users',
        source: 'f_client_users',
        target: 'f_server_users',
        type: 'http_request',
        semanticQualifier: 'GET:/api/users/:id:pattern',
        metadata: {
          httpMethod: 'GET',
          composedRoutePath: '/api/users/:id',
          classification: 'pattern_compatible',
          isPatternCompatible: true,
          mountChain: [{ prefix: '/api/users', routerFileId: 'Backend/app.js' }],
        },
        evidence: [
          {
            category: 'http_request',
            resolver: { name: 'HttpRouteResolver', rule: 'pattern_template_parameter_match' },
            status: { isConfirmed: true, classification: 'pattern_compatible' },
            target: { httpMethod: 'GET', composedRoutePath: '/api/users/:id' },
          },
        ],
      },
    ],
  }
}

test('Stage 5 - 1: Direct http_request file-to-file edge receives type http_request, data.isHttpRequest, and formatted label', () => {
  const repo = createFixtureRepository()
  // Expand all folders to see file-level edges directly
  const expanded = new Set(['Frontend', 'Backend', 'Frontend/src', 'Frontend/src/api', 'Backend/routes'])

  const geometry = computeGraphGeometry(repo, expanded)
  assert.ok(geometry.edges.length > 0)

  const httpLoginEdge = geometry.edges.find((e) => e.data?.composedRoutePath === '/api/login')
  assert.ok(httpLoginEdge, 'HTTP login edge must exist in geometry')
  assert.equal(httpLoginEdge.type, 'http_request')
  assert.equal(httpLoginEdge.data?.isHttpRequest, true)
  assert.equal(httpLoginEdge.data?.httpMethod, 'POST')
  assert.equal(httpLoginEdge.label, 'POST /api/login')
  assert.equal(httpLoginEdge.hasHttpRequest, true)
})

test('Stage 5 - 2: Parameterized http_request edge formats pattern label', () => {
  const repo = createFixtureRepository()
  const expanded = new Set(['Frontend', 'Backend', 'Frontend/src', 'Frontend/src/api', 'Backend/routes'])

  const geometry = computeGraphGeometry(repo, expanded)
  const httpUsersEdge = geometry.edges.find((e) => e.data?.composedRoutePath === '/api/users/:id')

  assert.ok(httpUsersEdge, 'HTTP users edge must exist in geometry')
  assert.equal(httpUsersEdge.type, 'http_request')
  assert.equal(httpUsersEdge.data?.httpMethod, 'GET')
  assert.equal(httpUsersEdge.label, 'GET /api/users/:id')
})

test('Stage 5 - 3: Inter-folder aggregation preserves http_request in underlyingEdges', () => {
  const repo = createFixtureRepository()
  // Architecture view: all folders collapsed
  const geometry = computeGraphGeometry(repo, new Set())

  // Find aggregate edge between Frontend and Backend
  const folderEdge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )

  assert.ok(folderEdge, 'Aggregate folder edge Frontend -> Backend must exist')
  assert.equal(folderEdge.isAggregated, true)
  assert.equal(folderEdge.count, 2, 'Should aggregate the 2 cross-folder HTTP edges')
  assert.equal(folderEdge.hasHttpRequest, true)
  assert.equal(folderEdge.underlyingEdges.length, 2)
  assert.equal(folderEdge.underlyingEdges[0].type, 'http_request')
  assert.equal(folderEdge.underlyingEdges[1].type, 'http_request')
})

test('Stage 5 - 4: Aggregate edge with mixed imports and HTTP requests displays combined count and hasHttpRequest', () => {
  const repo = createFixtureRepository()
  // Add a static import from Frontend to Backend (e.g. shared types)
  repo.edges.push({
    id: 'edge_shared_types',
    source: 'f_client_auth',
    target: 'f_server_auth',
    type: 'imports',
    evidence: [{ rule: 'cross_subsystem_import' }],
  })

  const geometry = computeGraphGeometry(repo, new Set())
  const folderEdge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )

  assert.ok(folderEdge)
  assert.equal(folderEdge.count, 3)
  assert.equal(folderEdge.hasHttpRequest, true)
  assert.equal(folderEdge.hasStaticDependency, true)
  assert.equal(folderEdge.label, 'connections (3)')
})

test('Stage 5 - 5: Relationship filter "all" includes both static code and HTTP edges', () => {
  const repo = createFixtureRepository()
  const geometry = computeGraphGeometry(repo, new Set(), {
    relationshipFilter: 'all',
  })

  // Has folder-level edge Frontend -> Backend (HTTP)
  const crossEdge = geometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.ok(crossEdge)
  assert.equal(crossEdge.hasHttpRequest, true)
})

test('Stage 5 - 6: Relationship filter "code" excludes http_request edges without altering node layout', () => {
  const repo = createFixtureRepository()

  const allGeometry = computeGraphGeometry(repo, new Set(), {
    relationshipFilter: 'all',
  })
  const codeGeometry = computeGraphGeometry(repo, new Set(), {
    relationshipFilter: 'code',
  })

  // Node counts and coordinates must be IDENTICAL (100% layout stability safeguard)
  assert.equal(codeGeometry.nodes.length, allGeometry.nodes.length)
  for (let i = 0; i < allGeometry.nodes.length; i++) {
    assert.equal(codeGeometry.nodes[i].id, allGeometry.nodes[i].id)
    assert.deepEqual(codeGeometry.nodes[i].position, allGeometry.nodes[i].position)
  }

  // Cross-folder HTTP edge must be excluded under code-only filter
  const crossEdge = codeGeometry.edges.find(
    (e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend',
  )
  assert.equal(crossEdge, undefined, 'No cross-folder HTTP edge should exist when filtering code only')
})

test('Stage 5 - 7: Relationship filter "http" includes only http_request edges without altering node layout', () => {
  const repo = createFixtureRepository()
  const expanded = new Set(['Frontend', 'Backend', 'Frontend/src', 'Frontend/src/api', 'Frontend/src/utils', 'Backend/routes', 'Backend/db'])

  const allGeometry = computeGraphGeometry(repo, expanded, {
    relationshipFilter: 'all',
  })
  const httpGeometry = computeGraphGeometry(repo, expanded, {
    relationshipFilter: 'http',
  })

  // Node positions must remain identical
  assert.equal(httpGeometry.nodes.length, allGeometry.nodes.length)
  for (let i = 0; i < allGeometry.nodes.length; i++) {
    assert.deepEqual(httpGeometry.nodes[i].position, allGeometry.nodes[i].position)
  }

  // Static imports inside Frontend and Backend must be excluded
  const staticEdge = httpGeometry.edges.find((e) => e.type === 'imports')
  assert.equal(staticEdge, undefined, 'Static import edges must be omitted in http-only filter')

  // HTTP edges must remain present
  const httpEdges = httpGeometry.edges.filter((e) => e.type === 'http_request')
  assert.equal(httpEdges.length, 2, 'Both HTTP edges must be present')
})

test('Stage 5 - 8: paginateUnderlyingEdges groups http_request in typeCounts and supports filtering', () => {
  const underlyingEdges = [
    { id: '1', type: 'imports', sourcePath: 'src/App.jsx', targetPath: 'src/utils.js' },
    { id: '2', type: 'imports', sourcePath: 'src/index.js', targetPath: 'src/App.jsx' },
    { id: '3', type: 'http_request', sourcePath: 'src/api/auth.js', targetPath: 'server/auth.js', metadata: { httpMethod: 'POST', composedRoutePath: '/api/login' } },
  ]

  const pagination = paginateUnderlyingEdges(underlyingEdges, { selectedTypeFilter: 'ALL' })
  assert.equal(pagination.typeCounts.length, 2)
  const httpCount = pagination.typeCounts.find((c) => c.type === 'http_request')
  assert.ok(httpCount)
  assert.equal(httpCount.count, 1)

  // Filter to http_request only
  const httpFiltered = paginateUnderlyingEdges(underlyingEdges, { selectedTypeFilter: 'http_request' })
  assert.equal(httpFiltered.filteredEdges.length, 1)
  assert.equal(httpFiltered.filteredEdges[0].type, 'http_request')
})

test('Stage 5 - 9: paginateUnderlyingEdges searches by HTTP method and route pattern', () => {
  const underlyingEdges = [
    { id: '1', type: 'imports', sourcePath: 'src/App.jsx', targetPath: 'src/utils.js' },
    { id: '2', type: 'http_request', sourcePath: 'src/api/login.js', targetPath: 'server/auth.js', metadata: { httpMethod: 'POST', composedRoutePath: '/api/v1/auth/login' } },
    { id: '3', type: 'http_request', sourcePath: 'src/api/users.js', targetPath: 'server/users.js', metadata: { httpMethod: 'GET', composedRoutePath: '/api/v1/users' } },
  ]

  // Search by HTTP method 'POST'
  const searchPost = paginateUnderlyingEdges(underlyingEdges, { searchQuery: 'POST' })
  assert.equal(searchPost.filteredEdges.length, 1)
  assert.equal(searchPost.filteredEdges[0].metadata?.httpMethod, 'POST')

  // Search by route segment '/auth/login'
  const searchRoute = paginateUnderlyingEdges(underlyingEdges, { searchQuery: '/auth/login' })
  assert.equal(searchRoute.filteredEdges.length, 1)
  assert.equal(searchRoute.filteredEdges[0].id, '2')
})

test('Stage 5 - 10: deriveDirectoryHierarchy retains underlyingRecord.metadata and hasHttpRequest', () => {
  const repo = createFixtureRepository()
  const hierarchy = deriveDirectoryHierarchy(repo)

  assert.equal(hierarchy.folderEdges.length, 1)
  const folderEdge = hierarchy.folderEdges[0]
  assert.equal(folderEdge.source, 'Frontend')
  assert.equal(folderEdge.target, 'Backend')
  assert.equal(folderEdge.hasHttpRequest, true)
  assert.equal(folderEdge.underlyingEdges.length, 2)
  assert.equal(folderEdge.underlyingEdges[0].type, 'http_request')
  assert.equal(folderEdge.underlyingEdges[0].metadata?.composedRoutePath, '/api/login')
})

test('Stage 5 - 11: decorateGraphElements preserves edge tones and selection for http_request edges', () => {
  const repo = createFixtureRepository()
  const expanded = new Set(['Frontend', 'Backend', 'Frontend/src', 'Frontend/src/api', 'Backend/routes'])

  const geometry = computeGraphGeometry(repo, expanded)
  const httpEdge = geometry.edges.find((e) => e.type === 'http_request')
  assert.ok(httpEdge)

  // Test selecting this edge
  const decorated = decorateGraphElements(geometry, null, httpEdge.id)
  const selected = decorated.edges.find((e) => e.id === httpEdge.id)
  assert.ok(selected)
  assert.equal(selected.selected, true)
})

test('Stage 5 - 12: Zero regressions on existing Step 1 and Step 2 folder dependency logic', () => {
  const repo = createFixtureRepository()
  const hierarchy = deriveDirectoryHierarchy(repo)

  assert.ok(hierarchy.directoryTree)
  assert.ok(hierarchy.folderEdges)
  assert.equal(hierarchy.folderEdges[0].count, 2)
})

test('Stage 5 Final Verification: Mixed folder-level aggregated edge filtering (3 imports, 1 call, 2 HTTP requests)', () => {
  const repository = {
    repository: 'acme/mixed-app',
    commitSha: 'f1e2d3c4b5a60000000000000000000000000000',
    files: [
      { id: 'f_client_a', path: 'Frontend/src/api/auth.js', folder: 'Frontend', directory: 'Frontend/src/api' },
      { id: 'f_client_b', path: 'Frontend/src/api/users.js', folder: 'Frontend', directory: 'Frontend/src/api' },
      { id: 'f_client_c', path: 'Frontend/src/api/config.js', folder: 'Frontend', directory: 'Frontend/src/api' },
      { id: 'f_server_a', path: 'Backend/routes/auth.js', folder: 'Backend', directory: 'Backend/routes' },
      { id: 'f_server_b', path: 'Backend/routes/users.js', folder: 'Backend', directory: 'Backend/routes' },
      { id: 'f_server_c', path: 'Backend/controllers/shared.js', folder: 'Backend', directory: 'Backend/controllers' },
    ],
    edges: [
      // 3 static imports between Frontend and Backend
      {
        id: 'edge_import_1',
        source: 'f_client_a',
        target: 'f_server_a',
        type: 'imports',
        evidence: [{ rule: 'ts_import' }],
      },
      {
        id: 'edge_import_2',
        source: 'f_client_b',
        target: 'f_server_b',
        type: 'imports',
        evidence: [{ rule: 'ts_import' }],
      },
      {
        id: 'edge_import_3',
        source: 'f_client_c',
        target: 'f_server_c',
        type: 'imports',
        evidence: [{ rule: 'ts_import' }],
      },
      // 1 function call between Frontend and Backend
      {
        id: 'edge_call_1',
        source: 'f_client_a',
        target: 'f_server_c',
        type: 'calls',
        evidence: [{ rule: 'rpc_call_site' }],
      },
      // 2 HTTP requests between Frontend and Backend
      {
        id: 'edge_http_1',
        source: 'f_client_a',
        target: 'f_server_a',
        type: 'http_request',
        semanticQualifier: 'POST:/api/auth/login',
        metadata: { httpMethod: 'POST', composedRoutePath: '/api/auth/login' },
        evidence: [{ category: 'http_request', target: { httpMethod: 'POST', composedRoutePath: '/api/auth/login' } }],
      },
      {
        id: 'edge_http_2',
        source: 'f_client_b',
        target: 'f_server_b',
        type: 'http_request',
        semanticQualifier: 'GET:/api/users',
        metadata: { httpMethod: 'GET', composedRoutePath: '/api/users' },
        evidence: [{ category: 'http_request', target: { httpMethod: 'GET', composedRoutePath: '/api/users' } }],
      },
    ],
  }

  // Folder state (both folders collapsed at top-level)
  const expandedFolders = new Set()

  // 1. All filter
  const geomAll = computeGraphGeometry(repository, expandedFolders, { relationshipFilter: 'all' })
  const edgeAll = geomAll.edges.find((e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend')
  assert.ok(edgeAll, 'Aggregate edge must exist in All filter')
  assert.equal(edgeAll.count, 6, '1. All displays 6 underlying relationships')
  assert.equal(edgeAll.underlyingEdges.length, 6)

  // 2. Code filter
  const geomCode = computeGraphGeometry(repository, expandedFolders, { relationshipFilter: 'code' })
  const edgeCode = geomCode.edges.find((e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend')
  assert.ok(edgeCode, 'Aggregate edge must exist in Code filter')
  assert.equal(edgeCode.count, 4, '2. Code displays 4 underlying relationships')
  assert.equal(edgeCode.underlyingEdges.length, 4)

  // 3. HTTP filter
  const geomHttp = computeGraphGeometry(repository, expandedFolders, { relationshipFilter: 'http' })
  const edgeHttp = geomHttp.edges.find((e) => e.source === 'folder:Frontend' && e.target === 'folder:Backend')
  assert.ok(edgeHttp, 'Aggregate edge must exist in HTTP filter')
  assert.equal(edgeHttp.count, 2, '3. HTTP displays 2 underlying relationships')
  assert.equal(edgeHttp.underlyingEdges.length, 2)

  // 4. HTTP-only provenance contains no static imports or function calls
  const httpTypes = new Set(edgeHttp.underlyingEdges.map((e) => e.type))
  assert.equal(httpTypes.has('imports'), false, 'HTTP provenance must not contain imports')
  assert.equal(httpTypes.has('calls'), false, 'HTTP provenance must not contain calls')
  assert.deepEqual(Array.from(httpTypes), ['http_request'], 'HTTP provenance contains only http_request')

  // 5. Code-only provenance contains no HTTP requests
  const codeTypes = new Set(edgeCode.underlyingEdges.map((e) => e.type))
  assert.equal(codeTypes.has('http_request'), false, 'Code provenance must not contain http_request')
  assert.deepEqual(Array.from(codeTypes).sort(), ['calls', 'imports'], 'Code provenance contains calls and imports')

  // 6. Switching filters preserves node coordinates and expanded folder state
  assert.equal(geomAll.nodes.length, geomCode.nodes.length)
  assert.equal(geomAll.nodes.length, geomHttp.nodes.length)
  for (let i = 0; i < geomAll.nodes.length; i++) {
    const nodeAll = geomAll.nodes[i]
    const nodeCode = geomCode.nodes[i]
    const nodeHttp = geomHttp.nodes[i]
    assert.equal(nodeCode.id, nodeAll.id)
    assert.equal(nodeHttp.id, nodeAll.id)
    assert.deepEqual(nodeCode.position, nodeAll.position, `Node ${nodeAll.id} position must match between All and Code`)
    assert.deepEqual(nodeHttp.position, nodeAll.position, `Node ${nodeAll.id} position must match between All and HTTP`)
  }
  assert.deepEqual(geomAll.expandedFolders, expandedFolders)
  assert.deepEqual(geomCode.expandedFolders, expandedFolders)
  assert.deepEqual(geomHttp.expandedFolders, expandedFolders)

  // 7. Aggregated edge identity and underlying canonical relationship IDs remain valid
  assert.equal(edgeAll.id, 'edge:folder:Frontend\0folder:Backend')
  assert.equal(edgeCode.id, 'edge:folder:Frontend\0folder:Backend')
  assert.equal(edgeHttp.id, 'edge:folder:Frontend\0folder:Backend')

  const expectedAllIds = ['edge_import_1', 'edge_import_2', 'edge_import_3', 'edge_call_1', 'edge_http_1', 'edge_http_2'].sort()
  const actualAllIds = edgeAll.underlyingEdges.map((e) => e.id).sort()
  assert.deepEqual(actualAllIds, expectedAllIds, 'All underlying canonical IDs must remain valid')

  const expectedCodeIds = ['edge_import_1', 'edge_import_2', 'edge_import_3', 'edge_call_1'].sort()
  const actualCodeIds = edgeCode.underlyingEdges.map((e) => e.id).sort()
  assert.deepEqual(actualCodeIds, expectedCodeIds, 'Code underlying canonical IDs must remain valid')

  const expectedHttpIds = ['edge_http_1', 'edge_http_2'].sort()
  const actualHttpIds = edgeHttp.underlyingEdges.map((e) => e.id).sort()
  assert.deepEqual(actualHttpIds, expectedHttpIds, 'HTTP underlying canonical IDs must remain valid')
})
