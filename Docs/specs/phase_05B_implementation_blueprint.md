# Cartograph — Phase 05B Implementation Blueprint

**Milestone:** Phase 05B — Parser Core Infrastructure  
**Status:** Implementation blueprint; not an implementation report  
**Depends on:** Phase 05A — Unified Code Intelligence Architecture and FileIR schema  
**Existing foundation:** Phase 03 repository manifest and Phase 04 selective source retrieval  
**Backend:** Existing Node.js / Express modular monolith

---

## 1. Objective

Build the reusable parser infrastructure that accepts the normalized file results from Phase 04, dispatches each file to a language adapter, and returns validated, structured FileIR results.

Phase 05B builds the parser framework. It does **not** implement full language-specific syntax extraction. That begins in Phase 06 with JavaScript and TypeScript.

### Expected outcome

Given a collection of Phase 04 retrieval results, the parser service can:

1. Validate and normalize the input.
2. Select an adapter using the canonical language ID.
3. Schedule work with bounded concurrency.
4. Enforce per-file execution limits.
5. produce a structured result for supported, unsupported, failed, timed-out, or invalid files.
6. Validate every successful FileIR against the Phase 05A JSON Schema.
7. Return per-file results and an aggregate repository parse summary.

---

## 2. Scope

### In scope

- FileIR schema loading and validation.
- FileIR/entity builder helpers.
- Common language-adapter contract.
- Unsupported-language fallback adapter.
- Canonical language parser registry.
- Bounded parser scheduling.
- Per-file timeout and failure handling.
- Parser service orchestration.
- Unit and integration tests.
- Structured parse statuses and diagnostics.

### Out of scope

- Full JavaScript/TypeScript AST extraction.
- Python, Java, C/C++, or other language adapters.
- Cross-file symbol resolution.
- Dependency graph construction.
- Semantic embeddings or RAG.
- Database persistence or schema migrations.
- New infrastructure such as Redis, Kafka, Kubernetes, or microservices.
- Changes to Phase 03/04 ingestion and retrieval behavior unless a verified interface mismatch requires a small compatibility adjustment.

---

## 3. Processing pipeline

```text
Phase 04 retrieval results
        |
        v
ParserService
        |
        +--> Validate input / normalize metadata
        |
        v
ParserRegistry
        |
        +--> Supported adapter
        |        |
        |        v
        |   ParserScheduler
        |        |
        |        v
        |   Language adapter
        |        |
        |        v
        |   FileIR builder
        |        |
        |        v
        |   FileIR validator
        |
        +--> UnsupportedAdapter
                 |
                 v
          structured unsupported result
        |
        v
Per-file results + aggregate summary
```

The parser must consume already retrieved content. It must not independently download files from GitHub.

---

## 4. Proposed directory structure

Confirm the repository's existing naming and test conventions before creating these paths. Avoid moving existing modules solely to match this proposal.

```text
Backend/
└── services/
    └── parser/
        ├── adapters/
        │   ├── BaseAdapter.js
        │   └── UnsupportedAdapter.js
        ├── registry/
        │   └── ParserRegistry.js
        ├── builders/
        │   └── irBuilder.js
        ├── validation/
        │   ├── irValidator.js
        │   └── IR_SCHEMA.json
        ├── scheduler/
        │   └── ParserScheduler.js
        ├── ParserService.js
        └── __tests__/
            ├── irValidator.test.js
            ├── irBuilder.test.js
            ├── ParserRegistry.test.js
            ├── ParserScheduler.test.js
            └── ParserService.test.js
```

Use the existing Phase 05A schema as the single source of truth. Do not create a divergent copy. If the repository already has a schema location, reference that location instead.

---

## 5. Component specifications

### 5.1 `irValidator.js`

**Responsibility:** Compile the FileIR JSON Schema once and validate generated IR objects.

Recommended approach: AJV, subject to checking the existing dependency set and module conventions first.

Requirements:

- Load the Phase 05A schema from a stable local path.
- Compile the schema once at module initialization or through a cached factory.
- Expose a small API such as `validateFileIR(fileIR)`.
- Return structured validation information; do not throw for ordinary schema-invalid data.
- Avoid sharing mutable AJV error arrays across concurrent calls. Copy errors into the returned result immediately.
- Treat schema compilation/configuration failure as an infrastructure error, not as a malformed-file result.
- Do not silently mutate parser output during validation unless schema defaults/coercion are an explicit, documented decision. Prefer validation without coercion.

Conceptual result:

```js
{
  valid: false,
  errors: [
    {
      instancePath: "/symbols/0/name",
      keyword: "required",
      message: "must have required property 'name'"
    }
  ]
}
```

Tests:

- Valid minimal FileIR.
- Missing required root field.
- Invalid enum value.
- Invalid source location.
- Invalid nested entity.
- Schema compiles successfully.
- Concurrent validations do not leak or overwrite error details.

### 5.2 `irBuilder.js`

**Responsibility:** Provide centralized helpers for constructing normalized FileIR objects and their entities.

Suggested helper surface:

- `createFileIR(...)`
- `createSymbol(...)`
- `createImport(...)`
- `createExport(...)`
- `createLocation(...)`
- `createDiagnostic(...)`
- Additional helpers only where the Phase 05A schema requires them.

Requirements:

- Follow the exact Phase 05A schema field names and enums.
- Do not invent fields or weaken required fields to make construction easier.
- Normalize optional values consistently.
- Preserve source evidence and source locations.
- Keep syntax facts separate from resolved cross-file relationships.
- Do not make builders responsible for parsing source code.
- Prefer pure functions so builders are easy to test.

#### Deterministic IDs

The proposed symbol ID format is:

```js
`${fileId}#sym_${index}`
```

This is deterministic only when `fileId` and declaration traversal order are deterministic. Inserting a declaration earlier in the file may shift later indexes. Document this limitation.

Requirements:

- Define whether indexes are zero-based.
- Use a deterministic traversal order.
- Ensure IDs are unique within a file.
- Keep IDs scoped to the immutable file/repository revision identity defined in Phase 05A.
- Do not claim IDs remain stable across arbitrary source edits.

Tests:

- Same input and traversal order produce identical IDs.
- Different files do not collide.
- Index convention is consistent.
- Optional fields and empty collections follow the schema.
- Locations preserve the documented coordinate conventions.

### 5.3 `BaseAdapter.js`

**Responsibility:** Define the contract implemented by every language-specific parser adapter.

The interface should define:

- Canonical language ID.
- Adapter identity/version where applicable.
- A parse method receiving a normalized file input and controlled parse options.
- A documented return contract.
- A clear distinction between unsupported input, syntax diagnostics, and unexpected adapter failures.

The base class should fail clearly if a required method is not implemented. Do not put language-specific parsing logic in this class.

Conceptual input:

```js
{
  repository: { owner, name, commitSha },
  file: {
    path,
    blobSha,
    language,
    content
  }
}
```

The exact shape must be reconciled with the real Phase 04 retrieval output before implementation.

### 5.4 `UnsupportedAdapter.js`

**Responsibility:** Return a valid, structured unsupported result when no parser implementation exists for a language.

Requirements:

- Do not crash the repository parse.
- Do not pretend the file was successfully parsed.
- Return the appropriate status and diagnostic representation allowed by the Phase 05A schema/result contract.
- Keep unsupported distinct from failed and timed out.
- Preserve file identity and metadata where available.

The adapter must not fabricate symbols, imports, exports, or other syntax facts.

### 5.5 `ParserRegistry.js`

**Responsibility:** Map canonical language IDs to adapter instances.

Requirements:

- Use the existing Phase 04 language registry as the canonical source of language IDs where possible.
- Avoid maintaining a second conflicting language list.
- Support explicit aliases only when they are grounded in the existing language classification.
- Register the unsupported fallback for known languages without an implemented adapter.
- Reject or explicitly handle unknown language IDs.
- Expose predictable lookup and registration methods.
- Prevent accidental duplicate registration unless replacement is an intentional, tested operation.

Initial state:

- JavaScript and TypeScript may be registered as planned adapters only if Phase 06 integration is ready; otherwise they must remain explicitly unsupported in Phase 05B.
- All other languages remain unsupported until their implementation phases.
- Do not label an adapter as implemented merely because it is registered.

### 5.6 `ParserScheduler.js`

**Responsibility:** Execute parser tasks with bounded concurrency and per-file resource limits.

Initial proposed settings:

- Per-file timeout: 5,000 ms.
- Concurrency: configurable, conservative default selected after inspecting runtime/deployment constraints.
- Queue size: bounded or guarded by an explicit maximum input count.
- No unbounded task creation.

Important distinction:

**A Promise timeout is not a hard CPU timeout.** `Promise.race()` can stop waiting for a promise, but it does not terminate CPU-bound JavaScript parsing. If parsing blocks the event loop, the timeout callback may not run promptly.

Therefore:

- If adapters execute on the main event loop, document that the timeout is cooperative and cannot guarantee termination of CPU-bound work.
- For a hard timeout, run parser execution in worker threads and terminate/replace the worker when its deadline expires.
- Worker threads are not a security sandbox.
- Do not add worker complexity without checking whether the selected parser libraries and current backend architecture support it cleanly.
- Ensure a timed-out task cannot later publish a second result.
- Ensure worker crashes do not permanently reduce pool capacity.
- Release resources and listeners on success, error, cancellation, and timeout.
- Keep retries bounded; do not retry deterministic syntax errors.

Tests:

- Concurrency never exceeds configured maximum.
- Tasks complete successfully.
- Adapter rejection becomes a per-file failure result.
- Timeout becomes a timed-out result.
- A timed-out task cannot later overwrite its result.
- Worker crash/replacement behavior, if workers are implemented.
- Queue limits are enforced.
- One file's failure does not cancel unrelated files unless explicitly requested.

### 5.7 `ParserService.js`

**Responsibility:** Orchestrate the parser pipeline and provide a stable API for future controllers.

Requirements:

1. Accept Phase 04 retrieval results.
2. Validate the input structure and required repository/file metadata.
3. Normalize the input without mutating the caller's objects.
4. Resolve the adapter through `ParserRegistry`.
5. Submit work to `ParserScheduler`.
6. Validate successful FileIR using `irValidator`.
7. Convert failures into structured per-file results.
8. Produce an aggregate repository summary.

Do not add an Express route or controller automatically in Phase 05B. First prove the service contract through tests. A route can be proposed separately when there is a concrete product/API requirement.

---

## 6. Result and status semantics

Keep parse status semantics explicit and consistent with the Phase 05A schema.

At minimum, distinguish these outcomes:

| Outcome | Meaning |
|---|---|
| `success` | Adapter produced FileIR that passed schema validation |
| `partial` | Adapter extracted some facts but reported syntax/recovery diagnostics |
| `unsupported` | No parser implementation is available for the language |
| `failed` | Unexpected parser or infrastructure error |
| `timed_out` | Execution exceeded its allowed deadline |
| `invalid` | Adapter returned an object that failed FileIR validation |

If the Phase 05A schema uses different exact enum values, the schema takes precedence. Do not introduce status values that the schema or result contract does not permit. Keep parse-result status distinct from any FileIR-internal parser status if the schema defines them separately.

Aggregate repository status should communicate full, partial, or failed coverage without hiding unsupported or skipped files.

---

## 7. Security and resource constraints

- Treat repository source as untrusted data.
- Never execute source files, build scripts, package scripts, or repository dependencies.
- Never install dependencies from analyzed repositories.
- Apply input size and file-count limits inherited from Phase 03/04.
- Do not log source contents, secrets, or full parser payloads by default.
- Bound concurrency, queue size, memory use, and execution time.
- Do not describe worker threads as a security sandbox.
- Keep authorization and tenant checks in the existing API boundary; parser services should not bypass them.
- Do not add database persistence in this milestone.

---

## 8. Dependency decision

Do not install dependencies before inspecting `package.json`, lockfiles, Node version, and existing validation utilities.

If AJV is not already present, evaluate adding it as the JSON Schema validator. Confirm the schema draft supported by the chosen AJV version; the Phase 05A schema is Draft 2020-12, so the validator configuration/version must support that draft.

Avoid adding a parser library in Phase 05B. Language-specific parser dependencies belong to the relevant adapter phase.

---

## 9. Test and acceptance criteria

Phase 05B is complete only when all applicable criteria pass:

### Contract and validation

- [ ] Phase 04 input shape is verified against the actual retrieval implementation.
- [ ] FileIR schema is loaded from one authoritative location.
- [ ] Schema validator compiles once and validates representative fixtures.
- [ ] Invalid FileIR produces structured validation errors.
- [ ] Builders create schema-compliant objects.
- [ ] Deterministic ID behavior and limitations are documented.

### Adapter and registry

- [ ] Base adapter contract is explicit and tested.
- [ ] Unsupported adapter returns a structured unsupported result.
- [ ] Registry uses canonical language IDs from the existing language registry.
- [ ] Unimplemented languages are not falsely reported as parsed.

### Scheduling

- [ ] Concurrency is bounded.
- [ ] Per-file timeout behavior is tested.
- [ ] CPU-bound timeout limitations are documented, or hard termination is implemented using workers.
- [ ] Failures are isolated per file.
- [ ] Queue and resource limits are tested.

### Service integration

- [ ] ParserService accepts actual Phase 04 output.
- [ ] Successful output passes FileIR validation.
- [ ] Aggregate summary reports partial/unsupported/failure coverage.
- [ ] No GitHub refetching occurs in the parser layer.
- [ ] No database migration or unrelated security changes are introduced.

### Quality

- [ ] Existing backend tests remain passing.
- [ ] New tests pass.
- [ ] Linting/formatting passes where configured.
- [ ] No unrelated Phase 03/04 behavior regresses.
- [ ] Implementation notes document any deviations from Phase 05A.

---

## 10. Recommended implementation sequence

1. **Repository inspection and interface confirmation**  
   Inspect Phase 04 retrieval output, language registry, module conventions, test setup, Node version, and dependencies.

2. **IR validator**  
   Integrate the authoritative schema and add validator tests.

3. **IR builder**  
   Implement schema-aligned pure builder helpers and deterministic IDs.

4. **Adapter contract and unsupported adapter**  
   Define and test the common interface and fallback behavior.

5. **Parser registry**  
   Reuse canonical language IDs and register implemented/unimplemented adapters accurately.

6. **Parser scheduler**  
   Implement bounded concurrency and the agreed timeout strategy.

7. **Parser service**  
   Connect the components and verify end-to-end behavior with fixtures based on actual Phase 04 results.

8. **Phase 05B acceptance review**  
   Run targeted tests plus the existing backend suite and record the exact results.

---

## 11. Approval gates

Before implementation, the developer should receive:

- The exact Phase 04 retrieval result shape.
- The exact location and contents of the authoritative FileIR schema.
- The existing backend module format and test conventions.
- A decision on whether worker threads are required immediately or whether the first scheduler is explicitly cooperative.
- The final concurrency, timeout, and queue limits.

No source files should be modified and no dependencies should be installed until the implementation plan is reviewed and approved.

---

## 12. Definition of done

Phase 05B is complete when Cartograph has a tested, reusable parser infrastructure that can safely accept Phase 04 retrieved files, dispatch them through a canonical registry, produce structured per-file outcomes, and validate successful FileIR output against the Phase 05A schema.

**Phase 05B does not mean that all languages are parsed.** It establishes the infrastructure that Phase 06 and later phases will use to implement language-specific adapters.

**Next milestone:** Phase 06 — JavaScript and TypeScript Parser Adapter.
