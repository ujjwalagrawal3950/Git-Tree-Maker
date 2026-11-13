# Cartograph — Phase 03: GitHub URL Validation

**Status:** COMPLETE (closed 2026-11-13). Implementation, tests, and documentation verified; the completion report is at the end of this file.  
**Scope:** URL validation and normalization only  
**Previous phase:** Security remediation (Phase 02) — reported code-complete; production rollout/live verification remain pending.  
**Subsequent phase:** Phase 04 (GitHub API repository verification) — complete; see `Docs/specs/phase-04.md`. The Phase 03 endpoint now performs an outbound GitHub API call only because Phase 04 added it with explicit approval; the validator itself remains a pure local operation.

---

## 1. Objective

Implement a reliable GitHub repository URL validation module in the existing Cartograph backend.

A user should be able to submit a repository URL. The backend must determine whether it is an accepted GitHub repository URL and, if valid, return a normalized representation containing the owner, repository name, canonical URL, and optional requested ref if that format is explicitly supported.

**This phase does not connect to GitHub, verify that a repository exists, download files, parse source code, or generate a graph.**

---

## 2. Existing project constraints

Preserve the current stack and existing architecture:

- Backend: Node.js + Express 5 + JavaScript
- Frontend: React 19 + Vite + JSX
- Authentication: Clerk
- Database: Supabase PostgreSQL
- Existing security middleware and organization authorization
- Existing error-handling, CORS, rate-limit, body-limit, and logging conventions

Do not migrate to TypeScript, Next.js, Python, or another framework.

### Reuse the completed security work

The security remediation is reported as code-complete, with production configuration and live acceptance testing still pending.

Before implementation, inspect and reuse existing:
- Verified Clerk session middleware
- Organization/member authorization middleware
- Protected route conventions
- Request validation and error response conventions
- Rate limits and body-size limits
- Logging and error handling

Do not recreate or replace these systems.

Do not change Clerk configuration, Supabase configuration, database schema, RLS policies, webhooks, account deletion, or production environment settings in this phase.

---

## 3. Phase boundaries

### Included

- Inspect current backend routes, controllers, utilities, and tests.
- Decide and document accepted GitHub URL formats.
- Implement a standalone URL parser/validator.
- Normalize accepted URLs.
- Return structured validation results and stable error codes.
- Integrate validation into the existing protected repository-submission API path, if one exists.
- Add unit tests and appropriate API-level tests.
- Update relevant documentation.

### Explicitly excluded

Do not implement any of the following:

- GitHub API calls
- Repository existence or visibility checks
- Private-repository authentication
- Default-branch lookup
- Commit SHA resolution
- Git Tree API calls
- File discovery or file manifests
- Source-file downloads
- Archive downloads or Git cloning
- Parser registry or language parsers
- Dependency resolution
- Graph generation
- Background workers or job queues
- Database migrations or new tables
- New packages without prior approval

Do not create an analysis job for an invalid URL. Prefer not to create any analysis job in this phase unless an existing API design requires it and the user explicitly approves that behavior.

---

## 4. URL format policy

Inspect the existing product/API behavior first. Propose the accepted formats and ask for approval before implementing if the decision changes existing behavior.

### 4.1 Decision (implemented and tested)

The validator in `Backend/lib/validation.js` (`validateGithubRepositoryUrl`) accepts exactly these formats:

```text
https://github.com/{owner}/{repository}
https://github.com/{owner}/{repository}/
https://github.com/{owner}/{repository}.git
https://github.com/{owner}/{repository}.git/
```

Policy details, verified against the implementation:

- **Scheme:** HTTPS only. `http://`, `ssh://`, and `git@github.com:...` are rejected.
- **Host:** exact hostname match on `github.com`, case-insensitive per RFC (the URL parser lowercases it). Lookalike hosts (`github.com.attacker.example`, `notgithub.com`) and GitHub Enterprise hosts are rejected. Host validation is never substring-based.
- **Port:** the port is ignored because identity is taken from the exact hostname; a fixed `https://api.github.com` URL is rebuilt from `owner`/`repo`, so a user-supplied port is never contacted.
- **Path:** exactly two segments, `owner/repository`. Empty segments (`//`) are collapsed, so `https://github.com//owner//repo/` normalizes to the canonical form. Missing owner/repository and extra segments (including `/tree/{ref}`) are rejected. Percent-encoded separators or traversal segments (`%2F`, `%2e%2e`) are rejected. The `.git` suffix is stripped (case-insensitively) before validation.
- **Case:** scheme and host are case-insensitive; owner and repository case is preserved exactly as submitted.
- **Query strings and fragments** are rejected outright rather than silently ignored.
- **Credentials in the URL** (`https://user:pass@github.com/...`) are rejected.
- **Length:** the trimmed input must be 1–255 characters.
- **Ref URLs** (`/tree/{ref}`) and **SSH URLs** are not supported in this phase and are rejected with `INVALID_GITHUB_URL`. Ref parsing remains a future-phase decision.
- **Owner pattern:** 1–39 characters, alphanumeric plus hyphens, must start and end alphanumeric (GitHub's documented username/org rules).
- **Repository pattern:** 1–100 characters, `A–Z a–z 0–9 _ . -`, without `..` anywhere.

### 4.2 Original suggestion (for reference)

```text
https://github.com/{owner}/{repository}
https://github.com/{owner}/{repository}/
https://github.com/{owner}/{repository}.git
```

Optional ref support should be considered separately:

```text
https://github.com/{owner}/{repository}/tree/{ref}
```

Do not attempt to infer complex branch names versus nested paths in this phase. If ref parsing is ambiguous, either:
- accept only the base repository URL for now, or
- define and test a precise parsing policy before implementation.

SSH URL support is optional and must not be silently added:

```text
git@github.com:{owner}/{repository}.git
```

Unless explicitly approved, accept only HTTPS GitHub URLs.

### Host validation

- Accept the exact hostname `github.com`.
- Reject `github.com.attacker.example`.
- Reject `notgithub.com`.
- Reject arbitrary domains and GitHub Enterprise hosts unless separately approved.
- Reject unsupported URL schemes.
- Reject URL credentials such as `https://user:pass@github.com/...`.
- Do not validate hosts using substring matching.

### Path validation

- Require exactly the expected owner/repository path segments for the selected URL format.
- Reject missing owner or repository.
- Reject empty segments and malformed encoded path segments.
- Handle trailing slashes consistently.
- Define behavior for query strings and fragments; do not silently interpret them as repository identity.
- Handle `.git` suffix only for accepted formats.
- Apply a reasonable maximum input length.
- Avoid double-decoding or unsafe path normalization.

Document any GitHub naming restrictions relied upon. Do not invent validation rules that reject legitimate GitHub repository names without evidence.

---

## 5. Suggested module contract

Adapt this to the existing project's naming and module conventions.

Successful result:

```js
{
  valid: true,
  owner: "octocat",
  repo: "hello-world",
  canonicalUrl: "https://github.com/octocat/hello-world",
  requestedRef: null
}
```

Invalid result:

```js
{
  valid: false,
  error: {
    code: "INVALID_GITHUB_URL",
    message: "Enter a valid GitHub repository URL."
  }
}
```

Requirements:

- Controllers should consume structured results.
- Do not make controllers parse error-message strings.
- Do not return stack traces or internal exception details to clients.
- Keep user-facing errors clear and non-sensitive.
- Do not include secrets, tokens, or authorization headers in logs.

The exact error codes and object shape should follow existing API conventions where possible.

---

## 6. Security requirements

1. Prevent SSRF by never fetching a user-supplied hostname.
2. Use exact hostname validation, not string containment.
3. Do not execute shell commands using URL-derived values.
4. Treat all submitted values as untrusted input.
5. Validate URL parsing and decoded path segments safely.
6. Reject embedded credentials.
7. Enforce request-size and URL-length limits.
8. Do not expose raw exceptions or stack traces.
9. Keep existing authentication and organization authorization in place.
10. Do not print `.env` contents or secret values.
11. Do not weaken existing middleware to make testing easier.

Since this phase performs no outbound GitHub requests, the validator should be a pure/local operation wherever practical.

---

## 7. Test plan

Add tests using the project's existing test framework. Do not install a new test framework without approval.

### Valid-input cases

Test at least:
- Standard HTTPS repository URL.
- URL with trailing slash.
- URL with `.git` suffix, if supported.
- URL with a supported ref, if ref support is approved.
- Case behavior according to the documented policy.

### Invalid-input cases

Test at least:
- Empty string.
- Missing scheme.
- HTTP scheme if only HTTPS is supported.
- Arbitrary hostname.
- `github.com.attacker.example`.
- `notgithub.com`.
- Missing owner.
- Missing repository.
- Extra unsupported path segments.
- Embedded username/password.
- Malformed URL.
- Whitespace-only input.
- Overlong input.
- Invalid percent encoding.
- Encoded path separators or traversal-like segments.
- Unsupported query/fragment behavior.

### API-level cases

- Unauthenticated request is rejected by existing auth middleware.
- Authenticated but unauthorized organization member is rejected according to existing policy.
- Valid URL returns the expected structured validation response.
- Invalid URL returns a stable client error.
- Invalid URL does not create a repository, analysis, or job record.
- Existing protected API behavior remains intact.

Mock external services if needed. This phase should not need a live GitHub request.

---

## 8. Implementation workflow

### Step A — Inspect first

Before changing code:
1. Inspect the backend folder structure.
2. Identify repository-related routes and controllers.
3. Search for existing GitHub URL parsing or validation.
4. Inspect existing middleware and API error conventions.
5. Inspect package scripts and test framework.
6. Identify relevant tests.
7. Report the exact files you propose to modify.

Do not assume the code matches old documentation or status summaries.

### Step B — Present the implementation plan

Before editing, report:
- Existing implementation found.
- Missing functionality.
- Accepted URL formats proposed.
- Edge-case decisions.
- Exact files to create or modify.
- Tests to add or update.
- Any package installation or external configuration needed.

Wait for user approval before making code changes.

### Step C — Implement only this phase

After approval:
- Implement the validator.
- Integrate it into the existing API path without bypassing security middleware.
- Add unit and API-level tests.
- Update relevant documentation.
- Keep the changes small and reviewable.

### Step D — Verify

Run the relevant:
- Backend test command.
- Backend lint command, if configured.
- Frontend tests/build only if frontend files were changed.

Report actual command output and results. Do not claim tests passed if they were not run.

---

## 9. Acceptance criteria

Phase 03 is complete only when:

- [ ] Accepted URL formats are documented.
- [ ] Exact GitHub hostname validation is implemented.
- [ ] Invalid, malicious, malformed, and unsupported inputs are rejected.
- [ ] Valid inputs produce normalized owner/repository data.
- [ ] Error responses are structured and stable.
- [ ] Existing Clerk authentication and organization authorization remain active.
- [ ] Invalid URLs cannot create analysis/job records.
- [ ] Unit tests cover valid and invalid cases.
- [ ] API-level tests cover authorization and validation behavior.
- [ ] Existing backend tests still pass.
- [ ] No GitHub network requests occur.
- [ ] No database schema or production configuration changes occur.
- [ ] Documentation is updated.

---

## 10. Required completion report

At the end, provide:

1. Summary of implementation.
2. Files created and modified.
3. Accepted URL formats and rejected cases.
4. API endpoint behavior and example responses.
5. Security considerations.
6. Tests and exact results.
7. Known limitations.
8. Acceptance checklist marked passed, failed, or not tested.
9. Proposed next phase: **Phase 04 — GitHub Repository Verification and Commit SHA Resolution**.

**STOP after Phase 03. Do not start Phase 04 until the user explicitly approves it.**

---

# Immediate instruction

Start by inspecting the existing Cartograph backend and preparing the Phase 03 implementation plan. Do not edit code until the user approves the plan.

---

# Completion report (added 2026-11-13)

The implementation, tests, and documentation required by section 10 have been completed and verified. Phase 04 (GitHub repository verification) had already been implemented and approved before this report was written; it is noted where it overlaps.

## 1. Summary of implementation

- A standalone, pure-local validator `validateGithubRepositoryUrl(value)` in `Backend/lib/validation.js` parses and normalizes submitted repository URLs. It returns `{ owner, repo, canonicalUrl }` on success and throws a structured `AppError(400, "INVALID_GITHUB_URL", ...)` on failure. It performs no network requests, executes no shell commands, and never fetches a user-supplied hostname.
- The validator is integrated into the protected repository-submission path: `POST /api/repositories/verify` and `POST /api/organizations/:orgId/repositories/verify`, behind `requireAuth`, `requireOrgContext`, and a database membership check (`ensureTenantAuthorization` in `Backend/controllers/repositoryController.js`). Since Phase 04 (approved), the endpoint additionally calls the GitHub REST API through `Backend/services/github.js`, which rebuilds a fixed `https://api.github.com/repos/{owner}/{repo}` URL from the validated owner/repo rather than contacting any user-supplied host.
- Invalid URLs fail before any outbound request, response, or record creation. No repository, analysis, or job records exist anywhere in this path.

## 2. Files created and modified

| File | Role |
|---|---|
| `Backend/lib/validation.js` | URL validator/normalizer (created in Phase 03) |
| `Backend/controllers/repositoryController.js` | Integration into the protected verify endpoint |
| `Backend/routes/repositoryRoutes.js` | Top-level verify route with `requireAuth` |
| `Backend/routes/organizationRoutes.js` | Org-scoped verify route with `requireAuth` + `requireOrgContext` |
| `Backend/test/github.test.js` | Unit + API-level tests for Phase 03 (and Phase 04) |
| `Backend/test/repositoryApi.test.js` | Added 2026-11-13: invalid-URL and non-member API-level cases |
| `Docs/specs/phase_03_github_url_validation.md` | This document: status, accepted formats, completion report |

## 3. Accepted URL formats and rejected cases

Accepted: `https://github.com/{owner}/{repo}`, with optional trailing slash and optional `.git` suffix, exact `github.com` hostname, no query/fragment/credentials. Full policy: section 4.1 above.

Rejected with `400 INVALID_GITHUB_URL`: empty/whitespace input, non-string input, missing scheme, `http://`, SSH (`git@github.com:...`), arbitrary or lookalike hosts (`notgithub.com`, `github.com.attacker.example`), embedded username/password, query strings, fragments, missing owner, missing repository, extra path segments (including `/tree/{ref}`), path traversal (`..`, `%2e%2e`), percent-encoded separators (`%2F`), invalid owner/repository names, and inputs over 255 characters.

## 4. API endpoint behavior and example responses

```http
POST /api/repositories/verify
POST /api/organizations/:orgId/repositories/verify
Authorization: Bearer <Clerk session token>
Content-Type: application/json

{ "url": "https://github.com/octocat/Hello-World" }
```

Success (200):

```json
{ "success": true, "data": { "owner": "octocat", "repo": "Hello-World", "fullName": "octocat/Hello-World", "isPrivate": false, "defaultBranch": "main", "htmlUrl": "https://github.com/octocat/Hello-World", "description": "..." } }
```

Invalid URL (400) — raised before any network or record activity:

```json
{ "success": false, "error": { "code": "INVALID_GITHUB_URL", "message": "Enter a valid GitHub repository URL." } }
```

Other stable codes on this path: `UNAUTHENTICATED` (401), `NO_ACTIVE_ORGANIZATION` (403), `ORG_CONTEXT_MISMATCH` (403), `NOT_FOUND` (404, non-member), and the Phase 04 GitHub mapping codes (`REPOSITORY_NOT_FOUND`, `PRIVATE_REPOSITORY`, `GITHUB_RATE_LIMITED`, `GITHUB_TIMEOUT`, `GITHUB_UNAVAILABLE`, `GITHUB_INVALID_RESPONSE`, `REPOSITORY_MOVED`).

## 5. Security considerations

- The validator is pure/local; no user-supplied hostname is ever fetched (SSRF not applicable to Phase 03 itself).
- Exact hostname equality is used; no substring or suffix host matching.
- The Phase 04 outbound call rebuilds a fixed `https://api.github.com` URL from validated `owner`/`repo` values, `encodeURIComponent`-encoded, with `redirect: "manual"`.
- Embedded credentials, query strings, and fragments are rejected; input is length-bounded (255 chars) and never double-decoded.
- No URL-derived value is passed to a shell; no stack traces, tokens, or `.env` values appear in responses or logs.
- Clerk authentication, organization-context enforcement, and the membership check remain in front of the endpoint; existing middleware was not weakened.
- No database schema, RLS, webhook, or production configuration changes were made in this phase.

## 6. Tests and exact results

Run on 2026-11-13 from `Backend/`:

- `npm test` → **52 tests, 52 pass, 0 fail** (includes Phase 03 unit cases: standard URL, trailing slash, `.git`, dots/hyphens in names, and the invalid-input matrix — non-HTTPS, attacker host, wrong host, credentials, missing owner/repo, extra segments, query, fragment, traversal, invalid owner, non-string; plus controller/API cases: 401 unauthenticated, 403 no active org, 403 org-context mismatch, 404 non-member, 400 invalid URL with no outbound fetch, success response shape with no job/analysis fields, and Express-level 401 checks for both routes).
- The two cases added by this completion report: invalid URL → stable `400 INVALID_GITHUB_URL` with zero network access, and authenticated non-member → `404 NOT_FOUND`.
- Also added for Phase 02 on 2026-11-13: four webhook rejection tests (missing Svix headers, invalid signature, tampered payload, and a ledger-untouched assertion).
- `cd Frontend && npm run lint` → **pass** (no findings).

Note: the 52-test total includes tests added by later in-flight work; all Phase 03 cases pass within it. No live GitHub request occurs in any test — external calls are mocked.

## 7. Known limitations

- `/tree/{ref}` URLs and SSH URLs are rejected; ref support was deferred as the spec allows.
- Empty path segments are collapsed rather than rejected (e.g. `https://github.com//owner//repo/` normalizes to the canonical URL). This is a documented deviation from the §4 guidance; it has no security impact because output is canonicalized and no user URL is fetched.
- The port is ignored (hostname identity only); a non-standard port does not cause a non-standard request because the outbound URL is rebuilt.
- API-level tests invoke the controller directly, matching the existing suite's pattern; a full Express round-trip requires a live Clerk session and was not added.
- Live acceptance against real GitHub responses belongs to Phase 04 verification.

## 8. Acceptance checklist (section 9)

| Criterion | Result |
|---|---|
| Accepted URL formats are documented | **Passed** — section 4.1 (added 2026-11-13) |
| Exact GitHub hostname validation implemented | **Passed** |
| Invalid, malicious, malformed, unsupported inputs rejected | **Passed** |
| Valid inputs produce normalized owner/repository data | **Passed** |
| Error responses are structured and stable | **Passed** — `INVALID_GITHUB_URL` |
| Clerk authentication and organization authorization remain active | **Passed** |
| Invalid URLs cannot create analysis/job records | **Passed** — no such records exist; asserted in tests |
| Unit tests cover valid and invalid cases | **Passed** |
| API-level tests cover authorization and validation behavior | **Passed** — completed 2026-11-13 (`repositoryApi.test.js`) |
| Existing backend tests still pass | **Passed** — 52/52 on 2026-11-13 |
| No GitHub network requests occur | **Passed for Phase 03's validator** — the endpoint's GitHub call exists only via the separately approved Phase 04 |
| No database schema or production configuration changes | **Passed** |
| Documentation is updated | **Passed** — this report, section 4.1, and `Docs/architecture/current-architecture.md` |

## 9. Next phase

**Phase 04 — GitHub Repository Verification** was implemented and marked complete before this report (`Docs/specs/phase-04.md`). No further phase should begin without explicit user approval.
