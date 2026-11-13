# Cartograph — Phase 06 Implementation Blueprint
## JavaScript and TypeScript Parser Adapter

**Status:** Implementation blueprint, not an implementation report  
**Prerequisites:** Phase 03 manifest, Phase 04 selective retrieval, Phase 05A Unified FileIR, Phase 05B parser core  
**Stack:** Existing Node.js / Express modular monolith

---

## 1. Objective

Implement Cartograph's first real language adapters: JavaScript and TypeScript. Reuse Phase 05B's `ParserService`, `ParserRegistry`, `BaseAdapter`, `ParserScheduler`, `irBuilder` and `irValidator`.

The adapter converts retrieved JS/TS files into schema-valid, language-neutral FileIR. It extracts syntax facts and diagnostics. A separate JS/TS module-resolution stage interprets statically known module specifiers using repository manifest and supported configuration. The Phase 10 graph engine remains responsible for unified graph construction.

**Phase 06 does not implement other language adapters, RAG, embeddings, or the unified graph engine.**

## 2. Expected outcome

For an immutable repository commit, Cartograph should:

1. Parse eligible JavaScript and TypeScript files retrieved in Phase 04.
2. Extract declarations, imports, exports, calls and available type syntax.
3. Preserve deterministic IDs and accurate source locations.
4. Recover useful facts from files with recoverable syntax errors.
5. Recognize ESM, re-exports, supported dynamic imports and statically recognizable CommonJS patterns.
6. Resolve supported repository-local module references using documented rules.
7. Classify external, built-in, unresolved, ambiguous and dynamic references.
8. Validate all successful FileIR against the authoritative Phase 05A schema.
9. Report partial coverage and limitations honestly.
10. Never execute repository source, build scripts, configuration code or dependencies.

## 3. Scope

### In scope
- JavaScript and TypeScript adapters, including JSX/TSX where supported.
- Parser library evaluation and integration.
- Declaration and symbol extraction.
- Imports, exports, re-exports and supported dynamic imports.
- Statically recognizable CommonJS `require` / export patterns.
- Syntactic call-site extraction.
- TypeScript type annotations, interfaces, aliases, generics and inheritance syntax.
- Source-location normalization.
- Syntax diagnostics and partial parsing.
- JS/TS module resolution for a documented subset of rules.
- Fixture, resolver, regression and pinned-repository tests.

### Out of scope
- Python, Java, C/C++ and other language adapters.
- Full TypeScript type checking or compiler semantic analysis.
- Executing source files or installing repository dependencies.
- Complete emulation of Node, Webpack, Vite or arbitrary bundler configuration.
- Runtime call graph, control-flow or data-flow analysis.
- Cross-language service/API inference.
- Unified graph persistence/analytics (Phase 10).
- Embeddings, semantic search and RAG (Phases 13–14).
- Commit comparison and webhooks (Phases 15–16).

## 4. Architecture

```text
Phase 04 retrieved JS/TS files
              |
              v
       Phase 05B ParserService
              |
              v
          ParserRegistry
              |
              v
     JavaScript / TypeScript Adapter
              |
              v
          Parser AST
              |
              v
       Syntax fact extraction
       /       |       |       \
   Symbols  Imports  Exports  Calls/Types
       \       |       |       /
              v
          FileIR Builder
              |
              v
          IR Validator
              |
              v
       Validated JS/TS FileIR
              |
              v
      JS/TS Module Resolver
              |
              v
   Resolution facts + diagnostics
              |
              v
     Phase 10 Unified Graph Engine
```

### Responsibility boundaries

- **Adapter:** Extracts facts directly supported by source syntax.
- **FileIR builder:** Normalizes facts using the common schema.
- **Validator:** Checks schema compliance.
- **Module resolver:** Resolves imports against repository files/configuration using explicit rules.
- **Phase 10:** Builds and validates the unified graph.
- **LLM:** Explains evidence; it does not create authoritative dependency edges.

Never silently turn an import string into a verified file edge.

## 5. Parser-library decision

Before installing anything, inspect `package.json`, lockfiles, Node version, module format, current Phase 05B contract and test conventions.

Evaluate at least:

| Candidate | Strengths | Trade-offs |
|---|---|---|
| TypeScript Compiler API | Native TS/TSX syntax, rich AST, source information | Large API; semantic/program workflows can be costly and configuration-sensitive |
| Babel parser | Mature JS/TS syntax parsing, configurable plugins, error recovery, ESTree-like ecosystem | TS support is syntax parsing, not a type checker; AST shape differs |

Compare grammar coverage, JSX/TSX, CommonJS, error recovery, source locations, performance, Node compatibility, maintenance, license, dependency footprint and extraction ergonomics.

Before coding, record:
- Selected library and exact version.
- Rationale and alternatives.
- AST details affecting extraction.
- Known limitations.
- License/runtime compatibility.
- Dependency changes requiring approval.

**Do not install packages before approval.** Do not load or execute repository plugins/configuration to parse source.

## 6. File types and canonical language IDs

Reuse Phase 04's language registry as the source of truth. Verify how it classifies these extensions:

| Extension | Intended parsing mode |
|---|---|
| `.js` | JavaScript |
| `.jsx` | JavaScript + JSX |
| `.mjs` | JavaScript ES module |
| `.cjs` | JavaScript CommonJS |
| `.ts` | TypeScript |
| `.tsx` | TypeScript + JSX |
| `.mts` | TypeScript ES module |
| `.cts` | TypeScript CommonJS |

Do not create a competing language registry. If module flavor is not represented in the current canonical language ID, preserve it as file metadata or parser options. Unsupported modes must be reported explicitly.

## 7. FileIR extraction contract

Follow the exact Phase 05A schema. Do not create a JS-specific output schema or add undocumented fields.

### 7.1 Symbols and declarations

Extract supported forms:
- Function declarations and named function expressions.
- Named arrow functions/function expressions assigned to variables or properties.
- Classes, constructors, methods, accessors and fields.
- Variables (`const`, `let`, `var`).
- TypeScript interfaces, type aliases, enums and namespaces/modules where supported.

Preserve schema-supported fields:
- Deterministic ID, name and symbol kind.
- Parent/container relationship if represented.
- Export state (including unknown where applicable).
- Visibility/modifiers where available.
- Parameters, explicit type annotations and return annotations.
- Generic/type parameters.
- Documentation only if supported by schema/policy.
- Source location.

Do not invent inferred types. Syntax-only type annotations are not equivalent to compiler-verified types.

### 7.2 Imports

Recognize:
- Default, named and namespace imports.
- Side-effect imports.
- Type-only imports and specifiers.
- Re-exports from another module.
- `export * from`.
- Statically known `import("literal")`.
- Statically known `require("literal")`.

Preserve original specifier, syntax kind and imported/local names where the schema allows.

```js
import React from "react";
import { useState as state } from "react";
import "./styles.css";
import type { User } from "./types";
const helper = require("./helper");
const lazy = import("./lazy-module.js");
```

Dynamic/non-literal expressions such as `require(variable)` or `import(variable)` must be marked dynamic/unresolved. Never evaluate expressions or guess their values.

### 7.3 Exports

Recognize named/default exports, exported declarations, export lists, re-exports, `export *`, and statically recognizable CommonJS `module.exports` / `exports.name` patterns.

Do not classify arbitrary properties named `exports` as CommonJS without syntax/context evidence.

### 7.4 Calls

Extract syntactically identifiable direct calls, member calls, constructor calls and optional calls where supported. Preserve callee expression/name and source location.

Do not claim a call targets a particular symbol unless a later resolution step proves it. Dynamic dispatch, aliasing and callbacks may make the target unknown.

### 7.5 Type facts

For TypeScript syntax, extract available parameter/variable/return annotations, interfaces, aliases, generic parameters/references, `extends` and `implements` clauses.

JavaScript JSDoc may be extracted only if the parser and schema support it. Label it as annotation/documentation evidence, not compiler certainty.

### 7.6 Evidence

Facts used later for graph edges should retain enough provenance to identify:
- Repository and immutable commit.
- File path and blob SHA.
- Source range.
- Fact kind and original specifier.
- Parser/normalization version.

If the schema cannot represent a required fact, propose a versioned schema change separately. Do not silently weaken validation.

## 8. Source locations

Follow Phase 05A conventions:
- Lines: 1-based.
- Columns: 0-based.
- End positions: exclusive.
- Offsets: 0-based UTF-16 code units if that is the schema's defined convention.

Normalize parser-library coordinates in one utility. Do not mix byte offsets, Unicode code points and JS UTF-16 offsets.

Test first character, empty file, multiline declarations, LF/CRLF, Unicode before a node, JSX/TSX, EOF and malformed syntax.

## 9. Syntax errors and partial parsing

A malformed file must not abort repository analysis.

- Preserve parser diagnostics and source locations.
- Use `partial` when facts were extracted despite recoverable syntax errors, if the current status contract permits it.
- Use `failed` for unexpected parser/infrastructure failures.
- Use `unsupported` for unsupported language/syntax modes.
- Use `invalid` for FileIR that fails schema validation only if this is part of the existing contract.
- Do not silently discard diagnostics.
- Keep statuses consistent with Phase 05A/05B; do not invent new enum values without approval.

## 10. JavaScript/TypeScript module resolution

Keep this separate from AST extraction. The roadmap includes JS/TS resolution in Phase 06; Phase 10 consumes verified resolution facts to build the unified graph.

### Inputs
- Parsed import/re-export facts.
- Phase 03 repository manifest and eligible paths.
- Phase 04 retrieved supporting config files, when available.
- Immutable commit identity.
- Explicitly supported resolver options.

No GitHub refetching inside the parser/resolver.

### Resolution outcomes

Use a distinct resolution status vocabulary (not FileIR parse status):

- `internal_resolved`
- `external_package`
- `builtin`
- `unresolved`
- `ambiguous`
- `dynamic`
- `excluded` (only if needed and supported)

### Incremental resolution rules

Implement and test a small deterministic subset in this order:

1. Relative specifiers (`./x`, `../x`).
2. Exact path matches.
3. Supported extension probing.
4. Supported directory/index resolution.
5. Bare package classification.
6. Node.js built-in classification.
7. Explicitly supported TypeScript path aliases.
8. Package `imports`/`exports` mappings only if safely and correctly supported.

Do not claim full Node, TypeScript, Webpack, Vite or bundler resolution compatibility.

### Configuration

Potential read-only context:
- `package.json`
- `tsconfig.json` and referenced configs
- `jsconfig.json`
- Explicitly supported bundler alias configuration only if it can be parsed safely without evaluating code.

Treat configuration as untrusted data. Never execute it, load plugins, run build tools or install dependencies. Start with a documented subset.

### Evidence and ambiguity

If multiple candidates match, return `ambiguous`. Do not choose by guesswork.

For every successful internal resolution, preserve:
- Source import fact/location.
- Original specifier.
- Resolved repository-relative path.
- Rule used.
- Relevant configuration evidence.
- Resolver version.

Only verified repository-local resolutions may become internal dependency edges later.

## 11. Testing strategy

### Parser fixtures

Include fixtures for:
- Plain JS, JSX, ESM and CommonJS.
- TS and TSX.
- Type-only imports/exports.
- Classes, methods and inheritance.
- Interfaces, aliases and generics.
- Dynamic imports and re-exports.
- Static and dynamic `require`.
- Syntax errors and incomplete source.
- Unicode and line-ending cases.

For every fixture: parse, assert extracted facts, validate FileIR, check source locations, diagnostics/status and deterministic IDs.

### Resolver tests

Test relative/parent imports, exact paths, extension probing, index resolution, missing targets, ambiguity, bare packages, Node built-ins, supported TS aliases, type-only imports, re-exports, dynamic imports, static/dynamic require, case sensitivity, excluded files and missing/malformed/unsupported configuration.

### Pinned repository tests

Use representative real repositories at pinned commit SHAs. Record:
- Commit SHA.
- Manifest/eligible/retrieved JS/TS file counts.
- Success/partial/failed/unsupported parse counts.
- Imports/exports extracted.
- Resolved/unresolved/ambiguous counts.
- Known limitations.

A moving default branch is not a reproducible test identity.

### Regression/resource tests

- One malformed file does not abort other files.
- Scheduler concurrency and timeouts remain bounded.
- Phase 03/04 size limits remain in force.
- No repository source is executed.
- Existing Phase 05B tests remain passing.
- Frontend build remains clean if shared contracts change.

## 12. Resource and security constraints

- Reuse Phase 03/04 file-count and byte limits.
- Preserve Phase 05B concurrency and timeout settings unless measurements justify a reviewed change.
- Avoid parsing a file twice in one analysis request.
- Do not build a full TypeScript semantic program by default for every file.
- Release AST memory after extraction.
- Bound diagnostics/entity counts for pathological inputs.
- Measure parse duration and memory before tuning.
- A Promise timeout does not terminate CPU-bound work; verify actual worker termination if a hard timeout is claimed.
- Never execute repository code, scripts, config or plugins.
- Never install repository dependencies.
- Preserve existing authentication and tenant boundaries.

## 13. Proposed module structure

Adapt to the real Phase 05B layout; do not refactor merely to match this sketch.

```text
Backend/services/parser/
├── adapters/
│   ├── BaseAdapter.js
│   ├── UnsupportedAdapter.js
│   └── javascript/
│       ├── JavaScriptAdapter.js
│       ├── TypeScriptAdapter.js
│       ├── parserFactory.js
│       ├── declarationExtractor.js
│       ├── importExtractor.js
│       ├── exportExtractor.js
│       ├── callExtractor.js
│       ├── typeExtractor.js
│       ├── locationMapper.js
│       └── diagnostics.js
├── resolvers/javascript/
│   ├── JavaScriptModuleResolver.js
│   ├── candidateResolver.js
│   ├── packageClassifier.js
│   └── configReader.js
├── builders/irBuilder.js
├── validation/irValidator.js
├── registry/ParserRegistry.js
├── scheduler/ParserScheduler.js
├── ParserService.js
└── __tests__/
    ├── javascript-adapter.test.js
    ├── typescript-adapter.test.js
    ├── locations.test.js
    ├── diagnostics.test.js
    ├── module-resolution.test.js
    └── repository-analysis.test.js
```

This is a logical proposal, not a requirement to create every file. Prefer cohesive modules and existing naming conventions.

## 14. Implementation sequence

### Step 1 — Targeted Phase 05B inspection
Inspect current BaseAdapter, registry, ParserService, scheduler, IR builder/validator, authoritative schema, Phase 04 language/retrieval contracts, package files, Node version and test conventions.

Deliver before coding:
- Reuse map.
- Exact Phase 04 input and adapter contract.
- Parser-library comparison/recommendation.
- Dependency changes.
- Exact files to change.
- Tests, risks and staged plan.

Wait for approval before source edits or package installation.

### Step 2 — Parser integration
Integrate the approved parser library and syntax-mode selection. Add smoke tests. Verify no repository code executes.

### Step 3 — Declaration extraction
Implement functions, classes, methods, variables and TypeScript declarations. Add source ranges, deterministic IDs and schema validation.

### Step 4 — Imports and exports
Implement ESM imports, re-exports, CommonJS patterns and static dynamic-import facts. Preserve unresolved/dynamic diagnostics.

### Step 5 — Calls and type facts
Extract syntactic call sites, explicit parameters/return/type references and inheritance. Do not fabricate semantic targets or inferred types.

### Step 6 — Partial parsing
Test recoverable syntax errors, diagnostics, per-file statuses and failure isolation.

### Step 7 — Module resolver
Implement relative paths, extension/index rules, external/builtin classification and the approved subset of aliases/configuration.

### Step 8 — Repository and performance validation
Run pinned repository tests, report coverage, measure performance and run the existing backend regression suite.

### Step 9 — Acceptance review
Report exact changes, tests, coverage and limitations. Stop and wait for approval before Phase 07.

## 15. Acceptance criteria

### Adapter/FileIR
- [ ] JS adapter registered through existing Phase 05B registry.
- [ ] TS adapter registered through the same registry.
- [ ] Supported extensions and modes documented.
- [ ] FileIR validates against the authoritative schema.
- [ ] Supported symbols/imports/exports/calls/type facts extracted.
- [ ] Source ranges follow the documented convention.
- [ ] IDs deterministic for identical immutable input and traversal order.
- [ ] Diagnostics preserved; partial parsing works where supported.
- [ ] Unsupported syntax does not create fabricated facts.

### Module resolution
- [ ] Extraction and resolution are separate.
- [ ] Relative resolution follows documented rules.
- [ ] External packages are not mistaken for repository files.
- [ ] Built-ins classified where identifiable.
- [ ] Dynamic specifiers are not guessed.
- [ ] Ambiguous imports remain ambiguous.
- [ ] Internal resolutions have traceable evidence.
- [ ] Config is read as data, never executed.
- [ ] Limitations documented.

### Reliability/security
- [ ] One invalid file does not abort repository analysis.
- [ ] Existing size/concurrency/timeout safeguards respected.
- [ ] No repository code/build scripts/configuration executed.
- [ ] No repository dependencies installed.
- [ ] Existing authorization/tenant isolation preserved.
- [ ] No unnecessary migrations or infrastructure introduced.

### Quality
- [ ] Parser fixtures pass.
- [ ] Resolver tests pass.
- [ ] Pinned repository tests pass.
- [ ] Existing Phase 05B tests pass.
- [ ] Lint/build checks pass where configured.
- [ ] Coverage and known limitations reported honestly.

## 16. Engineering rules

1. Syntax facts are not resolved dependencies.
2. Do not fabricate types or call targets.
3. Do not guess module targets; ambiguity is a valid result.
4. Never execute repository content.
5. Do not overclaim Node/bundler compatibility.
6. Do not weaken FileIR validation to make tests pass.
7. Reuse Phase 05B; fix only verified defects.
8. Do not add API routes automatically; prove the ParserService contract first.
9. Do not start Phase 07 until JS/TS quality gates pass.
10. AI must never create authoritative graph edges.

## 17. Definition of done

Phase 06 is complete when Cartograph can process a pinned JS/TS repository snapshot through the Phase 05B infrastructure, emit schema-valid FileIR with accurate syntax facts and diagnostics, and resolve the supported repository-local module references with traceable evidence.

Unsupported syntax, unresolved imports, ambiguity and incomplete coverage must be reported explicitly. This is not full JavaScript/TypeScript runtime or bundler semantics.

**Next milestone:** Phase 07 — Python Parser and Import Resolution.

---

## 18. Coding-agent handoff prompt

> Implement Cartograph Phase 06: JavaScript and TypeScript Parser Adapter.
>
> First read this blueprint, Phase 05A architecture and FileIR schema, Phase 05B implementation, and the Phase 03/04 language and retrieval contracts.
>
> Inspect the actual repository before assuming proposed paths or interfaces. Reuse existing components.
>
> Before modifying files, report:
> 1. Current parser infrastructure and what can be reused.
> 2. Exact Phase 04 input shape and Phase 05B adapter contract.
> 3. TypeScript Compiler API vs Babel comparison.
> 4. Parser recommendation and rationale.
> 5. Exact files to create/modify.
> 6. Dependencies, risks and tests.
> 7. Staged implementation plan.
>
> Wait for explicit approval before installing dependencies or editing source.
>
> After approval, implement only approved Phase 06 scope. Preserve the current stack, schema, security boundaries and Phase 05B behavior. Do not implement other languages, RAG, embeddings, migrations or unrelated refactors.
>
> Keep syntax extraction separate from module resolution. Never execute repository code or configuration. Never invent symbol targets or resolution results. Validate successful FileIR against the authoritative schema.
>
> At completion, report exact files changed, commands actually run, tests, pinned-repository coverage, limitations and acceptance criteria marked passed/failed/not tested. Stop and wait for approval before Phase 07.
