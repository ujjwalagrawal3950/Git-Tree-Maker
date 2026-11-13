const API_BASE_URL = (
  import.meta.env.VITE_API_URL || 'http://localhost:3000'
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
