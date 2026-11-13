const { AppError, safeMessage } = require("../lib/errors");
const { generateManifest, DEFAULT_BUDGETS } = require("./manifest");

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Executes a request against the GitHub REST API with consistent headers,
 * timeout handling, and error mapping.
 *
 * @param {string} endpointPath - e.g. "/repos/owner/repo"
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchFn]
 * @returns {Promise<{ payload: any, headers: Headers, status: number }>}
 */
async function requestGithubApi(endpointPath, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (typeof fetchFn !== "function") {
    throw new AppError(
      503,
      "GITHUB_UNAVAILABLE",
      safeMessage("GITHUB_UNAVAILABLE")
    );
  }

  const targetUrl = `${GITHUB_API_BASE}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}`;

  const headers = {
    "User-Agent": "Cartograph-App/1.0",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
  }

  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  let response;
  try {
    response = await fetchFn(targetUrl, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (
      (error && error.name === "TimeoutError") ||
      (error && error.name === "AbortError")
    ) {
      throw new AppError(
        504,
        "GITHUB_TIMEOUT",
        safeMessage("GITHUB_TIMEOUT")
      );
    }
    throw new AppError(
      503,
      "GITHUB_UNAVAILABLE",
      safeMessage("GITHUB_UNAVAILABLE"),
      { cause: error }
    );
  }

  // Handle repository / resource moved (301)
  if (response.status === 301) {
    throw new AppError(
      301,
      "REPOSITORY_MOVED",
      safeMessage("REPOSITORY_MOVED")
    );
  }

  // Handle empty Git repository (409 Conflict)
  if (response.status === 409) {
    return { payload: null, headers: response.headers, status: 409, isEmpty: true };
  }

  // Handle not found / inaccessible (404)
  if (response.status === 404) {
    throw new AppError(
      404,
      "REPOSITORY_NOT_FOUND",
      safeMessage("REPOSITORY_NOT_FOUND")
    );
  }

  // Handle rate limits (403 or 429)
  const remaining = response.headers ? response.headers.get("x-ratelimit-remaining") : null;
  const retryAfter = response.headers ? response.headers.get("retry-after") : null;
  if (
    response.status === 429 ||
    (response.status === 403 && (remaining === "0" || response.headers?.get("x-ratelimit-reset")))
  ) {
    throw new AppError(
      429,
      "GITHUB_RATE_LIMITED",
      safeMessage("GITHUB_RATE_LIMITED"),
      { retryAfterSeconds: retryAfter ? Number(retryAfter) : null }
    );
  }

  if (response.status === 403) {
    throw new AppError(
      404,
      "REPOSITORY_NOT_FOUND",
      safeMessage("REPOSITORY_NOT_FOUND")
    );
  }

  if (response.status >= 500) {
    throw new AppError(
      503,
      "GITHUB_UNAVAILABLE",
      safeMessage("GITHUB_UNAVAILABLE")
    );
  }

  if (response.status !== 200) {
    throw new AppError(
      502,
      "GITHUB_INVALID_RESPONSE",
      safeMessage("GITHUB_INVALID_RESPONSE")
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(
      502,
      "GITHUB_INVALID_RESPONSE",
      safeMessage("GITHUB_INVALID_RESPONSE")
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new AppError(
      502,
      "GITHUB_INVALID_RESPONSE",
      safeMessage("GITHUB_INVALID_RESPONSE")
    );
  }

  return { payload, headers: response.headers, status: response.status, isEmpty: false };
}

/**
 * Verifies that a GitHub repository exists, is accessible, and is public.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {object} [options]
 * @returns {Promise<object>} Structured repository metadata
 */
async function verifyGithubRepository(owner, repo, options = {}) {
  const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const { payload } = await requestGithubApi(endpoint, options);

  if (payload.private === true) {
    throw new AppError(
      403,
      "PRIVATE_REPOSITORY",
      safeMessage("PRIVATE_REPOSITORY")
    );
  }

  return {
    owner: (payload.owner && payload.owner.login) || owner,
    repo: payload.name || repo,
    fullName: payload.full_name || `${owner}/${repo}`,
    isPrivate: false,
    defaultBranch: payload.default_branch || "main",
    htmlUrl: payload.html_url || `https://github.com/${owner}/${repo}`,
    description: payload.description || null,
  };
}

/**
 * Resolves a ref (e.g. branch or tag) to its immutable commit SHA and root tree SHA.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref - Branch name, tag, or commit SHA
 * @param {object} [options]
 * @returns {Promise<{ commitSha: string, rootTreeSha: string } | null>}
 */
async function resolveCommitAndRootTree(owner, repo, ref, options = {}) {
  const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  
  let result;
  try {
    result = await requestGithubApi(endpoint, options);
  } catch (error) {
    if (error && error.status === 404) {
      return null;
    }
    throw error;
  }

  if (result.isEmpty || !result.payload) {
    return null;
  }

  const commitData = result.payload;
  const commitSha = commitData.sha;
  const rootTreeSha =
    commitData.commit &&
    commitData.commit.tree &&
    commitData.commit.tree.sha;

  if (!commitSha || !rootTreeSha) {
    throw new AppError(
      502,
      "GITHUB_INVALID_RESPONSE",
      safeMessage("GITHUB_INVALID_RESPONSE")
    );
  }

  return { commitSha, rootTreeSha };
}

/**
 * Fetches a Git tree by tree SHA.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} treeSha
 * @param {object} [options]
 * @param {boolean} [options.recursive=true]
 * @returns {Promise<{ sha: string, tree: Array<object>, truncated: boolean }>}
 */
async function fetchGitTree(owner, repo, treeSha, options = {}) {
  const isRecursive = options.recursive !== false;
  const query = isRecursive ? "?recursive=1" : "";
  const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}${query}`;

  const { payload } = await requestGithubApi(endpoint, options);

  if (!Array.isArray(payload.tree)) {
    throw new AppError(
      502,
      "GITHUB_INVALID_RESPONSE",
      safeMessage("GITHUB_INVALID_RESPONSE")
    );
  }

  return {
    sha: payload.sha || treeSha,
    tree: payload.tree,
    truncated: Boolean(payload.truncated),
  };
}

/**
 * Traverses a repository tree using bounded non-recursive requests.
 * Used when recursive tree returns truncated: true.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} rootTreeSha
 * @param {object} [options]
 * @param {number} [options.maxTraversalRequests]
 * @returns {Promise<{ tree: Array<object>, truncated: boolean }>}
 */
async function traverseTreeBounded(owner, repo, rootTreeSha, options = {}) {
  const maxRequests = options.maxTraversalRequests || DEFAULT_BUDGETS.maxTraversalRequests;
  let requestCount = 0;

  const collectedEntries = [];
  const queue = [{ sha: rootTreeSha, prefix: "" }];

  let isTruncated = false;

  while (queue.length > 0) {
    if (requestCount >= maxRequests) {
      isTruncated = true;
      break;
    }

    const current = queue.shift();
    requestCount++;

    const treeResult = await fetchGitTree(owner, repo, current.sha, {
      ...options,
      recursive: false,
    });

    for (const item of treeResult.tree) {
      const fullPath = current.prefix ? `${current.prefix}/${item.path}` : item.path;
      const normalizedItem = { ...item, path: fullPath };

      collectedEntries.push(normalizedItem);

      if (item.type === "tree") {
        queue.push({ sha: item.sha, prefix: fullPath });
      }
    }
  }

  if (queue.length > 0) {
    isTruncated = true;
  }

  return {
    tree: collectedEntries,
    truncated: isTruncated,
  };
}

/**
 * Discovers the full repository file manifest for a verified repository.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {object} [options]
 * @param {string} [options.ref] - Branch/commit ref (defaults to repository default branch)
 * @param {object} [options.budgets] - Budget overrides
 * @returns {Promise<object>} Generated manifest
 */
async function discoverRepositoryManifest(owner, repo, options = {}) {
  // 1. Verify repository accessibility and obtain default branch
  const verifiedRepo = await verifyGithubRepository(owner, repo, options);

  const targetRef = options.ref || verifiedRepo.defaultBranch || "main";

  // 2. Resolve commit and root tree SHA
  const commitResolution = await resolveCommitAndRootTree(owner, repo, targetRef, options);

  // If repository has no commits or is empty
  if (!commitResolution) {
    return generateManifest({
      repository: verifiedRepo.fullName,
      commitSha: null,
      rootTreeSha: null,
      treeEntries: [],
      truncated: false,
      status: "empty",
      budgets: options.budgets,
    });
  }

  const { commitSha, rootTreeSha } = commitResolution;

  // 3. Fetch Git tree (recursive first)
  const initialTree = await fetchGitTree(owner, repo, rootTreeSha, {
    ...options,
    recursive: true,
  });

  let treeEntries = initialTree.tree;
  let isTruncated = initialTree.truncated;
  let status = isTruncated ? "partial" : "complete";

  // 4. If truncated, attempt safe bounded non-recursive fallback
  if (isTruncated && options.enableFallback !== false) {
    try {
      const fallbackResult = await traverseTreeBounded(owner, repo, rootTreeSha, options);
      treeEntries = fallbackResult.tree;
      isTruncated = fallbackResult.truncated;
      status = isTruncated ? "partial" : "complete";
    } catch {
      // If fallback fails, retain initial partial tree honestly
      isTruncated = true;
      status = "partial";
    }
  }

  // 5. Generate and return normalized repository manifest
  return generateManifest({
    repository: verifiedRepo.fullName,
    commitSha,
    rootTreeSha,
    treeEntries,
    truncated: isTruncated,
    status,
    budgets: options.budgets,
  });
}

/**
 * Fetches a Git blob by its SHA.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} blobSha
 * @param {object} [options]
 * @returns {Promise<{ sha: string, size: number | null, content: string, encoding: string }>}
 */
async function fetchGitBlob(owner, repo, blobSha, options = {}) {
  const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
  const { payload } = await requestGithubApi(endpoint, options);

  if (!payload || typeof payload !== "object") {
    throw new AppError(
      502,
      "GITHUB_INVALID_RESPONSE",
      safeMessage("GITHUB_INVALID_RESPONSE")
    );
  }

  return {
    sha: payload.sha || blobSha,
    size: typeof payload.size === "number" ? payload.size : null,
    content: typeof payload.content === "string" ? payload.content : "",
    encoding: payload.encoding || "base64",
  };
}

module.exports = {
  GITHUB_API_BASE,
  DEFAULT_TIMEOUT_MS,
  requestGithubApi,
  verifyGithubRepository,
  resolveCommitAndRootTree,
  fetchGitTree,
  traverseTreeBounded,
  discoverRepositoryManifest,
  fetchGitBlob,
};
