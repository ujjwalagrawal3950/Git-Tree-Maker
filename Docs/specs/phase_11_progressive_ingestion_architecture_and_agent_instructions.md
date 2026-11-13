# Cartograph Phase 11 — Progressive Repository Ingestion & Real-Time Graph Generation

**Document type:** Architecture proposal and AI coding-agent implementation instructions  
**Status:** Proposed — Step 0 inspection required; implementation not yet authorized  
**Depends on:** Existing Cartograph Phases 0–10, especially Phase 04 selective retrieval, Phases 05–09 language parsers/resolvers, Phase 10 graph pipeline and Gate 10F frontend integration  
**Primary objective:** Make repository analysis feel immediate and continuous. When a user clicks **Build Graph**, Cartograph should show real processing progress, publish an initial useful graph as soon as possible, and continue analyzing the repository in the background without requiring users to click individual files.

---

# 1. Executive Summary

We want to evolve Cartograph from a bounded, request-driven repository parser into a **progressive repository ingestion and graph-generation experience**.

The intended user experience:

1. The user submits a GitHub repository and clicks **Build Graph**.
2. The UI immediately shows an analysis progress panel.
3. Cartograph verifies the repository and resolves an immutable full commit SHA.
4. It discovers the Git Tree and calculates the eligible source-file count and eligible source size.
5. It chooses a complete or progressive ingestion strategy using the policy in this document.
6. It retrieves and parses an initial batch of important files.
7. As soon as a valid initial graph is available, the UI displays it.
8. Cartograph continues retrieving and parsing later batches in the background.
9. New confirmed nodes and edges appear in the existing graph without requiring a page reload or file click.
10. The UI reports real processed, remaining, failed, skipped, and graph-edge counts.
11. The job ends in a truthful completed, partial, failed, or cancelled state.

This is not a request to replace Cartograph's existing architecture. It is an extension of the current GitHub ingestion, parser, resolver, graph, and React Flow systems.

**The backend remains the authority for repository facts, canonical identities, confirmed edges, graph validation, and provenance.** The frontend is responsible for progress presentation and graph visualization only.

---

# 2. Current Cartograph Architecture and Existing Work

The following is the current architecture as established by the project's implementation reports. The coding agent must verify the actual current source code during Step 0 rather than assuming that every report still matches the repository.

## 2.1 Existing technology stack

- Frontend: React 19, Vite, JavaScript/JSX, Tailwind CSS.
- Graph visualization: `@xyflow/react` and Dagre.
- Backend: Node.js, Express 5, JavaScript.
- Authentication: Clerk.
- Database and tenant data: Supabase/PostgreSQL with existing authorization and RLS patterns.
- Repository source: GitHub REST/Git APIs.
- Parsing: existing parser facade and language-specific adapters.
- Languages already implemented/reported: JavaScript/TypeScript, Python, Java, C, and C++.
- Graph: FileIR, language-specific resolvers, evidence normalization, GraphBuilder, GraphValidator, GraphQueryService, GraphSnapshotStore.
- Existing application architecture: modular monolith. Preserve it.

Do not introduce a new framework, microservice architecture, queue infrastructure, state-management library, or graph database without explicit approval.

## 2.2 Existing repository ingestion phases

| Phase | Existing responsibility | Reported status |
|---|---|---|
| Phase 01 | GitHub URL validation | Complete |
| Phase 02 | Repository verification and commit resolution | Complete |
| Phase 03 | Git Tree discovery and manifest | Complete |
| Phase 04 | Selective file retrieval | Complete, but current limits need review |
| Phase 05 | Parser architecture and FileIR | Complete |
| Phase 06 | JavaScript/TypeScript parsing and resolution | Complete |
| Phase 07 | Python parsing and resolution | Complete |
| Phase 08 | Java parsing and resolution | Complete |
| Phase 09 | C/C++ parsing and resolution | Complete |
| Phase 10A–10E | Unified graph architecture, identity, builder, validator, query, cache and APIs | Reported complete and accepted |
| Phase 10F | React Flow frontend integration | Implementation reported complete; final acceptance hardening was requested |

## 2.3 Existing Phase 04 limits that must be revisited

Previous implementation reports describe these current protections:

- Maximum recursive tree entries: 10,000.
- Maximum included files: 5,000.
- Maximum individual file: 1 MB.
- Maximum aggregate source retrieval budget: 2 MB.
- Bounded concurrency and retry.
- Binary and invalid UTF-8 checks.
- Blob SHA integrity checks.
- Selective retrieval through GitHub APIs.

These limits were appropriate for the earlier prototype. They are not automatically suitable for the new ingestion policy.

**Do not simply change 2 MB to 150 MB.** First inspect memory, temporary storage, archive expansion, file limits, concurrency, worker lifetime, request timeouts, retry behavior, and deployment constraints. Propose revised values and get approval before changing them.

## 2.4 Existing Phase 10 graph services to reuse

Inspect and reuse the existing services:

- `GraphBuilder`
- `GraphValidator`
- `GraphQueryService`
- `GraphSnapshotStore`
- `graphPipeline`
- `identity.js`
- `evidenceNormalizer.js`
- Existing graph controllers and routes
- Existing repository authorization service
- Existing server-side parser and resolver services

Do not create a second parser pipeline or a second graph-building implementation.

---

# 3. Product Problem We Are Solving

The current interaction model can make users click a file to trigger additional loading or graph updates. This feels like a file explorer and makes the user do work that should be automated.

We want a repository-level action:

**Build Graph → automatic repository ingestion → live progress → initial graph → progressive graph expansion → completion.**

The user should not have to click individual files to make the system continue downloading or parsing the repository.

File and symbol selection should be for exploration of already available graph data, not as the primary ingestion mechanism.

## 3.1 Product principles

1. Give the user immediate feedback after Build Graph is clicked.
2. Show truthful progress based on actual backend job state.
3. Display the initial graph as soon as it is useful and validated.
4. Continue background work without blocking graph exploration.
5. Never represent a partial graph as a complete repository graph.
6. Preserve existing graph identities and edge provenance.
7. Avoid full graph rebuilds and full UI resets after every batch.
8. Keep resource consumption bounded and observable.
9. Make failures and omissions visible rather than silently dropping files.
10. Keep the UI responsive on large repositories.

---

# 4. Agreed Repository Ingestion Policy

This section is the agreed product policy. It must be implemented consistently in the backend and reflected in the UI.

## 4.1 Definitions

The repository manifest contains Git Tree metadata. Before downloading source content, classify each path.

- `totalRepositoryFiles`: all relevant Git Tree file entries, if needed for repository statistics.
- `eligibleFileCount`: number of files selected for source/configuration analysis after exclusions.
- `eligibleSourceBytes`: sum of the Git Tree blob sizes of eligible files.
- `excludedFileCount`: files excluded from content retrieval, such as media, documents, binaries, generated output, vendored dependencies, and caches.
- `excludedBytes`: total known size of excluded files, where available.
- `processedFiles`: eligible files that have reached a terminal processing outcome.
- `remainingFiles`: eligible files not yet in a terminal processing outcome.
- `failedFiles`: files whose processing failed.
- `skippedFiles`: eligible files intentionally skipped with a recorded reason.
- `downloadedFiles`: files whose source content was successfully retrieved and integrity-checked.
- `parsedFiles`: files for which parsing reached a terminal parser outcome.
- `confirmedEdges`: confirmed graph relationships in the current published graph snapshot.

The main size threshold refers to **eligible source/configuration file bytes after exclusions**. It does not refer to the whole GitHub repository size, compressed archive size, temporary extracted size, RAM usage, or Git object database size.

Calculate:

`eligibleSourceBytes = sum(file.size for each eligible manifest entry)`

Use Git Tree blob size metadata when available. Do not download every blob just to estimate total eligible size.

## 4.2 Ingestion modes

The conditions below are evaluated using eligible file count and eligible source bytes.

| Mode | Selection rule | Required behavior |
|---|---|---|
| Small / complete | `eligibleFileCount <= 200 AND eligibleSourceBytes <= 150 MB` | Retrieve and process all eligible files in the same ingestion job, subject to safety limits |
| Medium / progressive | `eligibleFileCount > 200 OR eligibleSourceBytes > 150 MB`, unless large mode applies | Process an initial batch of 100 files, publish the first useful graph, then continue in batches |
| Large / adaptive progressive | `eligibleFileCount >= 500 OR eligibleSourceBytes >= 300 MB` | Process an initial batch of 100 files, then use adaptive batches, strict resource limits, and continuous background processing |

The large condition takes precedence over medium.

Examples:

- 150 files and 80 MB eligible source: small/complete.
- 200 files and 150 MB eligible source: small/complete.
- 250 files and 100 MB eligible source: medium/progressive.
- 100 files and 200 MB eligible source: medium/progressive.
- 450 files and 320 MB eligible source: large/adaptive.
- 700 files and 100 MB eligible source: large/adaptive.
- 600 files and 400 MB eligible source: large/adaptive.

For medium and large modes, the first batch contains up to 100 files, subject to per-file and aggregate safety limits. Later batches normally contain 50–100 files, but batch size must adapt to bytes, parse cost, memory pressure, worker capacity, GitHub rate limits, and observed latency.

**A file-count batch size is not permission to exceed byte or resource budgets.** A batch of 100 large files may be unsafe; a batch may need to contain fewer files.

## 4.3 Excluded content

Do not download file contents for:

- Images and image assets.
- Videos.
- Audio.
- Fonts.
- PDFs.
- Word documents and other office documents.
- Other non-source binary documents.
- Compiled binaries and build artifacts.
- Generated bundles and minified output where not useful.
- Dependency/vendor directories such as `node_modules` and `vendor`.
- Caches and temporary build output.
- Large datasets and unrelated binary assets.

Retain Git Tree metadata for excluded entries so the repository explorer can still display their names and paths.

Example metadata record:

```json
{
  "path": "public/images/logo.png",
  "name": "logo.png",
  "extension": ".png",
  "category": "media",
  "size": 245000,
  "downloaded": false,
  "exclusionReason": "media_asset"
}
```

Do not download excluded file contents merely to display their names.

### Important exceptions and classification rules

- Keep README files and relevant project documentation that helps explain architecture, unless a user-configured policy explicitly excludes them. The user's phrase “exclude docs/media” refers to not downloading general document/media assets as source payload; it must not cause Cartograph to discard important README or configuration context without a deliberate policy.
- Keep source files, dependency manifests, and configuration files such as `package.json`, `tsconfig.json`, `pyproject.toml`, `pom.xml`, and equivalent files.
- Lockfiles may be useful for dependency metadata but should have an explicit size and parsing policy.
- Classify using path, extension, known file type, Git Tree metadata, and safe content validation. Extension alone is not sufficient to trust a file as text.
- Preserve a reason for every excluded or skipped file.

## 4.4 Three different resource limits

Never conflate:

1. **Eligible source budget:** business-level threshold used to select ingestion mode (150 MB / 300 MB).
2. **Compressed transfer budget:** maximum bytes transferred over the network.
3. **Extracted/temporary storage budget:** maximum bytes written to temporary storage.

Also enforce:
- Maximum individual file size.
- Maximum aggregate bytes retrieved for the current job.
- Maximum number of files.
- Maximum download concurrency.
- Maximum parser concurrency.
- Maximum parser execution time.
- Maximum job lifetime or idle time.
- Maximum retry count.
- Maximum memory use where measurable.
- Cleanup of temporary files and abandoned job state.

A repository with 150 MB of eligible source files may have an archive much larger than 150 MB due to excluded files, or a much larger extracted footprint. Archive ingestion must not bypass the eligible-file policy or resource limits.

---

# 5. File Prioritization

Do not process files alphabetically. Prioritize files by architectural value.

Suggested priority:

| Priority | Examples | Reason |
|---|---|---|
| P0 | README, project manifests, build/config files, application entry points | Understand project identity and startup |
| P1 | Server startup, application initialization, main routes, root modules | Discover major architecture |
| P2 | Controllers, services, API clients, domain modules | Understand component boundaries |
| P3 | Core business logic, reusable libraries, important components | Build meaningful dependency relationships |
| P4 | Remaining eligible source files | Complete repository coverage |

The exact priority rules must be deterministic and documented.

Do not assume that all repositories use the same directory names or frameworks. Use language-neutral and framework-aware heuristics only where they are evidence-based. Unknown files must still be eligible for later processing rather than silently discarded.

The manifest should retain the original repository path and deterministic ordering metadata.

---

# 6. Proposed Job-Based Ingestion Architecture

The current direct graph build request is not sufficient to express long-running background ingestion and real-time progress. We need a job lifecycle.

This is a proposed architecture, not permission to add new infrastructure. During Step 0, inspect existing Express, Supabase/PostgreSQL, and deployment capabilities and recommend the smallest reliable implementation.

## 6.1 High-level flow

```text
User clicks Build Graph
        |
        v
POST /api/repositories/:repositoryId/graph/build
        |
        v
Authenticate + authorize repository
        |
        v
Create or reuse ingestion job
        |
        v
Return jobId and initial status
        |
        v
GitHub repository verification
        |
        v
Resolve full commit SHA
        |
        v
Discover Git Tree manifest
        |
        v
Classify eligible and excluded files
        |
        v
Calculate eligibleFileCount and eligibleSourceBytes
        |
        v
Choose small / medium / large ingestion mode
        |
        v
Prioritize eligible files
        |
        v
Download and parse first batch
        |
        v
Resolve facts + build + validate initial graph
        |
        v
Publish initial partial graph snapshot
        |
        v
Continue later batches in background
        |
        v
Resolve cross-batch dependencies and update graph
        |
        v
Publish new validated graph snapshot versions
        |
        v
Mark job complete / partial / failed / cancelled
```

## 6.2 Job manager responsibilities

A dedicated service may be needed, for example:

`Backend/services/ingestion/IngestionJobManager.js`

This is a proposed name; inspect current conventions first.

Responsibilities:

- Create and track ingestion jobs.
- Bind each job to immutable `repositoryId`, `organizationId`, and full `commitSha`.
- Track the selected ingestion mode.
- Track eligible manifest and file-level statuses.
- Coordinate bounded batches.
- Expose progress snapshots.
- Support cancellation.
- Prevent duplicate active jobs for the same repository revision where appropriate.
- Support safe retry/recovery behavior.
- Ensure tenant authorization before job lookup or mutation.
- Keep job status isolated across organizations.
- Clean up abandoned job state.

Do not keep critical job state only in an unbounded in-memory Map if the application can restart or run multiple instances. Inspect existing persistent services and propose whether job metadata should use the existing database. Do not add migrations until the schema and lifecycle design are approved.

## 6.3 Job states

Use explicit, documented states. Suggested lifecycle:

- `queued`
- `verifying_repository`
- `discovering_tree`
- `classifying_files`
- `downloading`
- `parsing`
- `resolving`
- `building_graph`
- `publishing_graph`
- `completed`
- `completed_with_errors`
- `failed`
- `cancel_requested`
- `cancelled`

Do not use a single generic `processing` state internally if the backend can expose the actual phase.

Terminal states must be unambiguous.

## 6.4 Idempotency and duplicate jobs

- Use repository ID + organization ID + full commit SHA as the principal job scope.
- Inspect whether a job for the same revision is already active or complete.
- Avoid duplicate concurrent jobs for the same repository revision unless the user explicitly requests a rebuild.
- Use idempotent batch identifiers or file status transitions.
- Repeated progress delivery must not double-count files or graph edges.
- A retry must not create duplicate nodes or edges.
- Do not let a job for an older commit overwrite the active graph for a newer commit.

---

# 7. Progress Reporting Contract

The UI must display real backend progress. Do not implement a frontend-only timer or fabricated percentage.

## 7.1 Required progress fields

Suggested progress response:

```json
{
  "jobId": "job_123",
  "repositoryId": "repo_123",
  "commitSha": "full_commit_sha",
  "status": "parsing",
  "phase": "parsing",
  "mode": "progressive",
  "totalFiles": 1240,
  "processedFiles": 250,
  "downloadedFiles": 260,
  "parsedFiles": 250,
  "failedFiles": 2,
  "skippedFiles": 5,
  "remainingFiles": 983,
  "eligibleSourceBytes": 73400320,
  "downloadedBytes": 18000000,
  "confirmedEdges": 42,
  "unresolvedReferences": 17,
  "progressPercentage": 20.16,
  "initialGraphReady": true,
  "graphStatus": "partial",
  "batchNumber": 3,
  "totalBatches": 13,
  "message": "Parsing next batch of files...",
  "updatedAt": "ISO-8601 timestamp"
}
```

This is a proposed contract. Align exact names with existing project conventions after inspection.

### Counting rules

- `totalFiles` is the number of eligible files in the immutable manifest.
- `processedFiles` is the number of eligible files that have reached a terminal file-processing outcome for this job.
- `remainingFiles = totalFiles - processedFiles`.
- Failed and skipped files are terminal outcomes and must be separately reported.
- Downloaded and parsed counts are separate because download success does not imply parser success.
- `confirmedEdges` must count only confirmed edges in the currently published graph snapshot.
- `unresolvedReferences` must not be included in confirmed edge count.
- `progressPercentage` must be derived from real progress and must not imply completion while required work remains.
- If total files are unknown during early discovery, represent the value as unknown/null rather than displaying a fabricated denominator.
- If a field is unavailable, do not silently substitute zero.

Progress should be monotonic for a single job where possible. If the manifest changes because a job is restarted against a different commit, it must be a different revision-scoped job.

## 7.2 Real-time delivery

Preferred approach: Server-Sent Events (SSE), because progress is primarily server-to-client.

Potential endpoints (proposed; verify existing route conventions first):

- `POST /api/repositories/:repositoryId/graph/build` — create or reuse a job.
- `GET /api/repositories/:repositoryId/graph/jobs/:jobId` — get current job status.
- `GET /api/repositories/:repositoryId/graph/jobs/:jobId/events` — SSE progress stream.
- `POST /api/repositories/:repositoryId/graph/jobs/:jobId/cancel` — request cancellation.

SSE requirements:

- Reuse existing Clerk authentication and organization context.
- Enforce authoritative repository ownership before job access.
- Scope job events to repository, organization, and full commit SHA.
- Send an initial current-state event on connection.
- Include event IDs or sequence numbers to support reconnect/replay.
- Send heartbeats so idle connections are not mistaken for dead connections.
- Reconnect safely after temporary network interruption.
- Avoid duplicate progress counting on replay.
- Close streams on terminal job state.
- Clean up listeners when the client disconnects.
- Respect deployment/proxy timeouts and streaming behavior.

If the existing deployment cannot reliably support SSE, inspect alternatives and propose a fallback such as polling. Do not add WebSockets or external infrastructure without demonstrating the need.

---

# 8. Incremental Graph Generation and Snapshot Consistency

This is one of the most important technical areas.

## 8.1 Reuse the existing graph pipeline

For each batch:

1. Retrieve eligible source files safely.
2. Validate content and blob identity.
3. Parse through the existing parser service.
4. Produce validated FileIR documents.
5. Run existing language-specific resolvers.
6. Normalize evidence through existing evidence normalization.
7. Accumulate facts for the job's repository revision.
8. Build or update a graph snapshot.
9. Validate the snapshot through GraphValidator.
10. Publish only a valid snapshot.

Do not create a separate parser, resolver, or graph builder.

## 8.2 Cross-batch resolution

Example:

- Batch 1 contains `src/controllers/userController.ts`.
- It imports `src/services/userService.ts`.
- `userService.ts` is not retrieved until Batch 4.

Required behavior:

- Preserve the import fact from Batch 1.
- Mark the target as unresolved or pending according to existing resolver semantics.
- Do not create a confirmed edge without sufficient evidence.
- When Batch 4 is parsed, rerun the relevant resolution against the accumulated manifest/FileIR facts.
- If the relationship becomes confirmed, publish the confirmed edge in a later graph snapshot.
- Preserve provenance and distinguish prior unresolved state from current resolved state.

A partial graph must not permanently lose references merely because the target file had not yet been downloaded.

## 8.3 Partial and complete graph states

Every published graph must clearly identify its completeness state.

Suggested metadata:

```json
{
  "graphStatus": "partial",
  "repositoryId": "repo_123",
  "commitSha": "full_commit_sha",
  "jobId": "job_123",
  "processedFiles": 250,
  "totalFiles": 1240,
  "isComplete": false,
  "snapshotVersion": 3
}
```

At final completion:

- `graphStatus` becomes `complete` if all eligible files have terminal outcomes and no job-level failure prevents completion.
- `completed_with_errors` must remain distinguishable from a fully successful completion.
- The graph must preserve failed/skipped file diagnostics.
- Do not claim every source file was analyzed if some files failed or were skipped.

## 8.4 Snapshot immutability

The existing GraphSnapshotStore reportedly stores immutable snapshots. Preserve that principle.

Do not mutate a published snapshot in place.

For each published batch update:
- Produce a new validated snapshot/version.
- Keep repository ID and full commit SHA fixed.
- Ensure cache keys and snapshot versioning remain compatible with the existing five-dimensional graph fingerprint.
- Inspect the current cache-key semantics before proposing a change.
- Do not silently add or remove a cache-key dimension.
- If an ingestion generation or snapshot version is needed, propose how it fits without breaking canonical identity or existing cache isolation.
- Ensure old snapshots cannot be mistaken for the latest snapshot.
- Ensure a partial snapshot is never served as complete.

---

# 9. Download Strategy and Resource Safety

The existing system uses GitHub Tree and Blob APIs. The coding agent must compare two retrieval options during Step 0:

## Option A — Continue selective Git Blob retrieval

Advantages:
- Existing implementation can be reused.
- Only eligible files are retrieved.
- Per-file blob SHA validation is straightforward.
- No need to extract an entire archive.

Considerations:
- Many HTTP requests for large repositories.
- GitHub rate limits and concurrency.
- Efficient scheduling and retry behavior.
- Aggregate byte accounting.

## Option B — GitHub archive download for eligible repositories

Advantages:
- Potentially fewer network requests.
- May be efficient for small repositories.

Risks:
- Archive contains excluded media/docs/binaries and may be much larger than eligible source payload.
- Compressed archive expansion can be large.
- Archive extraction introduces path traversal, symlink, decompression-bomb, and temporary storage concerns.
- Must still enforce the eligible file allowlist from the immutable Git Tree.
- Must verify file paths and, where feasible, content identity against manifest data.
- Must not extract or retain excluded contents unnecessarily.

**Do not switch to archive download automatically.** During Step 0, compare both approaches and recommend the safer, more efficient choice for Cartograph's current architecture.

Any archive implementation must:
- Stream rather than buffer the whole archive in RAM.
- Enforce compressed and extracted size limits.
- Reject path traversal and unsafe symlinks.
- Extract only eligible manifest paths.
- Clean temporary files on success, failure, cancellation, and restart recovery.
- Never execute repository code or build scripts.

---

# 10. Frontend User Experience

The progress UI is a mandatory product requirement.

## 10.1 Build Graph interaction

When the user clicks Build Graph:

1. Immediately show a loading/progress state.
2. Submit the build request.
3. Receive a job ID.
4. Connect to the job progress stream.
5. Display current phase and file counts.
6. Show the initial graph once `initialGraphReady` is true.
7. Keep progress visible while later batches continue.
8. Incrementally update the graph without resetting the user's viewport.
9. Display final status and summary.

Do not leave the user staring at a blank screen until the entire repository finishes.

## 10.2 Progress panel design

The visual design should resemble the reference shared by the user:

```text
Analyzing repository                         Processing

250 / 1,240
Files processed

[====================-------------------------------] 20.16%

250                 990                 42
Processed           Remaining           Graph edges

✓ Initial graph generated
◉ Parsing next batch of files...

```

Required information:
- Processed / total eligible files.
- Progress bar.
- Remaining files.
- Failed and skipped files, when nonzero.
- Confirmed graph edge count.
- Current processing phase and message.
- Initial graph ready state.
- Partial vs complete graph status.

Do not hardcode example values. All values must come from the backend job progress response.

## 10.3 Graph availability during ingestion

- Render the first valid partial graph as soon as available.
- Keep the graph interactive during later ingestion.
- New nodes and edges should appear smoothly.
- Preserve existing selected node and viewport where possible.
- Do not force the user to click a file to trigger the next batch.
- Do not clear and redraw the whole graph for every update.
- Show a subtle “Graph updating” or processing indicator.
- When complete, transition to a completion state with final counts.

## 10.4 Progressive React Flow updates

- Merge by canonical node ID and edge ID.
- Never deduplicate files by basename.
- Never invent graph edges in the frontend.
- Preserve source/target direction.
- Render only explicitly confirmed backend edges.
- Keep structural relationships such as `contains`, `defines`, and `member_of` distinguishable from dependency relationships.
- Preserve unresolved references outside the confirmed graph edge collection.
- Avoid full Dagre layout recalculation for every tiny update; investigate incremental or affected-region layout.
- Keep graph state scoped to repository ID and full commit SHA.

## 10.5 Cancellation and repository switching

- Provide a cancel action if job cancellation is supported.
- Stop or ignore old job events when the user switches repository.
- Never allow events from one repository or commit to modify another graph view.
- Clean up SSE connections and listeners on unmount or context change.
- A cancelled job must not be shown as completed.
- A new commit must not receive stale graph updates from an older commit.

---

# 11. Job Failure, Retry, and Recovery

Define behavior for:

- GitHub rate limits.
- Network interruption.
- Missing/deleted blobs.
- Blob SHA mismatch.
- Invalid UTF-8 or binary content.
- Parser failure.
- Parser timeout.
- Worker crash.
- Resolver failure.
- Graph validation failure.
- Cache eviction.
- Process restart.
- User cancellation.
- Organization access revocation.
- Repository commit changing while ingestion is running.

Rules:

1. Retry only transient failures, with bounded attempts and backoff.
2. Do not retry permanent invalid-content failures indefinitely.
3. Preserve already validated batches when safe.
4. Never publish an invalid graph snapshot.
5. Never mix commits.
6. Re-authorize before job status, cancellation, or graph access.
7. Do not leak job existence across tenants.
8. Recover or mark abandoned jobs deterministically after backend restart.
9. Report partial completion truthfully.
10. Keep diagnostics safe and avoid leaking secrets.

---

# 12. Security and Tenant Isolation

Reuse existing Cartograph security patterns.

- Clerk authentication remains mandatory.
- Verify active organization membership.
- Verify repository ownership using the authoritative repository record, not only in-memory graph cache state.
- Verify the job belongs to the authorized repository and organization.
- Authorize before job lookup, progress streaming, cancellation, or graph snapshot access.
- Bind every job to repository ID, organization ID, and full commit SHA.
- Do not trust repository IDs, organization IDs, or job IDs supplied by clients without authorization.
- Do not expose GitHub tokens, service-role keys, or internal credentials.
- Enforce rate limits and request bounds.
- Do not execute repository source, install dependencies, or run project build commands.
- Keep RLS and service-role access rules intact.

---

# 13. Observability and Performance

Record useful job-level metrics:

- Repository ID and commit SHA (safe identifiers only).
- Ingestion mode.
- Eligible file count and bytes.
- Excluded file count and bytes.
- Downloaded bytes.
- Download and parse duration.
- Batch duration.
- Parser failures and timeouts.
- Resolver outcomes.
- Graph node and confirmed edge counts.
- Unresolved reference counts.
- Retry counts.
- Cache hit/miss and eviction where relevant.
- Peak memory or worker utilization where measurable.
- Job completion reason.

Do not log source secrets, tokens, or full sensitive file contents.

The implementation should be measurable. Do not claim a performance improvement without benchmark evidence.

---

# 14. Step 0 — Mandatory Architecture Inspection

**This is the first task for the coding agent. No implementation changes are authorized during Step 0.**

Inspect the current code and report the actual architecture.

## 14.1 Backend files and services to inspect

At minimum:

- `Backend/controllers/repositoryController.js`
- `Backend/controllers/graphController.js`
- `Backend/routes/graphRoutes.js`
- `Backend/services/github.js`
- `Backend/services/repositoryAuth.js`
- `Backend/services/parser/index.js`
- `Backend/services/parser/ParserService.js` (or actual equivalent)
- `Backend/services/parser/ParserScheduler.js`
- `Backend/services/parser/irBuilder.js`
- Existing retrieval functions such as `fetchGitBlob` and `parseRepositoryFiles`
- All language-specific parser adapters and resolvers
- `Backend/services/graph/GraphBuilder.js`
- `Backend/services/graph/GraphValidator.js`
- `Backend/services/graph/GraphQueryService.js`
- `Backend/services/graph/GraphSnapshotStore.js`
- `Backend/services/graph/graphPipeline.js`
- Existing database migrations and repository/job persistence patterns
- Existing middleware for authentication, authorization, rate limiting, request limits, and async errors
- Existing deployment configuration relevant to long-running work and streaming responses

Use the actual current paths if names differ.

## 14.2 Frontend files to inspect

At minimum:

- `Frontend/src/App.jsx`
- `Frontend/src/lib/api.js`
- `Frontend/src/components/DependencyMap.jsx`
- `Frontend/src/components/StatusBar.jsx`
- `Frontend/src/components/DetailPanel.jsx`
- Existing graph transformer and layout utilities
- Existing graph progress/loading components, if any
- Existing Clerk token and active organization context
- Existing frontend test setup

## 14.3 Questions the inspection must answer

### Current retrieval
1. Does retrieval use Git Tree + Git Blobs, archive download, or both?
2. What are the exact current byte and file limits?
3. Is source retrieval streamed or buffered in memory?
4. How is aggregate byte accounting enforced?
5. Can retrieval be resumed by file after a failure?
6. How are excluded files classified today?

### Parsing
7. Can ParserService process a batch of FileIR documents without changing existing behavior?
8. How are worker timeouts and worker termination implemented?
9. Can parser results be accumulated safely across batches?
10. How are partial parser diagnostics represented?

### Graph
11. Can GraphBuilder build a valid graph from a partial set of FileIR documents?
12. How are unresolved references represented when a target file has not yet been retrieved?
13. Can resolvers rerun when later batches introduce new target files?
14. How does GraphSnapshotStore represent active revisions?
15. How can a new immutable partial snapshot replace the currently published snapshot safely?
16. Does the existing five-dimensional cache key distinguish successive partial graph versions, or is a separate snapshot version required?
17. What prevents an older job from replacing a newer commit's graph?

### Background jobs and progress
18. Is there an existing background job mechanism?
19. Can the current backend deployment keep long-running work alive?
20. Is persistent job state available through existing Supabase/PostgreSQL tables?
21. Can SSE be supported by the current Express/deployment setup?
22. What authentication and tenant checks are needed for SSE reconnects?
23. What happens if the backend restarts during a job?

### Frontend
24. How does App.jsx currently initiate graph building?
25. Can the frontend receive incremental graph updates without resetting React Flow?
26. How are stale requests/events prevented from changing a new repository view?
27. How can progress UI remain visible while the graph is interactive?

## 14.4 Step 0 deliverable

Produce a detailed report with:

1. Current architecture and actual file paths.
2. Existing reusable services and APIs.
3. Current retrieval and parser limits.
4. Existing job/streaming capabilities.
5. Proposed ingestion job lifecycle.
6. Proposed progress API and SSE/polling strategy.
7. Proposed batch scheduler and file prioritization.
8. Proposed partial graph publication and cross-batch resolution strategy.
9. Resource limits requiring changes.
10. Database/schema changes, if any, with justification.
11. Security and tenant isolation considerations.
12. Risks, trade-offs, and unresolved questions.
13. A staged implementation plan with explicit approval gates.

**Do not edit source code, install dependencies, run migrations, alter environment variables, or change production systems during Step 0.**

Stop and request approval after the inspection report.

---

# 15. Proposed Implementation Gates After Step 0

These are proposed gates. The coding agent must refine them based on inspection and receive approval before implementation.

## Gate 11A — Ingestion Contract and Resource Policy

- Finalize eligible file classification.
- Finalize size/count thresholds.
- Define per-file, aggregate, compressed, extracted, memory, concurrency, timeout, and retry limits.
- Define job and progress schemas.
- Define partial/complete graph semantics.
- No production code until contract approval.

## Gate 11B — Job Lifecycle and Persistence

- Implement job creation, status transitions, idempotency, authorization, cancellation, and recovery.
- Reuse existing persistence patterns where possible.
- Avoid new queue infrastructure unless approved.
- Add focused job lifecycle tests.

## Gate 11C — Manifest Classification and Scheduling

- Compute eligible count and eligible source bytes from Git Tree metadata.
- Classify excluded entries without downloading content.
- Apply small/medium/large strategy.
- Implement deterministic file prioritization.
- Add bounded byte-aware batching.

## Gate 11D — Safe Retrieval and Parser Batching

- Reuse existing GitHub retrieval and parser services.
- Implement resumable batch processing.
- Enforce all resource budgets.
- Preserve blob SHA and content validation.
- Add retry and failure isolation.

## Gate 11E — Incremental Resolution and Graph Publication

- Accumulate FileIR facts per repository revision.
- Re-run relevant resolution as new files arrive.
- Preserve unresolved facts until resolvable.
- Build new immutable graph snapshots.
- Validate before publication.
- Keep partial and complete states explicit.
- Ensure canonical identities remain unchanged.

## Gate 11F — Real-Time Progress API

- Add authorized job status and progress endpoints.
- Add SSE or approved alternative.
- Support reconnect, replay, heartbeat, terminal close, cancellation, and tenant isolation.
- Add API and security tests.

## Gate 11G — Frontend Progress and Live Graph Updates

- Add the progress panel.
- Connect Build Graph to job creation and progress events.
- Show real file counts and phases.
- Display the initial graph as soon as available.
- Merge later graph updates by canonical ID.
- Animate new graph elements without full resets.
- Preserve selection and viewport where possible.
- Add frontend integration tests.

## Gate 11H — Reliability, Performance, and Acceptance

- Test small, medium, and large fixtures.
- Test failures, retries, cancellation, restart recovery, and repository switching.
- Test tenant isolation.
- Benchmark download, parsing, graph publication, memory, and frontend rendering.
- Run full backend and frontend regression suites.
- Document deployment requirements and limitations.

Stop after each gate and request approval before starting the next one.

---

# 16. Acceptance Criteria

The feature is not complete merely because a progress bar appears.

## Product acceptance

- Clicking Build Graph immediately shows a progress state.
- The progress panel uses actual backend data.
- Eligible file count and size determine the ingestion mode.
- Small repositories are processed completely in one job when within limits.
- Medium and large repositories start with an initial batch of up to 100 files.
- Later batches run automatically without file clicks.
- The initial validated graph becomes visible before all batches finish.
- New graph elements appear progressively.
- Progress distinguishes downloaded, parsed, failed, skipped, and remaining files.
- Media and excluded document contents are not downloaded.
- Their metadata remains available for repository exploration.
- The user can explore the graph while processing continues.
- Completion and partial failure are clearly distinguished.

## Correctness acceptance

- All data belongs to one immutable repository commit.
- Canonical node and edge IDs remain stable.
- No duplicate nodes or edges are created by repeated batch processing.
- No unconfirmed edge is displayed as confirmed.
- Cross-batch dependencies can become resolved when target files arrive.
- Partial graphs are never mislabeled as complete.
- Failed/skipped files remain visible in diagnostics.
- Older jobs cannot overwrite newer revision graphs.
- Graph snapshots are validated before publication.

## Security acceptance

- Every job operation is authenticated and tenant-authorized.
- Repository ownership is checked against authoritative persistent records.
- Job lookup and SSE access cannot leak cross-tenant data.
- Resource limits are enforced server-side.
- No repository code is executed.

## Verification acceptance

- Targeted tests for every gate pass.
- Full backend regression suite passes.
- Frontend tests, lint, and production build pass.
- Resource and performance tests are reported with actual measurements.
- No production migration or deployment action occurs without approval.

---

# 17. Strict Instructions to the AI Coding Agent

1. **Inspect before implementing.** Step 0 is read-only.
2. Treat this document as the product and architecture direction, not permission to change everything at once.
3. Reuse the existing Cartograph codebase and services.
4. Do not rewrite Phase 04, the parser system, or Phase 10 graph architecture wholesale.
5. Do not introduce new frameworks, microservices, Redis, Kafka, BullMQ, or other infrastructure without a concrete justification and approval.
6. Do not increase resource limits before measuring and documenting memory, disk, network, worker, and timeout implications.
7. Do not trust client-supplied repository ownership, commit SHA, FileIR, job state, or progress counts.
8. Do not execute repository code, install repository dependencies, or run repository build scripts.
9. Do not fabricate progress.
10. Do not create graph relationships in the frontend.
11. Do not mutate published immutable graph snapshots.
12. Do not mix repository revisions or tenants.
13. Do not deduplicate files by basename.
14. Do not discard unresolved facts simply because their targets have not arrived yet.
15. Do not start later gates without explicit approval.
16. If the existing architecture cannot safely support a requirement, stop and report the exact limitation and alternatives rather than introducing a parallel implementation.
17. In every completion report, distinguish:
    - Implemented and tested.
    - Implemented but not tested.
    - Not implemented.
    - Assumed but not verified.
    - Known limitations.
18. Provide actual command outputs and test counts. Never claim a test passed unless it was executed.

---

# 18. Immediate Next Action

**Begin with Gate 11 Step 0 only.**

Inspect the current Cartograph repository and produce the architecture report described in Section 14.

Do not modify any files yet.

The desired outcome is a concrete, repository-specific implementation plan for progressive ingestion and real-time graph generation that extends the existing Cartograph architecture safely.

Wait for explicit approval before Gate 11A or any code changes.
