# Cartograph Phase 10 --- Unified Dependency Graph Architecture & Implementation Blueprint

**Status:** Proposed --- Step 0 inspection only\
**Implementation approval:** Not granted\
**Objective:** Build a deterministic, language-neutral repository graph
from validated FileIR and resolver evidence.

## 1. Purpose

Phase 10 creates Cartograph's canonical backend dependency graph,
unifying outputs from the existing JavaScript/TypeScript, Python, Java,
C, and C++ parsers.

The graph becomes the source of truth for repository relationships.
FileIR remains the per-file syntax record; resolvers remain the source
of resolution evidence; React Flow is only a visualization layer.

The graph must never convert unresolved, ambiguous, unsupported, or
unverified references into confirmed edges.

## 2. Existing architecture to preserve

Verify all details against the current repository before implementation.
Current project context:

-   Frontend: React 19, Vite, JSX, Tailwind CSS v3.
-   Backend: Node.js, Express 5, JavaScript.
-   Parser pipeline: ParserService, ParserRegistry, ParserScheduler,
    language adapters, FileIR builder and validator.
-   FileIR contract: v1.0.0.
-   Languages: JavaScript/TypeScript, Python, Java, C, C++.
-   Resolvers: JavaScript/TypeScript modules, Python imports, Java
    imports, C/C++ includes.
-   Graph visualization: React Flow, with Dagre used for layout.

### Non-negotiable constraints

1.  Preserve FileIR v1.0.0. Schema changes require separate approval.
2.  Keep graph construction in the existing Node.js backend.
3.  Do not introduce microservices, a graph database, or a backend
    migration without approval.
4.  React Flow must not become the canonical graph store.
5.  Never execute repository code, compilers, or build scripts.
6.  Never infer confirmed relationships from names or path similarity
    alone.
7.  Preserve unresolved, ambiguous, unsupported, and partial evidence.
8.  Do not rewrite completed parsers without a concrete integration
    defect.
9.  No database migrations or production data changes without an
    approved plan.
10. Graph output must be deterministic for fixed inputs and tool
    versions.

## 3. Goals and non-goals

### Goals

-   Canonical, language-neutral graph model.
-   Stable file and symbol node identities.
-   Typed edges with evidence provenance.
-   Separation of syntax facts, resolver evidence, and graph
    conclusions.
-   File-level and symbol-level relationships.
-   Deterministic construction, deduplication, and serialization.
-   Incoming/outgoing and bounded neighborhood queries.
-   Explicit unresolved and ambiguous references.
-   Graph validation and integrity checks.
-   Backend APIs suitable for later visualization and impact analysis.

### Not in Phase 10

-   RAG assistant or natural-language code chat.
-   Impact scoring or blast-radius ranking beyond basic graph traversal.
-   Commit comparison, webhooks, or proactive refresh.
-   Runtime tracing or dynamic call graphs.
-   Compiler-grade type checking, overload resolution, or template
    instantiation.
-   Cross-language service/API inference without explicit evidence.
-   Neo4j or a separate graph service.
-   A full React Flow redesign.
-   Automatic code modification.

## 4. Architecture

``` text
Repository Revision
        |
Manifest + Retrieved Files
        |
Validated per-file FileIR
        |
        +-------------------------+
        |                         |
Resolver Outputs            Parser Diagnostics
        |                         |
        +------------+------------+
                     |
            Evidence Normalization
                     |
              Canonical Builder
                     |
               Graph Validator
                     |
           Immutable Graph Snapshot
                     |
             Graph Query Service
                     |
            Authorized Graph API
                     |
             Frontend / React Flow
```

**FileIR:** per-file syntax facts and diagnostics.\
**Resolvers:** language-specific resolution evidence.\
**Evidence normalizer:** maps language-specific results into a common
evidence contract.\
**Graph builder:** creates nodes and confirmed edges from validated
evidence.\
**Validator:** enforces identity, provenance, revision, and referential
integrity.\
**Query service:** performs indexed incoming/outgoing and bounded
traversal queries.\
**Frontend:** renders graph data; it does not define graph semantics.

## 5. Canonical graph model

The exact contract must be reconciled with actual FileIR, resolver
outputs, and existing API conventions.

### 5.1 Snapshot

A graph snapshot should be tied to:

-   Repository identity.
-   Immutable commit SHA.
-   Graph schema version.
-   Graph builder version.
-   FileIR version.
-   Parser and resolver versions.
-   Manifest/source set used to build it.
-   Completeness status and diagnostics.

Illustrative shape:

``` json
{
  "schemaVersion": "1.0.0",
  "graphId": "deterministic-revision-builder-id",
  "repository": {"repositoryId": "stable-id"},
  "revision": {"commitSha": "immutable-sha"},
  "builder": {"version": "1.0.0", "fileIrVersion": "1.0.0"},
  "nodes": [],
  "edges": [],
  "unresolvedReferences": [],
  "diagnostics": [],
  "statistics": {}
}
```

Do not copy this example without checking actual repository identity and
API models.

### 5.2 Node types

  ------------------------------------------------------------------------
  Type                    Meaning                  Identity
  ----------------------- ------------------------ -----------------------
  `file`                  File at a specific       Repository + commit +
                          repository revision      normalized path

  `symbol`                Declaration/definition   File/revision + stable
                          from FileIR              symbol identity

  `module` / `package`    Language module/package  Repository/revision +
                          when supported by        language-qualified name
                          evidence                 

  `external`              External package or      Ecosystem/language +
                          standard-library target  canonical identity
  ------------------------------------------------------------------------

Do not create nodes merely because a resolver returns an arbitrary
string. External nodes require sufficiently specific evidence.

### 5.3 Identity rules

**File ID:** repository identity + commit SHA + normalized
repository-relative path.

**Symbol ID:** owning file identity + FileIR symbol ID or deterministic
symbol locator.

Never use display names alone. Same-named symbols in different
files/namespaces and overloaded functions must remain distinct. Scope
FileIR IDs to a file and revision if they are not globally stable.

### 5.4 Edge types

Candidate taxonomy:

  -----------------------------------------------------------------------
  Edge                    Meaning                 Evidence
  ----------------------- ----------------------- -----------------------
  `imports`               Module/file imports     Resolved import
                          another module/file     

  `includes`              C/C++ file includes a   Resolved include
                          header                  

  `calls`                 Call site targets a     Resolved call evidence
                          symbol                  

  `inherits`              Type extends/implements Resolved inheritance
                          another type            

  `references_type`       Source uses a target    Resolved type reference
                          type                    

  `contains` / `declares` File/module owns a      FileIR ownership
                          symbol                  

  `defines`               File contains a         Explicit definition
                          definition              evidence

  `reexports`             Module re-exports       Explicit export
                          another entity          evidence
  -----------------------------------------------------------------------

Approve the final taxonomy only after inspecting actual resolver and
FileIR structures. Avoid redundant edge types.

### 5.5 Provenance

Every confirmed edge must reference its supporting evidence, including
where available:

-   Repository revision.
-   Source file and FileIR identity.
-   Fact collection and stable fact locator.
-   Source location.
-   Resolver name/version.
-   Resolution rule and status.
-   Candidate paths/symbols where relevant.

Do not invent fact IDs. If FileIR has no fact ID, define a deterministic
locator scoped to the FileIR, such as collection plus stable
index/source span.

Structural ownership edges must also be traceable to a validated FileIR
symbol-parent or file-ownership fact.

## 6. Syntax facts versus graph edges

Example source:

``` javascript
import { calculateTotal } from "./billing.js";
```

This proves the import syntax exists. It does not prove the target file.

Only after a resolver uniquely maps the import to a repository target
may the graph builder create a confirmed `imports` edge.

Rules:

-   `resolved`: create an edge only when the resolver's status and
    evidence satisfy the approved contract.
-   `unresolved`: retain in unresolved references; no confirmed edge.
-   `ambiguous`: preserve all candidates; do not select one.
-   `not_attempted`: no confirmed edge.
-   `unsupported`: preserve limitation/diagnostic; no inferred edge.
-   `partial`: only use individually valid facts with sufficient
    resolution evidence.
-   `external`: create an external node/edge only when classification is
    supported and the graph model includes it.

Never upgrade uncertain statuses to confirmed edges.

## 7. File-level and symbol-level graph

Use two conceptual graph views over one canonical model.

### File-level graph

Represents resolved imports/includes and other file dependencies. Use
for repository overview and basic dependency navigation.

### Symbol-level graph

Represents resolved calls, inheritance, type references, and symbol
relationships. Use for detailed code exploration and future impact
analysis.

### Ownership

Choose one canonical ownership representation: explicit
`contains`/`declares` edges, or an authoritative `ownerId`/`fileId`
relationship projected into query edges. Do not maintain conflicting
duplicates.

### Avoid graph explosion

-   Do not create nodes for every identifier occurrence.
-   Do not create call edges for unresolved targets.
-   Do not expand wildcard imports into all possible symbols.
-   Do not instantiate templates.
-   Do not turn every include into symbol-level dependencies.
-   Keep occurrence-level facts in evidence, separate from aggregated
    graph edges.

## 8. Language-specific normalization

Normalize common concepts without erasing language semantics.

**JavaScript/TypeScript** - Preserve ESM, CommonJS, dynamic import, and
re-export distinctions. - Package imports remain external unless
workspace evidence identifies an internal package.

**Python** - Preserve absolute/relative imports. - Preserve ambiguity
where `from package import name` may refer to a submodule or
attribute. - Keep `.pyi` typing-stub relationships distinct from runtime
modules.

**Java** - Preserve Java SE, JDK-specific/internal, Java EE/Jakarta EE,
third-party, and unresolved classifications. - Preserve nested type
identity. - Do not invent method overload targets.

**C** - Preserve include semantics, C tag/type namespaces, typedef
distinctions, and declaration/definition evidence. - An include does not
prove every included declaration is used.

**C++** - Preserve namespaces, nested types, templates, and overload
identity. - Do not claim overload resolution without sufficient
evidence. - Do not associate header declarations and source definitions
by matching names alone.

## 9. Deterministic graph-building algorithm

1.  Validate repository identity, immutable revision, and manifest.
2.  Load FileIR documents for that exact revision.
3.  Validate every FileIR against the existing schema.
4.  Normalize repository paths.
5.  Create file nodes for eligible manifest files.
6.  Create symbol nodes from validated symbols.
7.  Create ownership relationships from explicit facts.
8.  Normalize resolver outputs into common evidence records.
9.  Validate each target against the same repository revision.
10. Create confirmed edges only for approved successful statuses.
11. Preserve unresolved, ambiguous, external, unsupported, and partial
    references separately.
12. Deduplicate logical edges and aggregate supporting evidence.
13. Validate graph integrity.
14. Calculate statistics and completeness.
15. Serialize the snapshot canonically.

For identical repository revision, manifest, FileIR, resolver outputs,
and builder versions, repeated builds must produce the same logical
graph and stable IDs.

Do not use random UUIDs, timestamps, filesystem enumeration order, or
asynchronous completion order for graph identity. Timestamps may be
metadata but must not affect semantic equality.

## 10. Deduplication

Recommended default: one logical edge per
`(sourceNodeId, targetNodeId, edgeType, semanticQualifier)` with an
ordered evidence collection.

Do not merge semantically distinct relationships merely because their
endpoints match. For example, `imports` and `includes` remain different
edge types.

Define stable edge IDs and deterministic evidence ordering. Multiple
call sites may support one aggregated `calls` edge, while retaining each
call-site location as evidence.

## 11. Graph validation

Detect or reject:

-   Duplicate node IDs with conflicting content.
-   Duplicate edge IDs with conflicting endpoints/types.
-   Edges referencing missing nodes.
-   Missing edge provenance.
-   Edges derived from unresolved or ambiguous facts.
-   Cross-revision references.
-   Invalid or escaping repository paths.
-   Unsupported edge types.
-   Invalid source locations.
-   Conflicting symbol ownership.
-   Inconsistent graph version metadata.

Distinguish fatal graph corruption from recoverable analysis
diagnostics. A partial parse may produce a valid partial graph if
completeness and diagnostics are explicit.

## 12. Query service

Minimum capabilities:

-   Snapshot metadata and statistics.
-   Paginated node listing and node detail.
-   Incoming and outgoing edges.
-   Direct neighbors.
-   Bounded N-hop neighborhood.
-   Filters by edge type, node type, language, and status.
-   Edge evidence/provenance.
-   Unresolved and ambiguous reference listing.
-   Bounded subgraphs for a file or symbol.

Performance and safety:

-   Index nodes by ID.
-   Maintain adjacency indexes for incoming and outgoing edges.
-   Enforce maximum response nodes/edges and traversal depth.
-   Avoid unbounded recursion.
-   Paginate large results.
-   Authorize every query against the repository and organization.
-   Verify graph/revision ownership; never trust a client-supplied graph
    ID by itself.

## 13. Persistence decision

Do not introduce a graph database in this phase.

Inspect and compare:

1.  Versioned JSON graph artifact in existing object storage, with
    metadata in the relational database.
2.  Normalized graph nodes/edges in relational tables.
3.  On-demand graph construction from stored FileIR/resolver results.

Compare: - Snapshot size and query patterns. - Rebuild cost and
caching. - Revision/version invalidation. - Tenant isolation. - Atomic
publication of complete snapshots. - Repository deletion cleanup. -
Storage and operational complexity.

Do not create migrations, buckets, or production changes before
approval.

## 14. API proposal

Route names must follow existing Express conventions.

  --------------------------------------------------------------------------------------------------------
  Proposed endpoint                                                    Purpose
  -------------------------------------------------------------------- -----------------------------------
  `POST /api/repositories/:repositoryId/graph/build`                   Build/request graph for verified
                                                                       revision

  `GET /api/repositories/:repositoryId/graph`                          Snapshot metadata/summary

  `GET /api/repositories/:repositoryId/graph/nodes`                    Paginated nodes

  `GET /api/repositories/:repositoryId/graph/nodes/:nodeId`            Node details

  `GET /api/repositories/:repositoryId/graph/nodes/:nodeId/outgoing`   Outgoing edges

  `GET /api/repositories/:repositoryId/graph/nodes/:nodeId/incoming`   Incoming edges

  `GET /api/repositories/:repositoryId/graph/neighborhood`             Bounded neighborhood

  `GET /api/repositories/:repositoryId/graph/edges/:edgeId/evidence`   Provenance

  `GET /api/repositories/:repositoryId/graph/unresolved`               Unresolved/ambiguous references
  --------------------------------------------------------------------------------------------------------

Every endpoint must authenticate, enforce existing
organization/repository authorization, validate limits, scope data to
the authorized repository, and return safe structured errors.

## 15. Frontend integration

React Flow may render backend nodes/edges, apply Dagre layout, support
pan/zoom/selection, request bounded subgraphs, and display evidence.

React Flow must not generate canonical IDs, decide dependency truth,
resolve imports, persist authoritative graph state, or infer edges from
labels or visual proximity.

Backend graph semantics remain authoritative; frontend state is
presentation state.

## 16. Security and resource controls

-   Reuse existing repository and organization authorization.
-   No source execution or compiler/build subprocesses.
-   Bound graph size, construction concurrency, response size, and
    traversal depth.
-   Normalize and validate repository paths.
-   Prevent cross-revision and cross-tenant references.
-   Avoid unbounded recursion and graph traversal.
-   Publish snapshots atomically; never expose partially written
    authoritative snapshots as complete.
-   Ensure repository deletion and access revocation apply to graph
    artifacts.
-   Do not leak absolute host paths, secrets, or private repository data
    in diagnostics.

## 17. Testing strategy

### Unit tests

-   File and symbol identity stability.
-   Edge identity and deterministic deduplication.
-   Evidence normalization per language.
-   Confirmed versus unresolved/ambiguous handling.
-   FileIR-to-node mapping and ownership.
-   Graph validator failures.
-   Statistics and completeness.

### Cross-language integration fixture

Build a small repository containing: - JavaScript imports. - TypeScript
type/value imports. - Python absolute and relative imports. - Java
package/type imports. - C source and local header. - C++ source and
project header. - Same-named files/symbols across languages. - Duplicate
candidates. - Unresolved and ambiguous references. - Partial FileIR.

Verify identity uniqueness and provenance for every confirmed edge.

### Determinism

-   Build identical input twice and compare canonical serialization.
-   Vary input file ordering.
-   Vary asynchronous completion order.
-   Verify stable IDs and evidence ordering.
-   Verify builder version is recorded.

### Security/tenancy

-   Cross-organization reads are denied.
-   Node/edge queries cannot escape repository scope.
-   Invalid graph IDs are rejected.
-   Traversal and response limits are enforced.
-   Graph build requests are authorized and appropriately rate-limited.

### Regression

-   Existing parser/resolver tests remain green.
-   Existing security, RLS, webhook, GitHub retrieval, and tenant
    isolation tests remain green.
-   Full backend suite and frontend production build pass.

## 18. Performance and scale

Inspect real repository sizes and persistence patterns before setting
final limits.

Design for: - O(1)-style node lookup by ID using maps/indexes. -
Efficient incoming/outgoing adjacency lookup. - Bounded graph
construction. - Pagination and subgraph responses. - Cache reuse only
when commit SHA, manifest, FileIR, resolver, and builder versions match
exactly. - Clear handling for unusually large repositories.

Do not introduce distributed graph processing or a graph database before
measurement demonstrates the need.

## 19. Step 0 --- targeted architecture inspection

The coding agent must inspect only:

1.  Actual FileIR schema and emitted output shapes from every adapter.
2.  Resolver output shapes, statuses, candidate fields, and provenance
    fields.
3.  Repository identity, commit SHA, manifest, and file record models.
4.  Parser orchestration and how FileIR documents are stored/retrieved.
5.  Existing graph-related backend/frontend code, React Flow contracts,
    and Dagre integration.
6.  Database and object storage capabilities relevant to graph
    persistence.
7.  API route conventions, authentication, organization authorization,
    rate limits, and response envelopes.
8.  Test patterns and fixture utilities.
9.  Stability of FileIR and symbol IDs across repeated parses of one
    immutable revision.
10. Missing provenance facts needed for safe graph construction.
11. Persistence options without creating tables, buckets, or migrations.
12. Proposed graph schema, edge taxonomy, identity, builder, query API,
    and implementation sequence.

### Required Step 0 deliverables

Produce an architecture decision record with:

-   Current-state findings grounded in actual code.
-   FileIR/resolver compatibility matrix by language.
-   Canonical node and edge model.
-   Node/edge identity strategy.
-   Evidence/provenance model.
-   Syntax-versus-resolution rules.
-   File-level versus symbol-level strategy.
-   Deduplication/aggregation policy.
-   Graph validation rules.
-   Persistence comparison and recommendation.
-   Proposed API routes and authorization requirements.
-   Frontend integration boundary.
-   Performance/security risks.
-   Exact file-by-file implementation plan.
-   Test plan and acceptance criteria.
-   Decisions requiring approval.

### Prohibited during Step 0

-   No source edits.
-   No dependency installation/removal.
-   No package or lockfile changes.
-   No database migrations or storage bucket changes.
-   No production data changes.
-   No frontend graph rewrite.
-   No graph builder or API implementation.
-   No FileIR schema changes.

If something cannot be verified, mark it unverified and propose a safe
way to check it. Do not guess.

## 20. Proposed implementation gates

  -----------------------------------------------------------------------
  Gate                    Workstream              Deliverable
  ----------------------- ----------------------- -----------------------
  10A                     Architecture and graph  Approved graph model
                          contract                and decision record

  10B                     Canonical identities    Stable identities and
                          and evidence            normalized evidence
                          normalization           

  10C                     Graph builder and       Deterministic snapshot
                          validator               with provenance

  10D                     Graph query service     Incoming/outgoing and
                                                  bounded neighborhood
                                                  queries

  10E                     Persistence and API     Approved storage model
                                                  and authorized
                                                  endpoints

  10F                     Frontend integration    React Flow renders
                                                  backend graph

  10G                     Hardening and           Determinism, scale,
                          regression              tenancy, regression
                                                  verification
  -----------------------------------------------------------------------

Each gate requires review before moving forward. Database migrations,
persistence changes, and dependency additions require explicit approval.

## 21. Acceptance criteria

Phase 10 is complete only when:

1.  The graph model is language-neutral and versioned.
2.  File and symbol IDs are deterministic and collision-resistant.
3.  Confirmed edges require sufficient resolution evidence.
4.  Every confirmed edge has traceable provenance.
5.  Unresolved, ambiguous, unsupported, and partial evidence remains
    explicit.
6.  File-level and symbol-level relationships are modeled without graph
    explosion.
7.  Logical edge deduplication is deterministic and preserves distinct
    semantics.
8.  Validation catches missing nodes, invalid edges, missing provenance,
    and cross-revision references.
9.  Identical inputs produce identical logical snapshots.
10. Incoming/outgoing and bounded neighborhood queries are efficient and
    authorization-safe.
11. Frontend renders backend graph data without owning graph semantics.
12. Existing parser, resolver, security, and retrieval tests remain
    green.
13. Backend tests and frontend production build pass.
14. Persistence and deployment limitations are documented honestly.

## 22. Approval request

The coding agent must stop after Step 0 and request approval. Its report
must answer:

1.  What is the smallest canonical graph model that meets current
    product requirements?
2.  Which current FileIR and resolver facts can safely create confirmed
    edges?
3.  Which relationships must remain unresolved pending later semantic
    analysis?
4.  Should graph snapshots be built on demand, stored as JSON artifacts,
    or normalized into relational tables?
5.  What APIs are required for initial frontend integration?
6.  What exact files and tests would change in Gate 10B?
7.  Are schema changes, migrations, or dependencies required?
8.  What are the main performance and tenant-isolation risks?

**Stop after Step 0. Do not implement Phase 10 until the architecture
report has been reviewed and explicitly approved.**
