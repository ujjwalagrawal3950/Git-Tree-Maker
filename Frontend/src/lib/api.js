const API_BASE_URL = (
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) ||
  'http://localhost:3000'
).replace(/\/+$/, '')

async function readResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) return null
  return response.json().catch(() => null)
}

export async function deleteAccount(token) {
  if (!token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  let response
  try {
    response = await fetch(`${API_BASE_URL}/api/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
    })
  } catch {
    throw new Error('Unable to reach the server. Please try again.')
  }

  if (response.status === 204) return null

  const payload = await readResponse(response)
  const message =
    (payload && payload.error && payload.error.message) ||
    'Account deletion failed. Please try again.'

  const error = new Error(message)
  error.status = response.status
  error.code = payload && payload.error && payload.error.code
  throw error
}

export async function verifyRepositoryUrl(url, token, orgId) {
  if (!token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  let response
  try {
    const endpoint = orgId
      ? `${API_BASE_URL}/api/organizations/${encodeURIComponent(orgId)}/repositories/verify`
      : `${API_BASE_URL}/api/repositories/verify`

    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url }),
      credentials: 'omit',
    })
  } catch {
    const error = new Error('GitHub service temporarily unavailable.')
    error.code = 'GITHUB_UNAVAILABLE'
    throw error
  }

  const payload = await readResponse(response)

  if (!response.ok) {
    const code = payload && payload.error && payload.error.code
    let message = payload && payload.error && payload.error.message

    if (code === 'PRIVATE_REPOSITORY') {
      message = 'Private repository not supported.'
    } else if (code === 'REPOSITORY_NOT_FOUND') {
      message = 'Repository not found or inaccessible.'
    } else if (code === 'GITHUB_RATE_LIMITED') {
      message = 'GitHub API rate limit reached.'
    } else if (code === 'GITHUB_UNAVAILABLE' || code === 'GITHUB_TIMEOUT') {
      message = 'GitHub service temporarily unavailable.'
    } else if (code === 'INVALID_GITHUB_URL') {
      message = 'Enter a valid GitHub repository URL.'
    } else if (code === 'NO_ACTIVE_ORGANIZATION') {
      message = 'Select an active organization before verifying a repository.'
    }

    const error = new Error(message || 'Repository verification failed.')
    error.status = response.status
    error.code = code
    throw error
  }

  return payload && payload.data
}

export async function fetchRepositoryManifest(url, token, orgId, ref, signal) {
  if (!token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  let response
  try {
    const endpoint = orgId
      ? `${API_BASE_URL}/api/organizations/${encodeURIComponent(orgId)}/repositories/manifest`
      : `${API_BASE_URL}/api/repositories/manifest`

    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url, ref }),
      credentials: 'omit',
      signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    const error = new Error('GitHub service temporarily unavailable.')
    error.code = 'GITHUB_UNAVAILABLE'
    throw error
  }

  const payload = await readResponse(response)

  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Failed to fetch repository manifest.')
    error.status = response.status
    error.code = payload?.error?.code
    throw error
  }

  return payload && payload.data
}

export async function graphRequest(path, { token, orgId, query, method = 'GET', body, signal } = {}) {
  if (!token) {
    const error = new Error('Your session has expired. Please sign in again.')
    error.status = 401
    error.code = 'UNAUTHORIZED'
    throw error
  }

  const url = new URL(`${API_BASE_URL}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
  }
  if (orgId) {
    headers['x-organization-id'] = orgId
  }
  if (body) {
    headers['Content-Type'] = 'application/json'
  }

  let response
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      signal,
    })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw err
    }
    const error = new Error('Unable to reach the server. Please check your connection and try again.')
    error.status = 0
    error.code = 'NETWORK_ERROR'
    throw error
  }

  if (response.status === 204) return null

  const payload = await readResponse(response)

  if (!response.ok) {
    const code = payload && payload.error && payload.error.code
    let message = payload && payload.error && payload.error.message

    if (response.status === 401) {
      message = message || 'Your session has expired. Please sign in again.'
    } else if (response.status === 403) {
      message = message || 'You do not have permission to access this repository graph.'
    } else if (response.status === 404) {
      message = message || 'Graph snapshot not built or item not found.'
    } else if (response.status === 429) {
      message = message || 'Request limit exceeded. Please wait a moment and try again.'
    } else if (response.status >= 500) {
      message = 'An unexpected server error occurred. Please try again later.'
    }

    const error = new Error(message || 'Graph request failed.')
    error.status = response.status
    error.code = code || 'GRAPH_API_ERROR'
    error.details = payload && payload.error && payload.error.details
    throw error
  }

  return payload && payload.data
}

export async function fetchGraphSummary(repositoryId, token, orgId, commitSha, signal) {
  return graphRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/graph`, {
    token,
    orgId,
    query: { commitSha },
    signal,
  })
}

export async function requestBuildGraph(repositoryId, token, orgId, options = {}, signal) {
  const body = {
    ref: options.ref || 'HEAD',
    ...(options.commitSha ? { commitSha: options.commitSha } : {}),
    ...(options.paths ? { paths: options.paths } : {}),
  }
  return graphRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/graph/build`, {
    method: 'POST',
    body,
    token,
    orgId,
    signal,
  })
}

export async function fetchGraphNodes(repositoryId, token, orgId, params = {}, signal) {
  return graphRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/graph/nodes`, {
    token,
    orgId,
    query: {
      type: params.type,
      language: params.language,
      query: params.query,
      page: params.page,
      pageSize: params.pageSize,
      commitSha: params.commitSha,
    },
    signal,
  })
}

export async function fetchGraphEdges(repositoryId, token, orgId, params = {}, signal) {
  return graphRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/graph/edges`, {
    token,
    orgId,
    query: {
      edgeType: params.edgeType,
      excludeTypes: Array.isArray(params.excludeTypes)
        ? params.excludeTypes.join(',')
        : params.excludeTypes,
      source: params.source,
      target: params.target,
      page: params.page,
      pageSize: params.pageSize,
      commitSha: params.commitSha,
    },
    signal,
  })
}

export async function fetchNodeDetails(repositoryId, nodeId, token, orgId, commitSha, signal) {
  return graphRequest(
    `/api/repositories/${encodeURIComponent(repositoryId)}/graph/nodes/${encodeURIComponent(nodeId)}`,
    {
      token,
      orgId,
      query: { commitSha },
      signal,
    },
  )
}

export async function fetchOutgoingEdges(repositoryId, nodeId, token, orgId, commitSha, signal) {
  return graphRequest(
    `/api/repositories/${encodeURIComponent(repositoryId)}/graph/nodes/${encodeURIComponent(nodeId)}/outgoing`,
    {
      token,
      orgId,
      query: { commitSha },
      signal,
    },
  )
}

export async function fetchIncomingEdges(repositoryId, nodeId, token, orgId, commitSha, signal) {
  return graphRequest(
    `/api/repositories/${encodeURIComponent(repositoryId)}/graph/nodes/${encodeURIComponent(nodeId)}/incoming`,
    {
      token,
      orgId,
      query: { commitSha },
      signal,
    },
  )
}

export async function fetchNeighborhood(repositoryId, centerNodeId, token, orgId, options = {}, signal) {
  if (!centerNodeId) {
    const error = new Error('centerNodeId is required to query graph neighborhood.')
    error.status = 400
    error.code = 'MISSING_CENTER_NODE_ID'
    throw error
  }
  return graphRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/graph/neighborhood`, {
    token,
    orgId,
    query: {
      centerNodeId,
      maxDepth: options.maxDepth || options.depth,
      maxNodes: options.maxNodes,
      direction: options.direction,
      edgeTypes: Array.isArray(options.edgeTypes) ? options.edgeTypes.join(',') : options.edgeTypes,
      commitSha: options.commitSha,
    },
    signal,
  })
}

export async function fetchEdgeEvidence(repositoryId, edgeId, token, orgId, commitSha, signal) {
  return graphRequest(
    `/api/repositories/${encodeURIComponent(repositoryId)}/graph/edges/${encodeURIComponent(edgeId)}/evidence`,
    {
      token,
      orgId,
      query: { commitSha },
      signal,
    },
  )
}

export async function fetchUnresolvedReferences(repositoryId, token, orgId, params = {}, signal) {
  return graphRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/graph/unresolved`, {
    token,
    orgId,
    query: {
      status: params.status,
      category: params.category,
      sourceFile: params.sourceFile,
      page: params.page,
      pageSize: params.pageSize,
      commitSha: params.commitSha,
    },
    signal,
  })
}

export async function fetchFileSubgraph(repositoryId, filePath, token, orgId, commitSha, signal) {
  return graphRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/graph/subgraph/file`, {
    token,
    orgId,
    query: { path: filePath, commitSha },
    signal,
  })
}
