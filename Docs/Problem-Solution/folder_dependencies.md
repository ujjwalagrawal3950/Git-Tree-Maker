# Cartograph: Folder-Level Dependencies and Code-Relevant Folder Filtering

## Objective

Fix two repository-ingestion and visualization problems in Cartograph
through separate, independently verified steps:

1.  **Missing folder-level dependency connections:** The repository
    folder hierarchy appears correctly, but connections such as
    `Frontend → Backend` are missing from the architecture view.
2.  **Non-code-only folders:** Directories such as `docs/`,
    `claude-skills/`, `media/`, and similar branches appear even when
    they contain no analyzable code, adding workspace clutter and
    potentially unnecessary retrieval/download work.

Complete Step 1, report the results, and stop for review. Do not begin
Step 2 without explicit approval.

------------------------------------------------------------------------

## Existing architecture and constraints

Preserve the current Cartograph architecture:

-   Frontend: React 19, Vite, JSX, Tailwind CSS v3.
-   Visualization: React Flow (`@xyflow/react`) and existing
    Dagre/layout utilities.
-   Backend: Node.js and Express 5.
-   Persistence: Supabase PostgreSQL and Storage.
-   Authentication: Clerk.
-   Repository discovery: GitHub REST/Git APIs.
-   Existing parser, FileIR, graph builder, validator, query service,
    snapshot store, resolvers, and ingestion pipeline.

### Correctness rules

-   The repository manifest is authoritative for paths and containment.
-   Only validated, evidence-backed canonical file-level relationships
    may produce folder-level aggregate edges.
-   Never infer a dependency simply because two folders exist or their
    names suggest a relationship.
-   Preserve unresolved, ambiguous, conditional, unsupported, and
    partial states.
-   Do not misrepresent HTTP/API communication as a static import or
    function-call relationship.
-   Preserve provenance and traceability to canonical relationships.

### Strict restrictions

-   No migration to Next.js, Python, another database, or another
    framework.
-   Do not replace React Flow or introduce ELK or another layout engine.
-   No microservices, Kafka, Redis, Kubernetes, or unnecessary
    infrastructure.
-   Preserve FileIR v1.0.0 unless a change is proven essential and
    separately approved.
-   Preserve authentication, tenant isolation, ingestion
    fencing/idempotency, resource budgets, and security controls.
-   Preserve all existing uncommitted changes. Never reset, clean,
    stash, or discard them.
-   No unrelated refactoring or formatting churn.
-   Do not modify deferred Gate 11G frontend ingestion-progress UI.
-   Do not implement provenance-list optimization or dynamic API route
    extraction in this task.
-   Do not use external competitor repositories as implementation
    references.
-   Do not begin Step 2 until Step 1 is reviewed and explicitly
    approved.

------------------------------------------------------------------------

# Step 1 --- Fix folder-level dependency connections

## Problem

Cartograph correctly discovers and displays the folder hierarchy, but
the architecture view does not consistently show relationships between
folders/subsystems even when their contained files have valid
dependencies.

For example, a frontend file may have a statically supported
relationship with a backend-related file. The canonical file-level edge
should be aggregated into a visible `Frontend → Backend` folder-level
connection.

Do not assume the parser is the cause. The defect may occur during
parsing, resolution, canonical graph construction, validation, directory
aggregation, edge filtering, or rendering.

## 1A. Investigate before editing

First inspect `git status --short` and the current diff. Record the
existing uncommitted paths and preserve them.

Trace one known relationship through the actual current code:

1.  Repository manifest and file paths.
2.  Parser output / FileIR relationship records.
3.  Resolver output and canonical graph edges.
4.  Graph validation and publication.
5.  Directory/subsystem aggregation.
6.  `buildElements.js` or its current equivalent.
7.  `DependencyMap.jsx` or its current equivalent.
8.  Architecture Overview and Detailed view state.
9.  Cross-directory-only filter behavior.
10. React Flow edge visibility, rendering, and selection.

Answer these questions with evidence:

-   Does the canonical graph contain the expected file-level edge?
-   Are source and target paths normalized consistently?
-   Are paths mapped to the correct directory/subsystem nodes?
-   Is a valid edge removed by classification or filtering?
-   Does aggregation discard valid cross-directory edges?
-   Are same-directory edges intentionally omitted?
-   Are aggregate edge IDs stable and collision-safe?
-   Does Architecture Overview use the intended graph source?
-   Can selected aggregate edges resolve to their underlying canonical
    relationships?
-   Are nested folder paths aggregated at the correct subsystem
    boundary?

If the canonical file-level edge does not exist, determine whether the
current parser/resolver supports that relationship. Do not fabricate a
folder edge to hide a missing parser capability. Report that gap
separately.

## 1B. Implement the smallest correct fix

Implement only the defect demonstrated by the investigation.

Expected behavior:

-   Folder/subsystem connections are derived from validated canonical
    file-level edges.
-   Cross-directory edges are grouped using normalized source and target
    directory identities.
-   Multiple file-level edges between the same folder pair produce an
    aggregate edge with an accurate count.
-   Aggregate edges retain the underlying canonical relationship records
    or projections needed for provenance, including canonical IDs and
    evidence references.
-   Intra-directory relationships are not presented as cross-directory
    relationships.
-   Cross-directory-only filtering suppresses only intended
    intra-directory edges and does not alter node geometry or hierarchy.
-   Architecture Overview and Detailed mode retain their intended
    semantics.
-   Mode switching, search, folder expansion, and edge selection do not
    create stale or synthetic relationships.
-   Aggregate edge IDs are not passed to backend endpoints that expect
    canonical file-edge IDs.
-   Selecting an aggregate edge continues to expose its underlying
    canonical relationships through the existing provenance mechanism.
-   No duplicate, fabricated, or unsupported edges are introduced.

### Important: static dependencies versus HTTP communication

This task is only about displaying existing supported relationships at
folder level. It does **not** authorize new dynamic HTTP route analysis.

If a frontend uses `fetch`, Axios, or another HTTP client to call a
backend API, and the current canonical graph does not represent that
relationship, do not label it as an import or function call. Record it
as a separate future capability requiring its own design and approval.

## 1C. Focused regression tests

Add or update tests for the actual root cause. Cover at least:

1.  A valid file-level edge between different top-level folders produces
    a folder-level aggregate edge.
2.  Multiple file-level edges between the same folder pair produce one
    aggregate with the correct count and underlying records.
3.  An intra-folder edge does not become a cross-folder edge.
4.  Nested paths map to the intended folder/subsystem identities.
5.  Missing or unresolved relationships do not produce aggregate edges.
6.  Cross-directory-only filtering behaves correctly.
7.  Aggregate provenance retains canonical IDs and evidence references.
8.  Selecting an aggregate edge does not call a canonical-edge endpoint
    with a synthetic aggregate ID.
9.  Mode switching and folder expansion do not lose or duplicate edges.
10. Edge filtering does not change node geometry where that is the
    established behavior.

Run targeted tests and affected integration/build checks only. Do not
rerun every historical suite without a concrete reason.

## 1D. Acceptance criteria

Step 1 is complete only when:

-   The exact root cause and pipeline stage are documented.
-   The fix is minimal and does not weaken graph validation.
-   A known cross-folder dependency appears in Architecture Overview.
-   The aggregate count matches its underlying canonical relationships.
-   Provenance traces back to the correct canonical file-level edges.
-   Detailed mode still shows the underlying file-level relationships.
-   No false-positive folder connections are introduced.
-   Targeted tests pass.
-   The frontend build and directly affected backend checks pass.
-   Existing uncommitted changes and deferred work remain intact.

### Step 1 final report

Report:

-   Root cause.
-   Files changed and why.
-   Exact behavior before and after.
-   Tests executed and results.
-   Build/check results.
-   Remaining limitations.
-   Confirmation that unrelated files and deferred Gate 11G work were
    not modified.

**Stop after Step 1. Do not start Step 2.** Present the report for
review and wait for explicit approval.

------------------------------------------------------------------------

# Step 2 --- Exclude non-code-only folders (later; do not start yet)

This step must begin only after Step 1 has been reviewed and approved.

## Problem

Directories such as `docs/`, `claude-skills/`, `media/`, and other
documentation, image, video, font, generated-asset, or non-analyzable
branches can appear in the dependency workspace despite containing no
eligible source code. They add clutter and may cause unnecessary
retrieval/download work.

## Desired behavior

-   Determine whether a directory branch contains eligible analyzable
    source-code files.
-   Exclude branches containing no eligible code files from the
    dependency workspace.
-   Avoid downloading non-code content merely to decide whether it
    belongs in the code graph.
-   Preserve hierarchy for branches containing eligible code.
-   Keep parent folders when they contain eligible descendants.
-   Handle empty directories and non-code-only branches consistently.
-   Keep manifest summaries and filtering metadata accurate.
-   Preserve path safety, traversal limits, file-size limits, request
    budgets, and partial/truncated status semantics.

## Critical exception: required configuration and metadata

Do not blindly exclude every non-source file. Some configuration and
metadata files are needed for language detection, framework
identification, and dependency resolution. Inspect current support
before defining the policy. Potential examples include:

-   `package.json`
-   `tsconfig.json`
-   `jsconfig.json`
-   `pyproject.toml`
-   `requirements.txt`
-   `Cargo.toml`
-   `go.mod`
-   `pom.xml`
-   `build.gradle`
-   Framework/compiler configuration files
-   Lockfiles or project metadata when the current pipeline uses them

These files may need selective retrieval without automatically becoming
source-code graph nodes.

## Step 2 investigation and implementation requirements

1.  Inspect manifest filtering and selective-download policies.
2.  Identify eligible source files and required supporting metadata.
3.  Define explicit classifications: analyzable source, required
    configuration/metadata, ignored non-code, generated/vendor/build
    content, symlink, submodule, oversized, and unknown.
4.  Determine directory inclusion from eligible descendants, not
    directory names alone.
5.  Do not exclude a folder just because it is named `docs` or `media`
    if it contains eligible source code.
6.  Avoid downloading blobs just to determine extensions or paths; use
    Git tree metadata and path classification where possible.
7.  Preserve traversal and resource budgets.
8.  Test mixed-content folders, non-code-only folders, nested source
    files, required configuration, hidden directories, unknown
    extensions, and truncated manifests.
9.  Verify file counts, download counts, and workspace hierarchy on
    representative repositories.

## Step 2 acceptance criteria

-   Non-code-only branches do not appear in the dependency workspace.
-   A directory containing eligible code remains visible even if named
    `docs`, `media`, or similarly.
-   Required configuration files remain available to the stages that
    need them.
-   Unnecessary non-code blobs are not downloaded.
-   Mixed-content folders retain their code and required hierarchy.
-   Manifest and ingestion status remain accurate under traversal limits
    and truncation.
-   Security, tenant isolation, idempotency, and resource limits remain
    intact.
-   Focused tests and affected integration checks pass.

------------------------------------------------------------------------

# Detailed coding-agent prompt --- execute Step 1 only

You are working inside the existing Cartograph repository. Fix the
missing folder-level dependency connections described in Step 1 of this
specification.

Start by inspecting the current working tree and preserving every
existing user change. Trace one known cross-folder dependency from
parser output through canonical graph construction, aggregation, and
React Flow rendering. Identify the exact stage where a valid
relationship is lost. Do not assume the parser is at fault and do not
rewrite the architecture.

Implement the smallest evidence-backed correction. Folder-level
relationships must be derived exclusively from valid underlying
canonical file-level relationships. Preserve canonical IDs, evidence,
provenance navigation, aggregation counts, existing view modes,
filtering semantics, stable IDs, and layout behavior.

Do not invent relationships. Do not add dynamic HTTP route extraction.
Do not change FileIR v1.0.0. Do not modify manifest filtering for
non-code-only folders in this task. Do not optimize large provenance
lists. Do not modify Gate 11G. Do not perform unrelated refactoring.

Add focused regression tests for the discovered root cause and run only
affected tests and checks. Confirm that existing uncommitted changes
remain intact.

When complete, provide the root cause, files changed, behavior
before/after, tests and build results, remaining limitations, and
confirmation of scope preservation. Then stop and wait for review.

**Do not start Step 2 without explicit approval.**

------------------------------------------------------------------------

# Completion checklist

## Step 1

-   [ ] Existing working tree and uncommitted changes preserved.
-   [ ] One known relationship traced end to end.
-   [ ] Root cause proven.
-   [ ] Minimal fix implemented.
-   [ ] Folder-level aggregate edge is evidence-backed.
-   [ ] Underlying canonical relationships remain traceable.
-   [ ] Focused regression tests pass.
-   [ ] Affected build/checks pass.
-   [ ] Final report delivered.
-   [ ] Stop for user review.

## Step 2 (only after approval)

-   [ ] Source/configuration classification policy documented.
-   [ ] Non-code-only branches excluded.
-   [ ] Mixed-content branches retained.
-   [ ] Required configuration files preserved.
-   [ ] Unnecessary downloads avoided.
-   [ ] Resource budgets and manifest semantics preserved.
-   [ ] Focused regression tests pass.
-   [ ] Final report delivered.
