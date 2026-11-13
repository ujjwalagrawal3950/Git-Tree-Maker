# Cartograph Phase 10 — Gate 10F
## Frontend Integration with React Flow

**Objective:** Integrate the existing frontend with Cartograph's authorized graph APIs. Render backend-generated dependency graphs using React Flow and Dagre, while preserving the backend as the sole source of graph truth.

**Implementation boundary:** Frontend integration only. Do not change backend graph semantics, canonical identities, FileIR, or persistence.

---

## 1. Gate 10F Principles

1. The backend determines which nodes, edges, and relationships exist.
2. The frontend is responsible only for presentation, layout, interaction, and navigation.
3. React Flow node IDs must remain identical to backend canonical node IDs.
4. React Flow edge IDs must remain identical to backend canonical edge IDs.
5. Only backend-confirmed edges may be rendered as dependency relationships.
6. Unresolved, ambiguous, dynamic, and unsupported facts must remain separate from confirmed graph edges.
7. Do not infer dependencies from filenames, naming similarity, imports visible in source text, or frontend heuristics.

## 2. Mandatory Step 0 — Inspect Existing Frontend Architecture

Before modifying files, inspect:

- Existing `DependencyMap.jsx` and all graph-related components.
- Existing `repositoryGraph.js` and graph utilities.
- Current `@xyflow/react` integration and custom node/edge types.
- Existing Dagre layout implementation and configuration.
- Repository details pages and navigation structure.
- Existing API client, authentication, active-organization context, and error handling.
- Existing loading, empty, error, toast, and notification patterns.
- Existing frontend tests and test tooling.

### Step 0 deliverable

Provide a concise inspection report containing:

- Relevant files and their responsibilities.
- Existing components/utilities that can be reused.
- Current graph data flow.
- Current API request conventions.
- Proposed minimal integration plan.
- Any API contract mismatch or missing backend capability.

**Do not implement changes during Step 0.** Wait for approval of the inspection plan before proceeding.

---

## 3. Backend API Integration

Use the existing authorized endpoints:

| Purpose | Endpoint |
|---|---|
| Graph summary | `GET /api/repositories/:repositoryId/graph` |
| Paginated nodes | `GET /api/repositories/:repositoryId/graph/nodes` |
| Node details | `GET /api/repositories/:repositoryId/graph/nodes/:nodeId` |
| Outgoing edges | `GET /api/repositories/:repositoryId/graph/nodes/:nodeId/outgoing` |
| Incoming edges | `GET /api/repositories/:repositoryId/graph/nodes/:nodeId/incoming` |
| Bounded neighborhood | `GET /api/repositories/:repositoryId/graph/neighborhood` |
| Edge provenance | `GET /api/repositories/:repositoryId/graph/edges/:edgeId/evidence` |
| Unresolved references | `GET /api/repositories/:repositoryId/graph/unresolved` |

Use the existing frontend API client and authentication flow. Do not introduce a second API client or expose credentials in browser code.

### Request behavior

- Support pagination for node and unresolved-reference listings.
- Use bounded neighborhood requests for graph exploration.
- Request node details and edge evidence on demand.
- Avoid fetching the entire graph for every interaction.
- Avoid duplicate requests where the existing data-fetching approach supports deduplication.
- Cancel or ignore obsolete requests when repository or revision context changes.
- Ensure late responses for a previous repository/revision cannot overwrite the current view.
- Handle the API's existing response envelope without inventing a new contract.

### Error handling

Handle these states explicitly:

- `401`: session/authentication required.
- `403`: permission denied.
- `404`: graph snapshot not built or requested node/edge not found.
- `429`: request throttled; provide a sensible retry experience.
- `5xx` and network errors: recoverable failure with retry.
- Invalid query parameters: display a useful validation message.

Do not reveal internal server details or sensitive response data to the user.

---

## 4. Backend-to-React-Flow Transformation Layer

Create or adapt a dedicated transformation utility between backend graph responses and React Flow.

### Node mapping

- Preserve backend `node.id` exactly as React Flow `id`.
- Preserve backend node type and relevant metadata.
- Map backend node categories such as `file`, `symbol`, and `external` to appropriate React Flow node types.
- Keep file path, language, qualified name, and other available metadata in node data.
- Do not generate synthetic canonical IDs.
- Do not create nodes that are absent from backend responses.

### Edge mapping

- Preserve backend `edge.id` exactly as React Flow `id`.
- Preserve backend `source` and `target` direction exactly.
- Preserve backend edge type and relevant metadata.
- Keep provenance/evidence identifiers or metadata accessible for selection.
- Render only edges confirmed by the backend.
- Do not generate edges based on frontend inference.
- Do not silently convert unresolved references into graph edges.

### Transformation tests

Test:
- Stable node ID preservation.
- Stable edge ID preservation.
- Source/target direction preservation.
- Node and edge type preservation.
- Metadata preservation.
- Exclusion of unconfirmed relationships.
- No invented nodes or edges.

---

## 5. Dagre Layout

Use the existing Dagre dependency and existing layout conventions.

Requirements:

- Deterministic output for identical graph structure and layout configuration.
- Directed layout that respects source/target relationships.
- Sensible node dimensions, rank separation, and node separation.
- No overlapping nodes in representative test graphs.
- Preserve graph connectivity and edge direction.
- Recompute layout only when graph structure or layout settings change.
- Preserve the user's viewport where practical during neighborhood expansion.
- Do not alter backend node or edge IDs to satisfy layout requirements.

Test layout determinism and representative graph geometry.

---

## 6. Graph Overview

Implement or adapt a graph overview that:

- Displays graph metadata and available statistics.
- Distinguishes file, symbol, and external-package nodes.
- Shows confirmed dependency edges.
- Provides useful zoom, pan, fit-view, and selection behavior using existing React Flow capabilities.
- Supports large repositories through pagination and bounded graph requests rather than loading everything without limits.

Provide distinct states for:

1. Loading.
2. Graph not built.
3. Empty graph.
4. Graph available.
5. Permission denied.
6. Recoverable request failure.
7. Truncated neighborhood response.

Do not redesign unrelated repository pages.

---

## 7. Node Selection and Details

When a user selects a node:

- Display its available backend-provided details.
- Show node category, language, file path, symbol name, and qualified name where available.
- Fetch additional node details only when needed.
- Provide incoming and outgoing relationship exploration.
- Make it clear when optional metadata is unavailable.
- Avoid deriving authoritative facts from display labels.

Node selection must not trigger a full graph rebuild.

---

## 8. Bounded Neighborhood Exploration

Use the backend neighborhood endpoint.

Requirements:

- Respect backend maximum depth and node-count limits.
- Do not bypass backend bounds with client-side traversal.
- Display the backend's `truncated` indicator.
- Merge returned nodes and edges without duplicates.
- Preserve canonical IDs during incremental expansion.
- Avoid removing existing graph elements that are still part of the current exploration.
- Prevent stale expansion responses from changing a newly selected repository or revision.
- Preserve viewport position where practical.

The frontend must not independently traverse an incomplete graph to invent missing relationships.

---

## 9. Edge Selection and Provenance Panel

When a user selects an edge:

- Fetch provenance using the edge evidence endpoint.
- Display evidence supplied by the backend, such as:
  - Source file.
  - Source location.
  - Resolver.
  - Resolution rule.
  - Raw source or import/include/call fact.
  - Other available provenance metadata.
- Clearly identify the relationship type.
- Handle missing evidence and deleted/stale edge responses safely.
- Do not fabricate evidence or claim that an edge is more certain than the backend reports.

The provenance panel should make it possible to understand **why Cartograph believes a dependency exists**.

---

## 10. Unresolved References

Provide a separate panel or view for unresolved and ambiguous references.

Requirements:

- Use the unresolved-reference endpoint.
- Support backend pagination.
- Support status filtering where available.
- Display source file and location when supplied.
- Display candidate targets when supplied.
- Distinguish ambiguous, unresolved, dynamic, and unsupported statuses where the backend provides them.
- Do not display these records as confirmed graph edges.
- Do not silently discard unresolved facts.

If the backend response does not expose a field, do not invent it in the UI. Report any required missing field as an API contract gap.

---

## 11. State, Performance, and Lifecycle

- Reuse existing state-management patterns.
- Do not add a new state-management library.
- Keep API data separate from React Flow presentation state.
- Memoize node/edge transformations where useful.
- Avoid unnecessary React Flow re-renders.
- Avoid repeated Dagre layout calculations.
- Use bounded API requests.
- Clean up requests and subscriptions when repository context changes.
- Avoid complex caching infrastructure unless measured performance demonstrates a need.
- Keep the current repository ID and revision associated with every graph response.

---

## 12. Testing Requirements

Add focused frontend tests for:

### Transformation
- Backend node-to-React-Flow mapping.
- Backend edge-to-React-Flow mapping.
- Canonical ID preservation.
- Edge direction preservation.
- Metadata preservation.
- Exclusion of unconfirmed relationships.

### Layout
- Dagre layout determinism.
- No overlapping nodes for representative fixtures.
- Layout recalculation only when relevant graph structure/configuration changes, where testable.

### Exploration
- Duplicate prevention during neighborhood expansion.
- Truncation indication.
- Node selection and details.
- Incoming/outgoing relationship behavior.
- Edge provenance panel.
- Unresolved-reference filtering and pagination.

### Lifecycle and errors
- Loading, empty, and error states.
- Graph-not-built handling.
- Permission-denied handling.
- Retry behavior.
- Repository/revision switching without stale-response contamination.
- Request cancellation or obsolete-response suppression.

Run:

1. Relevant frontend test suites.
2. Frontend lint.
3. Frontend production build.
4. Full backend regression suite to confirm no backend regressions.

Report actual command output and distinguish tests that exist from tests that were actually executed.

---

## 13. Strict Scope Boundaries

Do not:

- Modify `GraphBuilder`, `GraphValidator`, `GraphQueryService`, or backend graph semantics.
- Change canonical node or edge identities.
- Change FileIR schema or parser/resolver behavior.
- Infer or create dependency relationships in the frontend.
- Add database migrations or backend infrastructure.
- Replace React Flow or Dagre.
- Migrate the frontend to another framework.
- Add a new state-management library.
- Perform unrelated UI refactoring.
- Begin Gate 10G or additional graph features.

If a backend API contract change is genuinely necessary, stop and report the exact missing field/behavior before changing backend code.

---

## 14. Completion Report

Provide:

1. Files created and modified.
2. Existing frontend architecture reused.
3. API integration and request lifecycle.
4. Node/edge transformation contract.
5. Confirmation that canonical IDs and edge direction are preserved.
6. Dagre layout behavior and determinism.
7. Neighborhood expansion and truncation behavior.
8. Provenance panel behavior.
9. Unresolved-reference behavior.
10. Loading, empty, permission, and error states.
11. Test results with actual command output.
12. Lint and production build results.
13. Backend regression results.
14. Known limitations and any deviations from this blueprint.

**Stop after Gate 10F. Do not begin Gate 10G without explicit approval.**
