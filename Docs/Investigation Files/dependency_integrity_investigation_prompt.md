# Cartograph — End-to-End Dependency Integrity Investigation

## Mission

Conduct a comprehensive, read-only technical investigation into Cartograph's repository hierarchy and dependency visualization problems.

The application currently exhibits three related problems:

1. Many files have dependencies in their source code, but corresponding edges are missing from the visualization.
2. Some displayed edges connect incorrect files or represent incorrect relationships.
3. Folder-level dependency connections are missing, incomplete, or incorrectly represented.

Determine the actual root causes across the complete dependency discovery and visualization pipeline. **Do not implement fixes during this investigation.**

The deliverable is an evidence-based engineering report identifying exactly where and why relationships are lost, incorrectly resolved, transformed, filtered, or rendered.

---

## 1. Existing architecture — preserve it

Cartograph is reported to use:

- React 19 + Vite + JSX and Tailwind CSS v3.
- React Flow and Dagre.
- Node.js + Express 5 with JavaScript.
- Supabase PostgreSQL and Storage.
- Clerk authentication.
- GitHub REST API and Git Tree API.
- FileIR as a normalized intermediate representation.
- Language-specific parsers and dependency resolvers.
- A canonical dependency graph.
- GraphBuilder, GraphValidator, GraphQueryService, and GraphSnapshotStore.
- A GitHub repository manifest for repository containment.

Reported language support: JavaScript/TypeScript, Python, Java, and C/C++.

Inspect the actual implementation. Do not assume this description is fully accurate.

### Architectural boundaries

**Repository hierarchy**
- Source of truth: GitHub repository manifest.
- Represents physical file and directory containment.
- Includes files that have no dependency relationships.

**Static dependency graph**
- Source of truth: verified parser and resolver output.
- Represents actual source-code relationships.
- Must not invent relationships.

**AI architecture interpretation**
- May explain verified relationships.
- May suggest potential relationships as hypotheses.
- Must not create authoritative static dependency edges.

Keep these responsibilities separate.

---

## 2. Strict investigation restrictions

This is a READ-ONLY investigation.

You MUST NOT:

- Modify application source code, SQL migrations, database schemas, parsers, resolvers, GraphBuilder, GraphValidator, backend API endpoints, or React Flow components.
- Change layout algorithms or introduce AI-based edge generation.
- Install dependencies or upgrade packages.
- Change project architecture.
- Commit or push changes.
- Reset, stash, clean, or overwrite the working tree.

Preserve all existing uncommitted work. The previously reported working tree contained 34 uncommitted paths. Inspect current Git status and record it, but do not change it.

The known file-to-file dependency-link issue was excluded from an earlier review. This investigation is specifically authorized to investigate dependency-link correctness end to end, including that issue. Do not implement a fix.

Do not repeat unrelated security, Docker, or Phase 11F.3 investigations.

---

## 3. Stage A — establish a reproducible baseline

Identify a representative public GitHub repository with:

- Multiple nested directories and source files.
- Cross-directory and relative imports.
- Index/barrel exports.
- Multiple supported languages where practical.
- Files without dependencies.
- Configuration files and non-source assets.
- Some unresolved or dynamic references.

Prefer a repository already tested by Cartograph, if available.

Record:

1. Repository URL and commit SHA.
2. Number of manifest entries and included files.
3. Number of parsed files.
4. Number of successfully resolved and unresolved references.
5. Number of canonical graph nodes and edges.
6. Number of edges returned by the backend API.
7. Number of edges received by the frontend.
8. Number of edges actually rendered.

Do not claim a relationship is missing until establishing that it exists in source code and is supported by the current parser/resolver contract.

---

## 4. Stage B — repository manifest integrity

Inspect the complete manifest pipeline.

Determine whether:

- Every expected directory and file is represented.
- Root-level and nested files are preserved.
- Paths are normalized consistently.
- Duplicate paths are prevented.
- Ignored files are classified correctly.
- Unsupported file types remain visible.
- Oversized files remain visible as excluded/unparsed entries where appropriate.
- Symlinks and submodules are handled consistently.

Compare the actual GitHub tree against Cartograph's normalized manifest.

Create a comparison table:

| Repository path | GitHub tree | Cartograph manifest | Result |
|---|---|---|---|

Determine whether frontend hierarchy is derived from the manifest or incorrectly reconstructed from dependency graph nodes. Do not confuse missing dependency edges with missing repository entries.

---

## 5. Stage C — parser extraction integrity

Inspect each language parser independently.

For every parser, determine:

1. Which dependency constructs it supports and does not support.
2. Whether references are extracted correctly.
3. Whether source locations are preserved.
4. Whether import specifiers are represented accurately.
5. Whether aliases, namespaces, packages, and relative paths are represented.
6. Whether dynamic imports are classified explicitly.
7. Whether unsupported syntax is silently ignored or reported.

Investigate these constructs:

### JavaScript/TypeScript
- Relative and absolute imports.
- Extensionless imports and index files.
- Named, default, and namespace imports.
- Re-exports and `export * from`.
- Dynamic `import()`.
- CommonJS `require()`.
- Type-only imports.
- Path aliases and package imports.
- JSON and asset imports.

### Python
- Relative and absolute imports.
- `import module` and `from module import symbol`.
- Package `__init__.py` and namespace packages.
- Package-relative imports.
- Dynamic imports and aliases.

### Java
- Package declarations and imports.
- Wildcard and static imports.
- Nested classes.
- Cross-package references.
- Inheritance and implementation references.

### C/C++
- Local and system header includes.
- Relative includes and include directories.
- Header guards and conditional compilation.
- Source-to-header relationships.
- Cross-file symbol references where supported.

Classify findings as correctly extracted, incorrectly extracted, unsupported, partially supported, or uncertain.

Do not treat every function call or textual identifier occurrence as a verified file dependency.

---

## 6. Stage D — dependency resolution integrity

A parser extracting `@/components/User` does not prove Cartograph correctly resolves it to a physical file.

Inspect every language-specific resolver.

Determine:

- How relative paths are resolved.
- How extensions are inferred.
- How index files are discovered.
- How aliases are loaded.
- Whether tsconfig/jsconfig configuration is considered.
- Whether package exports are handled.
- Whether Python package resolution follows package structure.
- Whether Java package names map correctly to source files.
- Whether C/C++ include paths are considered.
- How case sensitivity is handled.
- How ambiguous references are represented.
- How unresolved references are classified.

Investigate Windows versus POSIX path normalization.

For each reference, trace:

```text
Source file
    ↓
Extracted reference
    ↓
Resolution candidates
    ↓
Selected repository path
    ↓
Resolution confidence/status
```

Identify whether the resolver selects the wrong file, selects multiple files incorrectly, drops valid candidates, resolves external packages as internal files, treats unresolved references as resolved, or silently discards ambiguous references.

A failed resolution must remain explicitly unresolved. Never invent an edge to improve visualization completeness.

---

## 7. Stage E — canonical graph integrity

Inspect the complete pipeline from FileIR to canonical graph.

Review:

- FileIR dependency records.
- Relationship types.
- Source and target identifiers.
- File and symbol node identities.
- GraphBuilder and GraphValidator.
- Graph normalization and edge deduplication.
- Symbol ownership.
- File-level edge projection.
- Graph snapshot publication.

Investigate:

1. Correct parser output lost before GraphBuilder.
2. Resolved references not converted into graph edges.
3. Edge types rejected or filtered.
4. Inconsistent file and symbol identifiers.
5. Incorrect symbol ownership.
6. Incorrect edge deduplication.
7. Edges referencing absent nodes.
8. Discarded cross-directory edges.
9. Missing edges in graph snapshots.
10. Partial parsing presented as complete.

Trace every suspicious edge:

```text
Source code
  → Parser output
  → FileIR
  → Resolver output
  → GraphBuilder input
  → Canonical edge
  → Graph snapshot
```

Identify the exact stage where an edge first disappears or becomes incorrect.

---

## 8. Stage F — folder-level dependency aggregation

Investigate folder relationships separately from file relationships.

Folder dependencies must be derived from verified file-level relationships.

Example:

```text
Backend/controllers/UserController.js
    imports
Backend/services/UserService.js
```

May contribute to:

```text
Backend/controllers
    → Backend/services
```

Inspect whether Cartograph:

- Aggregates file dependencies into folder dependencies.
- Handles nested directories.
- Excludes self-folder edges.
- Avoids duplicate folder relationships.
- Preserves direction.
- Handles multiple file dependencies between the same folders.
- Handles bidirectional and cross-directory dependencies.
- Handles root-level files and files without dependencies.

Every folder dependency must have traceable underlying file-edge evidence.

Determine whether aggregation is missing, incorrectly derived from graph nodes, based only on currently expanded nodes, lost during API pagination, or incorrectly calculated in the frontend.

Parent-child containment edges and dependency edges must have different semantic types.

---

## 9. Stage G — backend API integrity

Inspect endpoints supplying:

- Repository manifest.
- File and symbol nodes.
- Dependency edges.
- Folder hierarchy.
- Graph snapshots.
- Paginated graph results.

Determine:

1. Whether all canonical graph edges are returned.
2. Whether pagination skips or duplicates edges.
3. Whether filters remove legitimate edge types.
4. Whether default limits are too restrictive.
5. Whether frontend requests use correct parameters.
6. Whether graph snapshots are stale.
7. Whether partial graph responses are identified.
8. Whether folder aggregation happens before or after pagination.
9. Whether API responses include enough metadata for debugging.

Compare canonical graph edge counts against backend responses. Provide evidence for discrepancies.

---

## 10. Stage H — frontend visualization integrity

Inspect the actual React Flow graph construction and rendering pipeline.

Review:

- `repositoryGraph.js`.
- `DependencyMap.jsx`.
- Related node and edge components.
- Graph data transformation.
- Folder expansion and collapse.
- Expand Level, Expand All, and Collapse All.
- Edge filtering and visibility.
- Graph layout inputs.

Determine:

1. Whether every returned node and edge is preserved.
2. Whether source and target IDs match actual React Flow node IDs.
3. Whether symbol edges are lifted to file endpoints correctly.
4. Whether collapsed folders hide edges incorrectly.
5. Whether expansion recreates edges correctly.
6. Whether edges disappear during expand/collapse.
7. Whether hidden nodes produce dangling edges.
8. Whether duplicate edge IDs exist.
9. Whether layout changes cause edges to disappear.
10. Whether edge filters remove valid dependencies.
11. Whether folder aggregation is mixed with ordinary file dependencies.

An edge referencing a node absent from the rendered node set must be reported explicitly.

Separate data-integrity failures from layout-quality problems. A poor layout is not evidence of a missing dependency.

---

## 11. Stage I — evidence matrix

Create one master evidence matrix.

| Test case | Manifest | Parser | Resolver | Canonical graph | API | UI | Result |
|---|---|---|---|---|---|---|---|
| Relative import | | | | | | | |
| Alias import | | | | | | | |
| Barrel export | | | | | | | |
| Dynamic import | | | | | | | |
| Python import | | | | | | | |
| Java import | | | | | | | |
| C/C++ include | | | | | | | |
| Cross-folder dependency | | | | | | | |
| Root-level dependency | | | | | | | |
| Folder aggregation | | | | | | | |
| Unresolved reference | | | | | | | |
| Paginated edge retrieval | | | | | | | |
| Collapsed folder edges | | | | | | | |

Use PASS, FAIL, PARTIAL, UNSUPPORTED, or NOT TESTED. Every FAIL must include evidence.

---

## 12. Stage J — root cause classification

Classify each confirmed issue:

A. Manifest discovery failure.  
B. Parser extraction failure.  
C. Dependency resolution failure.  
D. FileIR or normalization failure.  
E. Canonical graph construction failure.  
F. Graph validation or publication failure.  
G. Backend API or pagination failure.  
H. Frontend graph transformation failure.  
I. React Flow rendering failure.  
J. Folder dependency aggregation failure.  
K. Layout-only issue.  
L. Unsupported language or construct.

For each finding, provide:

- Severity.
- Affected language.
- Affected files/modules.
- Exact source file and function.
- Reproduction steps.
- Expected and actual behaviour.
- Root cause and evidence.
- Recommended fix.
- Whether the fix requires schema changes.

Rank issues by impact and dependency order.

---

## 13. AI feasibility assessment

Evaluate whether AI has a legitimate role in this pipeline.

Expected principles:

- AI must not generate authoritative dependency edges.
- AI must not replace parsers.
- AI must not invent file ownership.
- AI may explain verified dependencies.
- AI may summarize modules.
- AI may suggest possible relationships as unverified hypotheses.

Do not recommend AI merely because static analysis has limitations.

If dynamic relationships cannot be resolved statically, explain how Cartograph should represent them as unresolved or runtime-dependent.

---

## 14. Final deliverable

Create:

`Docs/dependency-integrity-investigation.md`

Use the repository's actual documentation directory if it differs.

The report must contain:

1. Executive summary.
2. Actual architecture map.
3. Reproducible test repository and commit SHA.
4. Manifest integrity findings.
5. Parser findings by language.
6. Resolver findings by language.
7. Canonical graph findings.
8. Folder aggregation findings.
9. Backend API findings.
10. Frontend rendering findings.
11. Evidence matrix.
12. Ranked root causes.
13. Recommended technical architecture.
14. Recommended implementation sequence.
15. AI feasibility assessment.
16. Tests actually executed.
17. Tests that could not be executed.
18. Known limitations.

Include a Mermaid diagram showing the actual implemented dependency pipeline and highlighting where verified relationships are lost or corrupted. Do not present an ideal architecture as if it were already implemented.

---

## 15. Final decision required

Answer clearly:

1. Are missing edges primarily caused by parser limitations, resolver failures, graph construction, API filtering, or frontend rendering?
2. Are incorrect file-to-file relationships caused by wrong resolution or wrong graph transformations?
3. Why are folder-level dependency edges missing?
4. Is repository hierarchy correctly sourced from the GitHub manifest?
5. Which languages have the weakest dependency coverage?
6. Which problems can be fixed without changing architecture?
7. Which issues require changes to FileIR, canonical graph contracts, or database schema?
8. Is AI needed for any part of authoritative dependency discovery?
9. What are the first three implementation tasks?
10. What should explicitly remain unchanged?

## Completion rule

Do not implement anything. Do not make speculative claims. Do not mark a stage verified without evidence.

The purpose is to identify the exact technical failure points so the next implementation phase fixes the real problem instead of introducing another layer of complexity.
