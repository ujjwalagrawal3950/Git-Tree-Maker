# Cartograph — Repository Visualization Integrity & Architecture Redesign Report

**Document type:** Engineering investigation and solution-design brief  
**Project:** Cartograph  
**Scope:** Repository hierarchy, file/symbol representation, dependency visualization, and frontend graph architecture  
**Current authorization:** Inspection and solution proposal only  
**Implementation status:** Not authorized by this document  
**Gate 11G:** Remains unauthorized and on hold

---

## 1. Executive Summary

Cartograph's current repository visualization is not reliably representing the repository's actual structure, and the dependency graph is difficult to read.

The supplied GitHub repository screenshot shows:

```text
Repository/
├── Backend/
├── Docs/
├── Frontend/
├── .gitignore
└── README.md
```

However, the current Cartograph visualization shows only `Backend` and a `root` entry. The expanded `Backend` view also displays apparent files and symbols at the same hierarchy level. Dependency edges overlap and do not communicate relationships clearly.

These are not merely styling defects. They may originate in one or more stages of the data pipeline:

- GitHub tree discovery and manifest generation.
- Manifest classification and filtering.
- Source retrieval and parsing.
- FileIR and canonical graph construction.
- Graph API response shaping.
- Frontend graph transformation.
- Directory hierarchy derivation.
- React Flow node rendering and layout.
- Dependency edge aggregation and routing.

The coding agent must not assume the cause or immediately redesign the UI. It must first trace the actual data through the pipeline, identify where information is lost or misclassified, and propose a solution that preserves Cartograph's canonical graph semantics.

**The immediate task is Stage A: inspect, diagnose, and propose. Do not modify code until the user explicitly approves a proposed implementation stage.**

---

## 2. Evidence From the Supplied Screenshots

### 2.1 GitHub repository view

The supplied GitHub screenshot visibly contains:

- `Backend/`
- `Docs/`
- `Frontend/`
- `.gitignore`
- `README.md`

This establishes the expected top-level repository entries for the illustrated repository.

It does not establish the full nested contents of those directories.

### 2.2 Cartograph repository overview

The supplied Cartograph screenshot shows only:

- `Backend`
- `root`

The `Backend` card displays a count of `11`; the `root` card displays a count of `1`.

The screenshots do not establish what those counts mean. They may represent files, graph nodes, direct children, or another derived quantity. The implementation must be inspected before interpreting them.

### 2.3 Expanded Backend view

The expanded view contains entries resembling:

- `app.js`
- `env.js`
- `errors.js`
- `security.js`
- `crypto`
- `requestId`
- `apiLimiter`
- `webhookLimiter`
- `securityHeaders`
- `cors`
- `rateLimit`

The first four appear to be file names. The remaining entries appear to be symbols or declarations, based on their labels and displayed categories. This is an observation from the screenshot, not a verified mapping of those symbols to their declaring files.

The current display makes files and symbols look like siblings under the directory. That is not an understandable repository hierarchy.

### 2.4 Dependency edges

The expanded view contains multiple crossing and overlapping edges. It is difficult to determine:

- Which file is the source of an edge.
- Which file or symbol is the target.
- Whether an edge represents an import, call, inheritance, or another relationship.
- Whether the displayed edge is a true dependency or an aggregated visual summary.

The graph currently communicates connection density more strongly than architecture.

---

## 3. Problems to Investigate

### Problem A — Missing top-level directories

**Observed:** GitHub shows `Backend`, `Docs`, and `Frontend`; Cartograph shows `Backend` and `root`.

**Possible explanations to test, not assumptions:**

1. The GitHub manifest contains the directories, but the frontend hierarchy builder does not use it.
2. Directory hierarchy is derived only from parsed graph nodes, so documentation-only or unsupported directories disappear.
3. The manifest API response is incomplete or the frontend is consuming the wrong response field.
4. Manifest classification removes entries before hierarchy construction.
5. Path normalization or root-prefix handling causes paths to be grouped incorrectly.
6. The graph transformer drops paths or node metadata.
7. Empty directories are absent from the Git tree representation or are handled incorrectly.
8. A loading, filtering, or rendering condition hides directories without dependency nodes.

**Required outcome:** Identify the exact stage at which `Docs` and `Frontend` are lost, or establish that they are present but not rendered. Do not hardcode these directory names.

### Problem B — Root-level files are represented ambiguously

The GitHub screenshot shows `.gitignore` and `README.md` at the repository root.

The current UI shows a `root` card with a count of `1`, but the screenshot does not reveal which root entries it represents.

Investigate:

- Whether root-level files are included in the manifest.
- Whether they are converted into a synthetic `root` directory.
- Whether the `root` card is intended to represent a directory, a grouping node, or a file collection.
- Whether its count includes files, directories, or graph nodes.

**Required outcome:** Root-level files must be represented as root-level files in the hierarchy model. Do not present the repository root as an ordinary child directory unless the UI clearly distinguishes the repository root from actual directories.

### Problem C — Files and symbols appear at the same level

The intended containment model is:

```text
Repository
└── Directory
    ├── Nested Directory
    └── File
        └── Symbol
```

The current screenshot appears to place file entries and symbol entries together inside `Backend`.

Investigate:

- Canonical node type fields.
- File-to-symbol ownership relationships.
- Parser declaration metadata.
- `contains` or equivalent canonical relationships, if present.
- Graph transformer type mapping.
- Whether symbol nodes carry a reliable owning-file ID or path.
- Whether the frontend is flattening all graph nodes into directory children.

**Required outcome:** A symbol must be displayed under its declaring file only when ownership is supported by canonical parser/graph evidence. Do not infer ownership from a symbol name, basename, or visual proximity.

If ownership cannot be established, keep the symbol out of the normal directory/file hierarchy and report it as unresolved diagnostic data.

### Problem D — Files without dependencies may disappear

A repository explorer must not show only files that participate in dependency edges.

Investigate whether the frontend builds its visible file list from:

- Manifest entries.
- Canonical file nodes.
- Dependency edge endpoints.
- A union of these sources.

Files that are in the manifest but have no dependency edges must still be represented as files, with an appropriate parsing/analysis status.

### Problem E — Documentation, configuration, and unsupported files

The repository manifest may contain files that are not parsed as source code, including documentation, configuration, images, or unsupported file types.

These files should not be falsely represented as parsed source nodes. However, filtering them out of the hierarchy would make the repository structure incomplete.

Investigate how the current manifest classification is exposed to the frontend.

**Required outcome:** Preserve repository presence and classification separately from parser/graph eligibility.

### Problem F — Ambiguous directory counts

The current count badges do not have a documented meaning.

Define separate metrics rather than a generic count:

- Direct child directory count.
- Direct child file count.
- Recursive descendant file count.
- Eligible source file count.
- Successfully parsed file count.
- Failed or unsupported file count, where relevant.
- Symbol count.
- Incoming cross-boundary dependency count.
- Outgoing cross-boundary dependency count.

Do not combine files, symbols, and directories into one ambiguous number.

### Problem G — Dependency edges are unreadable

Investigate:

- Whether the current layout treats every file and symbol as a flat Dagre node.
- Whether edge routing ignores directory grouping.
- Whether multiple canonical edges are visually duplicated.
- Whether edges attach to directory containers instead of their actual file/symbol endpoints.
- Whether labels obscure nodes or other edges.
- Whether collapsed and expanded directory states use appropriate edge representations.

**Required outcome:** The default overview must not attempt to draw every symbol-level relationship in the repository.

---

## 4. Required Data-Pipeline Audit

Trace one repository through every relevant stage. Use actual runtime data, API responses, logs, or reproducible tests. Do not rely only on code-reading assumptions.

### Stage 1 — GitHub tree discovery

Inspect the GitHub Git Tree API response and record:

- Total tree entries.
- Directory paths discovered.
- File paths discovered.
- Root-level files.
- Truncation status and fallback behavior, if applicable.

For the supplied repository, verify whether `Backend`, `Docs`, `Frontend`, `.gitignore`, and `README.md` are present in the discovered tree.

### Stage 2 — Manifest generation

Inspect the normalized manifest and record:

- Total manifest entries.
- Directory entries or derived directory paths.
- File paths.
- Root-level entries.
- Classification of each relevant entry.
- Excluded entries and exclusion reasons.

Determine whether the manifest preserves documentation and unsupported files.

### Stage 3 — Manifest classification and scheduling

Inspect the classification and scheduler output.

Separate:

- Eligible source files.
- Documentation/context files.
- Configuration/build files.
- Binary/media files.
- Unsupported files.
- Oversized or excluded files.

Determine whether classification affects repository visibility or only ingestion scheduling. These are different responsibilities.

### Stage 4 — Source retrieval and parsing

Record:

- Files selected for download.
- Files downloaded successfully.
- Files parsed successfully.
- Files with parser errors.
- Files skipped or unsupported.
- FileIR artifacts produced.

A file's absence from parsed output must not be interpreted as proof that it does not exist in the repository.

### Stage 5 — Canonical graph construction

Inspect the graph snapshot and record counts by canonical node type:

- File nodes.
- Symbol nodes.
- External nodes.
- Other supported node types.

Inspect edge types and ownership evidence.

Verify whether every parsed file has a canonical file node, including files with zero dependencies.

Verify how symbols are associated with their declaring files.

### Stage 6 — Graph API response

Capture the actual response used by the frontend.

Record:

- Node count by type.
- Edge count by type.
- File path availability.
- Canonical IDs.
- Symbol ownership metadata.
- Repository and commit identity.
- Snapshot version and partial/complete status.

Determine whether the API intentionally returns only graph nodes and edges or also provides manifest data.

### Stage 7 — Frontend transformation

Inspect `graphTransformer.js` and related code.

Record:

- Input nodes and edges.
- Output React Flow nodes and edges.
- Dropped or filtered records.
- Type conversions.
- Path normalization.
- Canonical ID preservation.
- File-to-symbol ownership mapping.

Identify exactly whether directories disappear here or earlier.

### Stage 8 — Hierarchy construction and rendering

Inspect `repositoryGraph.js`, `DependencyMap.jsx`, `FolderNode.jsx`, `FileNode.jsx`, and relevant layout code.

Record:

- Directory paths derived.
- Files assigned to each directory.
- Symbols assigned to each file.
- Root-level file handling.
- Collapsed/expanded behavior.
- Node dimensions and layout positions.
- Edges retained, aggregated, hidden, or dropped.

### Required audit summary

Provide a table like this, populated with actual observed values:

| Pipeline stage | Directories | Files | Symbols | Notes |
|---|---:|---:|---:|---|
| GitHub tree | Actual | Actual | N/A | Raw discovery |
| Manifest | Actual | Actual | N/A | Classification |
| Selected for parsing | Actual | Actual | N/A | Scheduler output |
| Parsed/FileIR | N/A | Actual | Actual declarations | Parsing results |
| Canonical graph | Derived/none | Actual | Actual | Graph node counts |
| Graph API response | Derived/none | Actual | Actual | Actual payload |
| Frontend transformer | Actual | Actual | Actual | Retained/dropped |
| Rendered hierarchy | Actual | Actual | Actual | Visible UI |

If a stage does not represent a particular category, mark it `N/A`; do not invent a number.

---

## 5. Architecture Principles for the Proposed Solution

The agent must consider these principles while designing the correction.

### Principle 1 — Manifest is authoritative for containment

The complete repository hierarchy must be derived from the repository manifest or an equivalent complete repository-tree representation.

The dependency graph is not a complete inventory of repository files.

Do not derive all directories exclusively from parsed source nodes or dependency endpoints.

### Principle 2 — Canonical graph is authoritative for dependencies

Imports, calls, inheritance, type references, and other dependency relationships must come from the existing canonical graph.

Do not invent dependency edges from folder proximity, file names, matching basenames, or directory membership.

### Principle 3 — Containment and dependency are separate structures

Containment:

```text
Repository
└── Directory
    └── File
        └── Symbol
```

Dependencies:

```text
File A ──imports──> File B
File B ──calls────> Symbol C
Symbol C ──references_type──> Symbol D
```

The frontend may visually combine these layers, but it must not mutate canonical backend graph semantics to do so.

### Principle 4 — Preserve all relevant repository entries

A repository browser should distinguish:

- Present in repository.
- Eligible for parsing.
- Downloaded.
- Parsed.
- Parse failed.
- Unsupported.
- Excluded by resource policy.

Do not silently remove an entry from the repository hierarchy because it was not parsed.

### Principle 5 — Stable identity

Use canonical repository paths and existing canonical IDs.

Example:

```text
src/components/Button.jsx
src/admin/components/Button.jsx
```

These are distinct files.

Do not use basename alone for:

- React keys.
- Node IDs.
- Selection.
- Edge endpoints.
- File-to-symbol ownership.
- Cache keys.

### Principle 6 — Symbol ownership must be evidence-based

A symbol belongs to a file only when the parser/graph model provides a reliable relationship.

Do not infer ownership from names or path guesses.

### Principle 7 — Default view must remain readable

Do not put every symbol and every dependency edge on the repository overview.

Use progressive exploration:

1. Repository overview.
2. Directory contents.
3. File and symbol exploration.
4. Detailed dependency relationships.

The exact interaction model is for the agent to propose after inspecting the current implementation.

---

## 6. Candidate Visualization Models to Evaluate

The agent must evaluate alternatives rather than blindly implementing the previous design.

### Option A — Hierarchical repository explorer with dependency overlay

- Top-level directories and root files form the overview.
- Expanding a directory reveals its direct child directories and files.
- Selecting a file opens symbol/dependency exploration.
- Dependency edges are shown selectively at the current scope.

**Advantages:** Strong repository comprehension, predictable navigation, scalable for large repositories.

**Risks:** Requires careful interaction design to preserve graph context.

### Option B — Directory containers on a graph canvas

- Directories appear as container nodes.
- Expanded containers display their direct files.
- Dependency edges connect file rows or aggregate at directory boundaries.
- Symbols appear only after file selection or explicit expansion.

**Advantages:** Closer to the supplied reference image and preserves a graph-first experience.

**Risks:** Nested containers, edge routing, cycles, and large directories can become difficult to manage.

### Option C — Split repository explorer and dependency canvas

- A structured tree/navigation panel shows repository containment.
- A separate graph canvas shows the selected directory, file, or symbol dependencies.
- Selection in one view scopes the other.

**Advantages:** Separates navigation from dependency analysis and avoids overcrowding the graph.

**Risks:** Requires a coordinated selection model and careful use of screen space.

### Required recommendation

Compare the options using:

- Repository comprehension.
- Readability.
- Scalability.
- Dependency traceability.
- Interaction complexity.
- Compatibility with current React Flow architecture.
- Incremental snapshot support.
- Implementation cost.

Recommend one approach or a justified hybrid. Do not choose solely because it is easiest to implement.

---

## 7. Dependency Visualization Requirements

Whatever model is proposed:

- Preserve canonical dependency direction.
- Preserve canonical edge identity and provenance.
- Do not invent relationships.
- Avoid showing all symbol-level edges in the default overview.
- Use aggregated directory-level relationships only as a visual summary of real underlying edges.
- Count unique canonical edges.
- Exclude internal edges from cross-directory boundary statistics.
- Distinguish incoming and outgoing cross-boundary dependencies.
- Support cycles in the dependency graph.
- Ensure edge aggregation does not lose access to the underlying file/symbol relationships.
- Explain how collapsed and expanded scopes change edge visibility.

Directory dependency aggregation is a presentation operation, not a replacement for canonical graph data.

---

## 8. Frontend Architecture Constraints

Preserve the current stack unless the inspection demonstrates a concrete limitation:

- React 19.
- Vite.
- JavaScript/JSX.
- Tailwind CSS v3.
- React Flow.
- Dagre.

Previously identified frontend modules include:

- `Frontend/src/lib/repositoryGraph.js`
- `Frontend/src/lib/graphLayout.js`
- `Frontend/src/lib/graphTransformer.js`
- `Frontend/src/components/map/DependencyMap.jsx`
- `Frontend/src/components/map/FolderNode.jsx`
- `Frontend/src/components/map/FileNode.jsx`
- `Frontend/src/index.css`
- Existing frontend graph tests.

Inspect other relevant modules as needed.

Do not assume these are the only affected files.

Do not migrate frameworks or introduce a new graph library without a separate, evidence-based proposal.

---

## 9. Non-Goals and Scope Restrictions

This task is an investigation and solution proposal.

Do not:

- Modify source code during Stage A.
- Redesign the UI before locating the data loss.
- Hardcode `Backend`, `Docs`, or `Frontend`.
- Add synthetic directory nodes to the backend canonical graph.
- Change FileIR schema.
- Change parser adapters.
- Change language resolvers.
- Change GraphBuilder or GraphValidator.
- Change ingestion lifecycle or job state.
- Change Gate 11F database functions.
- Implement Gate 11G ingestion progress UI.
- Introduce Redis, Kafka, or other infrastructure.
- Remove existing graph capabilities to simplify the design.
- Claim tests pass without executing them.

If the investigation discovers a genuine backend data-contract defect, document it separately with evidence. Do not fix it without approval.

---

## 10. Stage A Deliverables

Submit a detailed engineering report containing:

### A. Confirmed root causes

For each observed issue, identify:

- Exact cause.
- Exact module/function involved.
- Evidence from actual data or execution.
- Whether the issue originates in backend data, frontend transformation, layout, or rendering.

Clearly distinguish confirmed findings from hypotheses.

### B. Data-pipeline audit

Provide the populated pipeline table from Section 4.

Include the actual relevant repository paths and explain where `Docs`, `Frontend`, `.gitignore`, and `README.md` are lost or represented.

### C. File/symbol ownership audit

Show representative canonical file and symbol records.

Explain exactly how symbol-to-file ownership is established.

### D. Visualization architecture comparison

Compare Options A, B, and C from Section 6.

Recommend one approach or a justified hybrid, with trade-offs.

### E. Proposed data model

Describe:

- Repository hierarchy model.
- Directory identity.
- File identity.
- Symbol ownership.
- Manifest classification metadata.
- Dependency edge references.
- Directory statistics.
- Expanded/collapsed state.

Do not change canonical backend schemas merely to support frontend grouping.

### F. Proposed interaction design

Explain:

- Repository overview.
- Directory navigation.
- File selection.
- Symbol exploration.
- Dependency inspection.
- Back navigation and selection persistence.
- Behavior for unparsed/unsupported files.
- Behavior for large directories and large repositories.

### G. Exact implementation plan

Break the proposal into small, reviewable stages.

For each stage provide:

- Goal.
- Expected files.
- Data-contract dependencies.
- Tests.
- Acceptance criteria.
- Risks.

### H. Open questions and limitations

List anything that cannot be established from current source data or code.

Do not fill gaps with assumptions.

---

## 11. Acceptance Criteria for Stage A

Stage A is accepted only when:

1. The missing `Docs` and `Frontend` issue is traced to an exact pipeline stage.
2. Root-level file handling is explained.
3. File and symbol mixing is traced to its actual cause.
4. Files without dependency edges are accounted for.
5. Manifest classification and visual presence are clearly separated.
6. Directory count semantics are defined.
7. Dependency edge clutter has an evidence-based explanation.
8. Options A, B, and C are evaluated.
9. A recommended architecture is presented with trade-offs.
10. The exact proposed implementation stages and test plan are provided.
11. No code was modified during Stage A.

---

## 12. Mandatory Stop and Authorization

**Perform Stage A inspection and solution design only.**

Do not modify code.

Do not begin implementation automatically after submitting the report.

Wait for explicit user approval of the proposed architecture and the next implementation stage.

Gate 11G remains unauthorized. This investigation does not authorize ingestion progress UI, SSE frontend integration, or other Gate 11G work.
