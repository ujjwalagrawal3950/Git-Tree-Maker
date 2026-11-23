# Cartograph Phase 11 --- Gate 11E

## Incremental Dependency Resolution & Versioned Graph Publication

**Status:** Authorized for implementation\
**Scope:** Gate 11E only\
**Prerequisite:** Gate 11D accepted for continued development\
**Stop condition:** Stop after Gate 11E, report results, and wait for
approval before Gate 11F.

------------------------------------------------------------------------

## 1. Objective

Connect the durable FileIR artifacts produced by Gate 11D to
Cartograph's existing dependency-resolution and graph-building
architecture.

The system must incrementally resolve dependencies across accumulated
repository state and publish versioned graph snapshots as ingestion
batches are successfully processed.

The central product requirement is:

> A small repository should be processed in one continuous ingestion run
> and produce its complete available dependency graph. Medium and large
> repositories should progressively publish graph updates as batches
> complete, without requiring users to click files or manually trigger
> additional downloads.

"Complete graph" means all eligible files have been processed and all
relationships supported by the existing static-analysis and resolver
capabilities have been represented. Unresolved, ambiguous, external,
unsupported, or partial relationships must remain explicit; do not
invent edges.

------------------------------------------------------------------------

## 2. Existing Architecture --- Preserve It

Reuse the existing components:

-   FileIR v1.0.0 and its validator.
-   Existing language adapters and parser infrastructure.
-   Existing language resolvers.
-   Existing `GraphBuilder` and `GraphValidator`.
-   Existing `GraphQueryService`.
-   Existing `GraphSnapshotStore`.
-   Existing repository authorization and tenant isolation.
-   Existing ingestion job manager, manifest scheduler, downloader, and
    batch parser.
-   Existing Supabase PostgreSQL and Storage integration.

Do not redesign or replace these components.

### Explicit prohibitions

-   Do not modify FileIR v1.0.0.
-   Do not migrate the backend to TypeScript or another framework.
-   Do not introduce microservices, Redis, Kafka, BullMQ, or another
    queue.
-   Do not redesign React Flow visualization.
-   Do not implement SSE or frontend progress UI in this gate.
-   Do not implement commit comparison, RAG, semantic search, or webhook
    refresh.
-   Do not change existing graph semantics without evidence of a
    concrete defect.
-   Do not execute repository source code.

If an existing component lacks a required capability, first explain the
gap and propose the smallest compatible extension. Do not silently
replace the component.

------------------------------------------------------------------------

## 3. Required Processing Flow

The intended pipeline is:

1.  A batch has been downloaded, parsed, validated, and committed as
    durable FileIR artifacts.
2.  The graph pipeline loads the committed FileIR artifacts for the
    current repository commit.
3.  The existing language resolvers resolve newly available and
    previously unresolved relationships against the accumulated
    repository state.
4.  The existing `GraphBuilder` constructs or updates the canonical
    graph.
5.  `GraphValidator` validates the resulting graph.
6.  A new immutable graph snapshot is persisted.
7.  The job's published graph version and batch progress are committed
    atomically in PostgreSQL.
8.  The next eligible ingestion batch can continue.

Do not publish a graph snapshot from uncommitted FileIR artifacts.

------------------------------------------------------------------------

## 4. Incremental Resolution Requirements

### 4.1 Accumulated repository state

Resolution must use the accumulated committed FileIR state for the
repository commit, not only the current batch.

When a new batch arrives:

-   Include FileIR from all previously committed batches.
-   Include FileIR from the current batch only after its durable commit
    succeeds.
-   Resolve newly available targets.
-   Revisit previously unresolved relationships that may now be
    resolvable.
-   Preserve unresolved and ambiguous relationships when evidence is
    insufficient.
-   Avoid creating duplicate edges when resolution is repeated.

### 4.2 Cross-batch examples

The implementation must handle cases such as:

-   Batch 1 contains `src/auth.js` importing `./user.js`, but `user.js`
    is not yet processed.
-   Batch 2 later adds `src/user.js`.
-   The resolver must revisit the relevant unresolved import and create
    the edge if the existing resolver can establish it.

Also cover:

-   Python module imports.
-   Java package/type references.
-   C/C++ header and include relationships.
-   Re-exports and symbol references supported by existing adapters.
-   References that remain external or unresolved.

Do not infer cross-language service/API relationships from similar names
alone.

### 4.3 Resolver boundaries

-   Reuse existing language-specific resolver behavior.
-   Preserve provenance and source locations.
-   Preserve confidence/resolution status fields already defined by the
    graph contract.
-   Do not create relationships unsupported by parser or resolver
    evidence.
-   Keep external and unresolved references explicit.
-   Ensure repeated resolution is deterministic and idempotent.

------------------------------------------------------------------------

## 5. Graph Construction and Validation

Use the existing `GraphBuilder` and `GraphValidator`.

Requirements:

-   Preserve canonical node and edge identities.
-   Preserve full relative file paths; never use basename as file
    identity.
-   Preserve edge provenance.
-   Avoid duplicate nodes and edges across batches.
-   Ensure newly resolved relationships connect to existing canonical
    nodes.
-   Preserve graph invariants and existing graph schema.
-   Validate each candidate graph before publication.
-   If validation fails, do not publish the invalid snapshot.
-   Record a useful job/batch error without corrupting the last valid
    snapshot.

### Overview graph

The initial repository overview must remain readable.

-   Use the existing file/module-level overview behavior.
-   Do not expose every symbol in the initial overview unless the
    existing graph-view contract explicitly requires it.
-   Symbol-level detail remains available through existing exploration
    queries.
-   Do not let a newly published batch reset or redesign the frontend
    layout; frontend integration is outside this gate.

------------------------------------------------------------------------

## 6. Versioned Graph Snapshot Publication

### 6.1 Snapshot versioning

Each successfully published graph snapshot must have a monotonically
increasing version scoped to the repository commit/job as defined by the
existing data model.

The publication metadata must identify at least:

-   Organization ID.
-   Repository ID.
-   Commit SHA.
-   Ingestion job ID.
-   Snapshot version.
-   Last committed/published batch.
-   Graph content checksum.
-   Creation timestamp.
-   Relevant graph schema/version metadata already supported by the
    implementation.

Do not invent a second competing version system if `GraphSnapshotStore`
or the ingestion job contract already provides one. Explain and reuse
the authoritative version fields.

### 6.2 Immutable snapshot artifacts

Persist snapshots immutably using the existing Supabase Storage and
database-pointer architecture.

Requirements:

-   Upload the immutable snapshot artifact before updating its
    authoritative database pointer.
-   Verify content integrity using a checksum.
-   Do not overwrite a previously published snapshot.
-   Treat the database pointer/version as authoritative.
-   If upload succeeds but the database transaction fails, leave a
    recoverable orphan candidate; do not delete an artifact that another
    worker may reuse.
-   Rehydration must verify checksum and expected
    repository/commit/version metadata.
-   Preserve the last valid published snapshot if a newer candidate
    fails.

### 6.3 Atomic publication

The database publication transaction must verify:

-   Job ID.
-   Repository and organization ownership.
-   Worker ID.
-   Current fencing token.
-   Valid worker lease.
-   Expected prior snapshot version.
-   Monotonic next snapshot version.
-   Expected batch progression.
-   Job is not cancelling or terminal.

The transaction must atomically update:

-   Authoritative snapshot pointer and version.
-   Published/committed batch metadata.
-   Job progress fields associated with publication.

If any guard or expected row count fails, roll back the complete
transaction.

A stale worker must never publish over a newer worker's snapshot.

### 6.4 Idempotency and retries

-   Retrying the same batch must not create duplicate graph nodes or
    edges.
-   Retrying publication of identical graph content must be safe.
-   A worker must not increment the snapshot version twice for the same
    committed batch.
-   A stale worker must not update the authoritative pointer.
-   Recovery must preserve the last valid published snapshot.
-   Repeated resolver execution must produce deterministic results.

------------------------------------------------------------------------

## 7. Small, Medium, and Large Repository Behavior

Use the existing Phase 11 repository classification policy. Do not
redefine thresholds in this gate.

Expected behavior:

### Small repositories

-   Process all eligible files in one continuous ingestion run.
-   Resolve dependencies using the complete committed FileIR set.
-   Publish a complete available graph when processing finishes.
-   The user must not need to click files or manually request additional
    batches.

### Medium repositories

-   Publish an initial useful graph after the first successful
    processing batch.
-   Continue processing subsequent batches automatically.
-   Re-resolve relationships as additional FileIR becomes available.
-   Publish newer graph versions without losing previous graph content.

### Large repositories

-   Keep download, parser, resolver, and graph work bounded.
-   Publish progressively.
-   Preserve the last valid snapshot during failures and recovery.
-   Do not hold the entire raw source repository in memory.
-   Use durable FileIR artifacts as the input to graph processing.

Batch publication must be automatic. File clicks and graph-neighborhood
exploration must never trigger ingestion or source downloads.

------------------------------------------------------------------------

## 8. Separation of Ingestion and Exploration

Maintain strict separation:

**Ingestion** - Reads committed FileIR. - Runs dependency resolution. -
Builds and validates graph candidates. - Persists versioned graph
snapshots. - Advances ingestion publication state.

**Exploration** - Reads an already published graph snapshot. - Uses
existing `GraphQueryService`. - Returns bounded neighborhoods or symbol
details. - Does not download source files. - Does not change job
scheduling or ingestion state. - Does not mutate graph snapshots.

Do not modify exploration endpoints unless a concrete integration defect
prevents the required behavior.

------------------------------------------------------------------------

## 9. Failure and Recovery

Handle at least these cases:

1.  Resolver fails on one language or file.
2.  A newly available target resolves a previously unresolved
    dependency.
3.  GraphBuilder fails.
4.  GraphValidator rejects a candidate graph.
5.  Snapshot Storage upload fails.
6.  Snapshot upload succeeds but database publication fails.
7.  Worker lease expires during graph construction.
8.  A newer worker reclaims the job while an older worker is still
    running.
9.  Worker crashes after snapshot upload but before pointer commit.
10. Worker restarts after one or more graph versions have already been
    published.
11. Cancellation occurs during resolution or publication.
12. The same batch or publication is retried.

Expected behavior:

-   Preserve the last valid published snapshot.
-   Reject stale worker publication through fencing and lease
    validation.
-   Never overwrite a newer snapshot.
-   Keep candidate artifacts immutable.
-   Do not synchronously delete a candidate merely because a worker
    loses its lease or a commit is rejected.
-   Treat unreferenced snapshot artifacts as deferred cleanup
    candidates.
-   Resume from durable committed/published state.
-   Make retries idempotent.

Do not implement a broad garbage-collection subsystem in this gate. If
cleanup is needed, document the safe deferred-cleanup contract and use
the existing storage lifecycle approach.

------------------------------------------------------------------------

## 10. Resource Limits and Performance

-   Reuse existing configured resource budgets.
-   Bound resolver concurrency where applicable.
-   Avoid loading all raw source files into memory.
-   Prefer loading committed FileIR artifacts in bounded groups.
-   Avoid rebuilding the entire graph from scratch after every small
    batch if the existing graph architecture supports safe incremental
    updates.
-   If the existing `GraphBuilder` requires a full accumulated FileIR
    set to produce a correct graph, use that approach initially and
    document its cost rather than introducing an unsafe partial merge.
-   Measure resolver duration, graph-build duration, snapshot size, and
    memory usage as operational telemetry.
-   Do not put nondeterministic timing values into canonical graph
    content or content hashes.

Correctness and deterministic graph output take priority over premature
optimization.

------------------------------------------------------------------------

## 11. Required Tests

Add focused tests for:

### Incremental resolution

1.  A dependency unresolved in batch 1 becomes resolved after its target
    arrives in batch 2.
2.  Existing committed FileIR is included when resolving a new batch.
3.  Repeated resolution does not duplicate edges.
4.  Unresolved and ambiguous references remain explicit.
5.  Cross-language resolution does not invent relationships.
6.  Existing language resolver behavior remains intact.

### Graph correctness

7.  Canonical node IDs remain stable across batches.
8.  Full file paths distinguish identical basenames in different
    directories.
9.  Edge provenance is preserved.
10. GraphValidator rejects invalid candidate graphs.
11. A failed candidate does not replace the last valid snapshot.
12. Overview graph remains at the intended file/module level.

### Snapshot publication

13. Snapshot versions increase monotonically.
14. Identical retries do not create duplicate versions.
15. Stale fencing tokens cannot publish.
16. Expired leases cannot publish.
17. Concurrent workers cannot overwrite a newer snapshot.
18. Snapshot checksum and metadata are verified during rehydration.
19. Storage upload success followed by DB failure leaves the prior
    pointer intact.
20. Worker recovery preserves the last valid published snapshot.
21. Cancellation prevents publication.
22. Previously published snapshots remain intact.

### End-to-end ingestion behavior

23. A small repository processes all eligible files in one continuous
    run.
24. A medium repository publishes progressively while later batches
    continue automatically.
25. A large repository remains within configured resource limits.
26. Clicking a file or requesting a neighborhood does not trigger
    ingestion or downloading.

Clearly distinguish unit tests, in-memory simulations, PostgreSQL
integration tests, and Supabase Storage integration tests.

------------------------------------------------------------------------

## 12. Scope Boundaries

Do not implement:

-   SSE progress streaming.
-   Frontend progress UI.
-   Frontend incremental graph merging.
-   React Flow layout redesign.
-   Commit comparison.
-   RAG or semantic search.
-   GitHub webhooks.
-   New infrastructure.
-   Production migrations or production configuration changes.

These are outside Gate 11E.

------------------------------------------------------------------------

## 13. Deliverables

Provide:

1.  Exact changed-file list.
2.  Explanation of incremental resolver behavior.
3.  Explanation of how previously unresolved dependencies are revisited.
4.  Graph versioning and publication data flow.
5.  Atomic transaction and fencing explanation.
6.  Snapshot persistence and recovery explanation.
7.  Small/medium/large repository behavior.
8.  Resource and performance measurements where available.
9.  Test commands and exact results.
10. Clear distinction between mocked and real integration tests.
11. Known limitations and unresolved risks.
12. Explicit recommendation: Gate 11E accepted or not accepted.

Do not claim real PostgreSQL or Supabase verification unless those
services were actually used.

**Stop after Gate 11E. Do not begin Gate 11F without explicit
approval.**
