# Cartograph — Dependency Integrity and Visualization Remediation

## Mission

You are working in the existing Cartograph repository. Your task is to investigate and remediate the dependency-integrity problems described below so that the repository graph is complete, semantically defensible, and visually understandable.

The goal is **not** to maximize the number of edges. The goal is to represent only relationships supported by repository evidence, preserve uncertainty explicitly, and ensure the graph does not silently lose valid relationships during ingestion, graph construction, aggregation, or rendering.

Work incrementally. First inspect the current implementation and the working tree. Confirm each reported issue against the actual code before changing it. Then implement the verified fixes in the stages below, with focused tests. Do not assume the executive diagnosis is correct merely because it is listed here.

---

## 1. Non-negotiable project constraints

1. Preserve the current architecture and technology choices:
   - Frontend: React 19, Vite, JSX, Tailwind CSS v3.
   - Graph UI: React Flow and the existing layout utilities.
   - Backend: Node.js, Express 5, JavaScript.
   - Persistence: existing Supabase/PostgreSQL and Storage design.
   - Existing parsers, FileIR, resolvers, GraphBuilder, GraphValidator, GraphQueryService, GraphSnapshotStore, and ingestion pipeline.
2. Do not migrate frameworks, languages, databases, or infrastructure.
3. Do not introduce microservices, queues, Redis, Kafka, Kubernetes, or other infrastructure unless a verified requirement makes it unavoidable and approval is obtained.
4. Preserve FileIR v1.0.0 compatibility unless a schema change is proven necessary. Prefer additive internal metadata or resolver behavior where possible.
5. Keep the manifest, canonical static dependency graph, and AI-generated conceptual explanations as separate trust layers:
   - The manifest is authoritative for repository paths and file presence.
   - Parsers and resolvers establish statically supported code relationships.
   - The canonical graph stores validated static relationships.
   - AI explanations must never invent or silently add canonical graph edges.
6. Do not infer symbol ownership from names alone. Do not create edges merely because two paths or symbols look related.
7. Preserve explicit unresolved, ambiguous, conditional, unsupported, and partial states. Never silently convert uncertainty into certainty.
8. Preserve existing user changes and uncommitted work. Do not reset, clean, stash, overwrite, or revert unrelated changes.
9. Do not weaken authentication, authorization, tenant isolation, resource budgets, ingestion fencing, idempotency, or existing security controls.
10. Do not modify the deferred Gate 11G frontend ingestion-progress experience. This task concerns dependency integrity and graph visualization only; it does not authorize ingestion-progress panels, SSE UI, or unrelated ingestion UX work.
11. Do not make unrelated refactors or broad redesigns. Keep changes focused and explain every touched subsystem.
12. Do not claim tests passed unless they were actually run. Report skipped tests and environmental limitations honestly.

---

## 2. Problem statement

The current dependency visualization may omit valid relationships, create misleading relationships, hide relationships when folders are collapsed, or render edges in a way that obscures the graph.

The reported findings are hypotheses to verify:

### A. Missing source-code dependencies

**A1. Re-exports may be omitted**

Reported locations:
- `graphPipeline.js` around line 127.
- `IncrementalGraphPublisher.js` around line 254.

Reported behavior: graph construction iterates over `fileIr.imports` but does not process `fileIr.exports`. This may omit relationships expressed through:
- `export * from './Button'`
- `export { Header } from './Header'`
- `export { default } from './Component'`
- equivalent supported re-export forms.

Verify the actual FileIR representation and parser output before implementing. Ensure the implementation handles only re-export forms that the current parsers actually capture. Do not invent unsupported export semantics.

**A2. TypeScript path aliases may fail to resolve**

Reported locations:
- `graphPipeline.js` around line 117.
- `IncrementalGraphPublisher.js` around line 242.

Reported behavior: `JavaScriptModuleResolver` is instantiated without supporting configuration files such as `tsconfig.json`. Imports using aliases such as `@/components/Button` may be classified as external or unresolved, even when the repository contains a valid internal target.

Verify:
- How `tsconfig.json` is represented in the manifest and retrieved content.
- Whether the resolver currently accepts supporting files or parsed compiler options.
- Whether `baseUrl`, `paths`, `extends`, and multiple tsconfig files are supported.
- Whether the incremental and non-incremental pipelines use equivalent resolution behavior.

Implement only configuration semantics that can be supported reliably. If a configuration cannot be loaded or interpreted, preserve an explicit unresolved/unsupported status and diagnostic rather than guessing.

**A3. Valid targets outside the parsed FileIR set may be rejected**

Reported location:
- `GraphBuilder.js` around line 258.

Reported behavior: `internalFilePathSet` is built only from `fileIRList`. This can reject valid repository targets that exist in the manifest but are not source files in the current parser batch, including assets, stylesheets, JSON/configuration files, documentation, skipped files, or files not selected for parsing.

Verify the current graph contract and edge types. The manifest must remain the authority for repository path existence. However, do not treat every manifest file as a valid source-code dependency target automatically. Distinguish:
- A path that exists in the repository.
- A path that was retrieved.
- A path that was parsed.
- A path that is a valid target for a particular dependency type.
- A path that is currently unresolved because it was excluded, unsupported, or not yet processed.

Preserve useful asset/config/style import edges where the parser and resolver establish them. Do not create false symbol-level or source-code edges to arbitrary manifest files.

**A4. Java wildcard package imports may be discarded**

Reported location:
- `JavaImportResolver.js` around line 140.

Reported behavior: imports such as `import com.example.utils.*;` receive a `wildcard` status and fail edge-confirmation gating.

Do not solve this by connecting the importing file to every class or file in the package. A wildcard import establishes package visibility, not proof that every package member is used.

Investigate whether symbol usage in the importing file can resolve a specific imported type to a unique package member using existing parser/IR data. If it can, create only the specific defensible relationships. Otherwise preserve a package-level or unresolved/ambiguous relationship with an explicit semantic type and diagnostics. If the current canonical graph schema cannot represent this safely, document the limitation and propose the smallest compatible extension; do not silently overload an unrelated edge type.

### B. Potentially incorrect relationships

**B1. C/C++ conditional preprocessor branches**

Reported location:
- `directiveExtractor.js`.

Reported behavior: include directives may be extracted from all `#if`, `#elif`, `#else`, and related branches without evaluating the repository's actual compile definitions. This can make mutually exclusive includes look simultaneously active.

Do not simply discard non-default branches. Without compiler flags, build configuration, platform, and macro definitions, the active branch may be unknowable.

Represent conditional/configuration-dependent includes explicitly where feasible. At minimum:
- Preserve the include path and source location.
- Preserve the conditional expression or branch context when available.
- Mark the relationship as conditional/configuration-dependent when it cannot be evaluated.
- Avoid presenting it as an unconditional dependency.
- Do not claim a branch is active unless the relevant configuration is known and evaluated.

If the current graph model cannot express this distinction, report the smallest safe design proposal instead of fabricating certainty.

**B2. Layout overlap and confusing edge routing**

Reported locations:
- `repositoryGraph.js`.
- React Flow element/layout construction.

Reported behavior: leaf folders arrange files in a tight three-column vertical grid with a small gap (reported as 8px). Nodes and labels may overlap or edges may cross through intermediate nodes.

Treat this as a visualization/layout defect, not a missing-dependency defect. Verify actual dimensions, label wrapping, node spacing, edge routing, and behavior at realistic repository sizes.

Improve readability without changing dependency semantics. Prefer a deterministic layout that:
- Avoids node overlap.
- Respects folder grouping and hierarchy.
- Gives connected files sufficient separation.
- Minimizes edge crossings where practical.
- Keeps labels readable.
- Remains usable for larger folders and dense graphs.
- Does not cause unstable node positions on every render.

Evaluate whether the current Dagre setup can be configured adequately before adding another layout dependency. Do not introduce ELK or another library without demonstrating why the current layout cannot meet requirements and documenting the bundle/performance trade-off.

### C. Folder-level relationships may disappear

**C1. Collapsed-folder internal edges may be filtered**

Reported location:
- `buildElements.js` around line 131.

Reported behavior: when both endpoints collapse into the same folder node, the resulting folder-to-itself edge is filtered. This hides the fact that the collapsed folder contains internal dependencies.

Do not render meaningless self-loop edges merely to preserve counts. Instead, preserve the underlying relationship and surface useful aggregate information, for example:
- An internal-dependency count or indicator on the collapsed folder.
- A way to inspect the internal relationships.
- Correct restoration of individual edges when the folder expands.

The exact UI treatment should fit the existing design and remain scoped to dependency visualization.

**C2. Nested folder-to-folder aggregation may be incomplete**

Reported behavior: a legacy `deriveDirectoryHierarchy` path aggregates only top-level relationships and may omit dependencies between nested subfolders.

Verify whether this legacy path is still used by the active frontend. Do not fix dead code unless it is demonstrably part of a supported path. For the active path, aggregate edges using the actual lowest common visible folder endpoints or another clearly defined rule. Preserve direction and dependency type. Avoid double-counting when multiple underlying edges collapse to the same aggregate relationship.

---

## 3. Additional mandatory investigation: retrieval limit and graph completeness

The supplied architecture diagram shows `sourceRetrieval.js` with a reported `maxRetrievalFiles = 50`.

This is a critical verification item, not a confirmed defect.

Determine whether `50` is:
- A per-batch size, with all eligible files eventually processed.
- A per-request limit, with pagination or subsequent batches.
- A hard per-repository cap that permanently excludes files.
- A safety budget that intentionally creates a partial graph.

Trace the full path from manifest discovery through file selection, retrieval, parsing, graph publication, API response, and frontend rendering.

Answer these questions with code evidence:
1. Can a repository with more than 50 eligible source files have all eligible files processed?
2. If processing is capped or interrupted, is the graph explicitly marked partial?
3. Are excluded files and reasons exposed to the caller?
4. Does the frontend distinguish a complete graph from a partial graph?
5. Can a user mistake a partial graph for a complete repository architecture?
6. Are limits applied consistently in full and incremental ingestion?
7. Are resource budgets preserved and enforced?

If this is a hard cap with no honest completeness signal, treat it as a correctness issue. Do not simply increase the limit without analyzing memory, API, storage, runtime, and abuse implications. Prefer bounded batching and explicit completeness metadata.

---

## 4. Required workflow

### Step 0 — Establish repository state

Before edits:
1. Inspect the current branch and working tree.
2. Record modified, staged, and untracked files.
3. Do not overwrite or revert existing changes.
4. Locate the active implementations of the files/functions named above; line numbers may have shifted.
5. Trace both full-ingestion and incremental-ingestion paths.
6. Identify active versus legacy frontend graph-building paths.

Deliver a concise baseline summary in your final report.

### Step 1 — Verify each finding

For every A1–A4, B1–B2, C1–C2, and the retrieval-limit investigation, classify it as:
- **Confirmed defect**
- **Partially confirmed**
- **Not reproducible**
- **Intentional limitation**
- **Insufficient evidence**

For each classification provide:
- Exact file and function.
- Relevant code behavior.
- A minimal reproduction or test case.
- Expected versus actual result.
- Impact and affected ingestion/rendering path.
- Whether full and incremental paths differ.

Do not proceed with speculative changes. A finding that is not reproduced must not be “fixed” by guessing.

### Step 2 — Implement verified fixes in dependency order

Use this order, adapting only when code dependencies require it:

**Stage 2A — Extraction and resolution**
- Process supported re-export declarations.
- Supply supported TypeScript configuration to module resolution.
- Keep full and incremental pipelines behaviorally consistent.
- Preserve unresolved/ambiguous states.
- Address Java wildcard imports only with defensible semantics.
- Preserve C/C++ conditional include context; do not assert unknown compile configuration.

**Stage 2B — Graph construction integrity**
- Use the full manifest to validate repository path existence.
- Keep manifest existence distinct from parsed-file availability.
- Preserve valid asset/config/style relationships where supported.
- Do not create edges to arbitrary files or unsupported targets.
- Keep canonical graph validation strict and explain any new edge semantics.

**Stage 2C — Folder aggregation**
- Preserve internal dependencies when a folder is collapsed through aggregate metadata or another meaningful representation.
- Restore detailed edges on expansion.
- Support nested folder-to-folder aggregation.
- Preserve direction and edge type.
- Prevent duplicate aggregate counts.
- Confirm the active code path; do not spend effort on unused legacy code.

**Stage 2D — Visualization layout**
- Resolve node overlap and unreadable edge routing.
- Keep folder containment separate from dependency edges.
- Preserve stable layout behavior.
- Prefer improvements to the current layout library before considering a new dependency.
- Test both small and dense repository structures.

**Stage 2E — Retrieval completeness**
- Fix a confirmed hard-cap or incomplete-publication defect without removing resource safeguards.
- Make partial/complete status and exclusions visible through the existing data contract.
- Keep full and incremental processing consistent.
- Do not modify the deferred ingestion-progress UI (Gate 11G). Any graph completeness metadata required for correctness must be exposed minimally through the existing graph/repository response contract, without adding an ingestion progress panel.

### Step 3 — Test each change

Add focused regression tests before or alongside implementation. Tests must cover the behavior, not merely assert that a helper was called.

At minimum, where supported by the current architecture, test:

#### Re-exports and TypeScript aliases
- `export * from './x'`.
- `export { A } from './x'`.
- `export { default } from './x'`.
- Re-export target missing from manifest.
- Alias import resolved using `tsconfig` `paths`.
- Alias import with missing/invalid config remains explicitly unresolved.
- Same fixtures produce consistent results in full and incremental pipelines.

#### Manifest and target validation
- Parsed source file imports another parsed source file.
- Parsed file imports a manifest-listed asset/style/JSON file.
- Target exists in manifest but has not been retrieved or parsed.
- Target is absent from manifest.
- Unsupported target type does not become a false confirmed code dependency.
- Batch processing does not reject a valid target merely because the target is outside the current FileIR batch.

#### Java wildcard imports
- Wildcard import with one uniquely used resolvable type.
- Wildcard import with multiple possible types.
- Wildcard import with no identifiable use.
- Ensure no edge is created to every class in the package without evidence.

#### C/C++ preprocessor includes
- Include under `#if`.
- Include under `#elif`.
- Include under `#else`.
- Nested conditional directives.
- Known configuration versus unknown configuration.
- Ensure conditional includes are not mislabeled as unconditional.

#### Folder aggregation
- Internal edge inside a collapsed folder.
- Edge between two files in the same collapsed folder.
- Edge between nested sibling folders.
- Edge between different top-level folders.
- Expand/collapse round trip restores detailed edges.
- Aggregate counts do not double-count parallel or duplicate relationships.
- Direction and dependency type are preserved.

#### Layout
- Folder with 1, 3, 10, and many files.
- Long file names and wrapped labels.
- Dense cross-folder dependencies.
- No node bounding-box overlap.
- Edge labels and node labels remain readable.
- Stable output for the same input.
- Layout does not alter or fabricate graph edges.

#### Retrieval/completeness
- Repository with more than 50 eligible files.
- Multiple retrieval batches.
- Partial retrieval due to budget or failure.
- Excluded files with reasons.
- Full versus incremental ingestion consistency.
- API/frontend contract distinguishes partial from complete graph.
- Resource limits remain enforced.

Use the repository's existing test framework and conventions. Avoid brittle tests that assert implementation details or exact layout coordinates unless determinism is part of the contract.

### Step 4 — Validate the complete change

Run relevant focused tests first, then the broad existing suites and build/lint checks available in the repository.

Report:
- Exact commands executed.
- Passed/failed/skipped counts.
- Any environment-dependent tests not run.
- Build and lint outcomes.
- Changed files and the reason each changed.
- Any schema/API contract changes.
- Any unresolved limitations.

Do not alter unrelated tests just to make them pass. Do not weaken assertions.

---

## 5. Acceptance criteria

The task is complete only when all applicable criteria below are satisfied:

1. Supported re-export declarations produce the intended graph relationships.
2. Supported TypeScript path aliases resolve consistently in full and incremental ingestion.
3. Manifest path existence is not incorrectly equated with FileIR batch membership.
4. Valid asset/config/style relationships are retained when supported by parser/resolver evidence.
5. Unsupported or ambiguous targets remain explicit and do not become fabricated edges.
6. Java wildcard imports do not create edges to every package member without evidence.
7. C/C++ conditional includes are not represented as universally active when compile configuration is unknown.
8. Collapsed folders do not silently hide all evidence of their internal dependencies.
9. Nested folder aggregation preserves valid cross-folder relationships without double-counting.
10. The graph layout has no overlapping node bounding boxes in the supported test fixtures and materially improves edge readability.
11. The retrieval limit is understood and cannot silently make an incomplete graph appear complete.
12. Resource budgets, security boundaries, tenant isolation, and ingestion safety guarantees remain intact.
13. The manifest, canonical graph, and AI conceptual explanation layers remain separate.
14. FileIR v1.0.0 remains compatible unless a necessary, documented, approved schema change is made.
15. All relevant regression tests pass, and the full test/build/lint outcomes are reported honestly.

---

## 6. Explicit non-goals

Do not:
- Redesign Cartograph's overall architecture.
- Rewrite parsers or resolvers wholesale.
- Add AI-generated dependency edges.
- Treat all imports as confirmed internal dependencies.
- Connect every class in a Java wildcard-imported package.
- Assume a C/C++ preprocessor branch is active without configuration evidence.
- Replace React Flow.
- Add ELK or another layout library without a measured justification.
- Redesign the entire graph UI.
- Build Gate 11G ingestion-progress UI or SSE progress panels.
- Change unrelated authentication, organization, billing, or ingestion lifecycle behavior.
- Change database schemas unless the existing model cannot safely express a verified requirement; if so, stop and document the smallest proposed change before applying it.
- Remove safety limits just to make a large repository appear complete.

---

## 7. Final report format

Return a concise but evidence-based report with these sections:

1. **Repository baseline**
   - Branch and working-tree state.
   - Existing user changes preserved.

2. **Finding verification matrix**
   - Finding ID.
   - Classification.
   - Evidence (file/function).
   - Reproduction/test.
   - Impact.

3. **Changes implemented**
   - Grouped by Stage 2A–2E.
   - Files changed and why.
   - Any behavior or contract changes.

4. **Tests and validation**
   - Commands.
   - Pass/fail/skip counts.
   - Build/lint results.
   - Tests not run and why.

5. **Completeness and limitations**
   - Retrieval limit behavior.
   - Partial-versus-complete graph semantics.
   - Remaining unsupported or ambiguous cases.

6. **Risks and follow-up**
   - Only genuine remaining risks.
   - Any schema/API changes requiring separate approval.

7. **Final status**
   - Complete, partially complete, or blocked.
   - Do not use “complete” if any acceptance-critical issue remains unresolved.

Be precise. Distinguish verified facts from assumptions. Never report a successful fix without a regression test or a clearly explained reason a test is not feasible.
