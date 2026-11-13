# Cartograph — Phase 04: GitHub API Repository Verification

**Status:** Complete  
**Scope:** GitHub API-based repository verification and metadata extraction  
**Previous phases:**
- App shell and fixture map (Phase 01)
- Security remediation and tenancy boundaries (Phase 02)
- GitHub URL validation (Phase 03)

---

## 1. Objective

Enable verified submission of public GitHub repository URLs through the protected Cartograph backend.

When an authenticated user with an active organization context submits a repository URL:
1. Parse and validate the GitHub URL server-side to extract owner and repository name.
2. Query GitHub REST API (`GET https://api.github.com/repos/{owner}/{repo}`) using a fixed hostname.
3. Validate visibility: permit public repositories (`private: false`); reject explicitly private repositories (`private: true`).
4. Return structured repository metadata to the frontend without exposing the raw GitHub response.
5. Do not create analysis jobs or database records during this phase.

---

## 2. Architecture & Design

### Outbound GitHub API Service (`Backend/services/github.js`)
- Fixed endpoint hostname: `https://api.github.com`.
- Headers:
  - `User-Agent: Cartograph-App/1.0`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - Optional `Authorization: Bearer <GITHUB_TOKEN>` if configured in environment (never logged).
- Timeout protection: 10-second default using `AbortSignal.timeout()`.
- Error mapping to stable `AppError` codes:
  - 301 Moved Permanently ➔ `REPOSITORY_MOVED` (301)
  - 404 Not Found ➔ `REPOSITORY_NOT_FOUND` (404)
  - 429 / 403 Rate Limit ➔ `GITHUB_RATE_LIMITED` (429)
  - 5xx Server Error ➔ `GITHUB_UNAVAILABLE` (503)
  - TimeoutError ➔ `GITHUB_TIMEOUT` (504)
  - Network Failure ➔ `GITHUB_UNAVAILABLE` (503)
  - Malformed response ➔ `GITHUB_INVALID_RESPONSE` (502)
  - Explicit `private: true` ➔ `PRIVATE_REPOSITORY` (403)

### Endpoint Integration (`Backend/controllers/repositoryController.js`)
- Routes:
  - `POST /api/organizations/:orgId/repositories/verify` (scoped with `requireAuth`, `requireOrgContext`)
  - `POST /api/repositories/verify` (top-level alias enforcing active organization context)
- Tenant Authorization: Enforces `requireMembership(orgId, req.actor.userId)` before verifying.
- Request validation: Plain JSON object body required (`requirePlainObject`), URL validated via `validateGithubRepositoryUrl`.

### Frontend Integration (`Frontend/src/lib/api.js`, `App.jsx`, `TopBar.jsx`)
- Invokes `verifyRepositoryUrl(url, token, orgId)`.
- Disables Open button during verification with `"Checking..."` state.
- Notice states displayed:
  - `"Checking repository..."`
  - `"Public repository verified: {fullName}"`
  - `"Private repository not supported."`
  - `"Repository not found or inaccessible."`
  - `"GitHub API rate limit reached."`
  - `"GitHub service temporarily unavailable."`

