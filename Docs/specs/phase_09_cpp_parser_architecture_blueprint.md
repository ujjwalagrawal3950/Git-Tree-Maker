# Cartograph Phase 09 — C/C++ Parser Architecture & Technology Inspection

**Document type:** Phase 09 architecture and implementation-planning blueprint  
**Status:** Proposed — inspection and design only  
**Implementation approval:** Not granted by this document

## 1. Purpose

Phase 09 establishes how Cartograph will parse C and C++ repositories and represent source-level relationships using the existing language-neutral FileIR. The immediate objective is architecture inspection, technology compatibility assessment, and an implementation-ready design. This document does **not** authorize parser implementation.

## 2. Existing architecture constraints

Preserve the current stack:

- Frontend: React 19, Vite, JSX, Tailwind CSS v3.
- Backend: Node.js, Express 5, JavaScript.
- Parser architecture: existing ParserService, ParserRegistry, ParserScheduler, adapters, resolvers, and FileIR v1.0.0.
- Parsing technology: existing Tree-sitter runtime.
- Repository input: verified GitHub metadata, manifest, and bounded selective source retrieval.

Non-negotiable constraints:

1. Reuse FileIR v1.0.0 unless a concrete requirement proves it insufficient. Any schema change requires separate approval.
2. Reuse the existing parser facade, registry, scheduler, worker isolation, validation, and error-handling patterns.
3. Do not migrate the backend to TypeScript or Python.
4. Do not introduce a JVM, compiler toolchain, build daemon, microservice, or external parsing service.
5. Never execute repository code, compiler commands, CMake, Make, Ninja, configure scripts, shell scripts, or build scripts.
6. Do not clone entire repositories or bypass bounded source retrieval.
7. During initial inspection, do not install dependencies, edit source files, modify lockfiles, or change configuration.
8. Keep syntax facts, resolver conclusions, and heuristic inferences distinct.

## 3. Phase 09 scope

### In scope

- C: `.c`
- C++: `.cc`, `.cpp`, `.cxx`
- Headers: `.h`, `.hh`, `.hpp`, `.hxx`
- Optional `.ipp`, `.tpp`, `.inl`, `.inc` support only if the existing registry can classify them safely.
- Tree-sitter runtime and grammar compatibility.
- C/C++ syntax extraction into FileIR.
- Header/source relationships and include resolution.
- C++ namespaces, classes, structs, unions, enums, functions, methods, templates, and declarations/definitions.
- C declarations, structs, unions, enums, typedefs, functions, and variables.
- Preprocessor directives and conditional-compilation limitations.
- Bounded, non-executing build metadata reading where justified.

### Out of scope

- Compiling or executing source code.
- Running preprocessors or expanding macros.
- Full C++ overload resolution or template instantiation.
- ABI, linker, binary, or runtime call-graph analysis.
- Compiler-grade semantic modeling.
- Cross-language service/API inference based on naming similarity.
- FileIR schema changes without separate approval.
- Production deployment changes.

## 4. Why C/C++ needs a dedicated design

### 4.1 Header/source relationships

A declaration may live in a header while its definition lives in a source file. A header may be included by many translation units. Cartograph must distinguish:

- File-level `#include` relationships.
- Declarations and definitions.
- Possible declaration-to-definition associations.
- Resolved include candidates versus unresolved includes.

An include edge is not proof that every declaration in the included file is used.

### 4.2 Preprocessor and conditional compilation

C/C++ syntax trees can depend on macros, compiler flags, target platform, and include paths. Without a known compilation configuration and a real preprocessor, Cartograph cannot claim which conditional branch is active.

Preserve directives and conditional structure as evidence. Never silently select one branch as active.

### 4.3 Include resolution

Resolution may depend on quoted versus angle-bracket includes, source directories, project include directories, compiler-specific paths, build targets, platform macros, and generated headers. The resolver must preserve uncertainty and ambiguity rather than guess from a basename.

### 4.4 C++ language complexity

Namespaces, nested types, templates, specializations, overloads, operator functions, constructors, destructors, lambdas, and split declarations require syntax-aware extraction. Phase 09 should not claim compiler-grade semantic resolution.

## 5. Technology inspection

Investigate these candidates:

- `tree-sitter-c`
- `tree-sitter-cpp`
- The currently installed `tree-sitter` runtime.

Do not assume compatibility based on package names or documentation alone.

For each candidate, record:

- Exact package version.
- Declared peer dependencies.
- Native binding requirements.
- Node.js compatibility.
- Runtime compatibility with the installed Tree-sitter version.
- Whether the grammar loads through the existing parser runtime.
- Whether representative C/C++ syntax produces usable trees.
- Clean installation implications, including whether `--legacy-peer-deps` is required.
- Windows/Linux deployment implications.
- Whether both grammars can coexist in the same process and worker model.

**Do not install packages during Step 0.** If runtime verification requires installation or code changes, document the proposed test and request approval first.

### Decision criteria

Prefer an approach that works in the current Node.js backend, fits ParserScheduler and worker isolation, does not execute repository code, supports required syntax, has maintainable native dependencies, and can be installed reproducibly in Linux CI/container builds.

Do not independently switch to Clang, libclang, a Python parser service, or compiler subprocesses.

## 6. Proposed parser pipeline

```text
Repository Manifest
        |
Selective Source Retrieval
        |
Language / Extension Classification
        |
ParserService -> ParserRegistry -> Bounded ParserScheduler
        |
        +-----------------------+
        |                       |
     C Adapter              C++ Adapter
        |                       |
     Tree-sitter             Tree-sitter
        |                       |
        +-----------+-----------+
                    |
            Syntax Extraction
                    |
                FileIR
                    |
             FileIR Validation
                    |
             C/C++ Resolvers
                    |
              Unified Graph
```

The exact adapter organization must be decided after compatibility inspection. A shared adapter is acceptable only if it does not blur C and C++ syntax semantics.

Parser responsibilities:

- Parse only bounded, retrieved source content.
- Emit FileIR v1.0.0.
- Preserve useful partial output when syntax errors occur.
- Emit source-located diagnostics.
- Never execute macros, includes, compiler directives, or source code.
- Respect existing scheduler timeouts and worker termination.
- Keep syntax extraction separate from repository-level resolution.

## 7. FileIR mapping proposal

This is a proposal, not permission to change the schema. Inspect the actual schema and strict validator before implementation.

| C/C++ concept | Proposed representation |
|---|---|
| Function declaration/definition | `Symbol` with function kind and declaration location |
| Class / struct / union | `Symbol` with type kind |
| Enum / enumerator | Existing symbol representation where supported |
| Typedef / type alias | `Symbol` and/or `TypeReference`, according to schema |
| Namespace | Parent/qualified symbol relationship where supported |
| Include directive | Existing import-like fact, with language metadata for include form |
| Macro definition | Existing symbol or language metadata only if supported |
| Macro invocation | Occurrence/call-like fact only where semantics are clear |
| Template declaration | Symbol plus language metadata if required |
| Function call | `CallSite` |
| Base class | `Inheritance` |
| Type usage | `TypeReference` |
| Conditional preprocessor structure | Existing diagnostic/metadata only if supported; otherwise document limitation |
| Declaration/definition association | Resolver output, not an invented syntax fact |

Do not overload `Import` to imply C/C++ module semantics. Preserve include kind, delimiter form, and original spelling in supported language metadata.

If FileIR cannot represent a required fact, document the exact gap and propose the smallest schema extension separately. Do not emit unsupported properties that the strict validator rejects.

## 8. Extraction requirements

### C

Inspect support for:

- Function declarations/definitions, parameters, and return types.
- Variables and storage classes.
- Structs, unions, enums, and typedefs.
- Pointers, arrays, and function pointers.
- `const`, `volatile`, and `restrict`.
- Include directives and macros.
- Conditional directives.
- Function calls.
- Accurate locations and syntax diagnostics.

### C++

Inspect support for:

- Namespaces and nested namespaces.
- Classes, structs, and unions.
- Constructors, destructors, member functions, and fields.
- Access specifiers and inheritance.
- Enums and scoped enums.
- Function and type aliases.
- Templates and template parameters.
- Explicit specializations where exposed by the grammar.
- Operator overload declarations.
- Lambdas and call expressions.
- `using` declarations/directives.
- Includes and conditional directives.
- Accurate locations and syntax diagnostics.

### Declaration versus definition

Define how to distinguish function prototypes from definitions, class forward declarations from definitions, and `extern` declarations from definitions where syntax permits. Do not infer actual linker resolution from syntax alone.

## 9. Include resolution design

Implement a dedicated resolver rather than mixing repository resolution into the parser adapter.

Potential evidence, strongest first:

1. Exact repository-relative include path under a known include root.
2. Explicit include directories extracted from supported build metadata.
3. Source file directory for quoted includes, following known search rules.
4. A unique repository candidate under a documented heuristic.
5. Unresolved or ambiguous when multiple candidates remain.

Preserve include forms:

- Quoted: `#include "local_header.h"`
- Angle-bracket: `#include <system_header.h>`
- Macro-based: `#include HEADER_MACRO`

An angle-bracket include is not automatically external; projects may use angle brackets for their own include directories.

Resolution outcomes must distinguish internal resolved, external/system, unresolved, ambiguous, and unsupported/conditional/uncertain. Reuse existing status vocabulary only where semantically appropriate.

Do not:

- Create an internal edge from basename matching alone.
- Assume absent generated headers exist.
- Resolve macro-based includes without explicit evidence.
- Claim a conditional include is active.
- Discard plausible candidates when resolution is ambiguous.

## 10. Build metadata inspection

Investigate bounded, non-executing readers for:

- `compile_commands.json`
- `CMakeLists.txt` and `*.cmake`
- `Makefile` / `makefile`
- Meson files only if justified.

`compile_commands.json`, when present and safely parsed as JSON, may provide translation units, working directories, include directories, macro definitions, compiler arguments, and language flags.

Treat it as untrusted repository data. Do not execute compiler commands or trust paths outside the repository.

CMake and Make are configuration/programming systems. Do not evaluate them. Any reader must extract only a bounded subset of literal declarations and document unsupported variable expansion, generator expressions, conditions, and computed paths.

## 11. Preprocessor policy

The initial implementation should be conservative:

- Extract include and macro directives where the grammar exposes them.
- Preserve conditional directive structure and locations.
- Do not execute macro expansion.
- Do not claim a branch is active without reliable compilation-configuration evidence.
- Do not synthesize declarations from macro expansions.
- Emit uncertainty or diagnostics for constructs that cannot be statically interpreted.

Example:

```c
#ifdef USE_FAST_PATH
#include "fast_impl.h"
#else
#include "safe_impl.h"
#endif
```

Record both include directives and their conditional context if supported. Do not claim both are compiled or arbitrarily select one.

## 12. Security and resource requirements

Reuse existing safeguards:

- Existing per-file and repository aggregate byte limits.
- Bounded parser concurrency.
- Worker termination for hard timeouts; `Promise.race` alone does not stop CPU-bound work.
- Strict input validation.
- Existing binary and invalid UTF-8 rejection.
- No source, shell, compiler, or build-script execution.
- No unbounded include traversal, macro expansion, or template instantiation.
- No arbitrary filesystem access based on repository-supplied paths.
- No network access from adapters or resolvers.
- Safe diagnostics that do not expose host secrets or absolute host paths.

The resolver must operate only on the repository manifest and explicitly supplied bounded metadata.

## 13. Implementation test plan

### Grammar and parser

- Minimal valid C and C++ translation units.
- Header-only declarations and source definitions.
- Nested namespaces and types.
- Templates.
- Function pointers and complex declarators.
- Macros and conditional compilation.
- Malformed source with useful partial extraction.
- UTF-8 and source-location correctness.

### Include resolver

- Quoted include resolved relative to source directory.
- Include resolved through explicit include directory.
- Angle-bracket include pointing to a repository-owned header.
- External/system classification with evidence.
- Missing include.
- Duplicate candidate paths.
- Macro-based include unresolved.
- Conditional includes preserve uncertainty.
- Generated header absent from manifest.
- Path traversal and absolute path rejection.

### Build metadata

- Valid and malformed `compile_commands.json`.
- Oversized metadata file.
- Include directories and macro definitions extracted as data.
- Paths outside repository rejected or safely ignored.
- Unsupported CMake/Make syntax remains unresolved.
- No build process is spawned.

### Integration

- Every emitted FileIR passes the strict validator.
- C/C++ dispatch uses the existing registry.
- Parser timeout terminates the worker.
- Useful syntax-error output is marked partial where appropriate.
- Resolver output remains separate from syntax facts.
- Existing Phase 01–08 tests remain green.

## 14. Step 0 — targeted inspection tasks

The coding agent must perform only these inspections:

1. Inspect `Backend/package.json` and `package-lock.json` for current Tree-sitter runtime and grammar versions.
2. Inspect existing JavaScript, Python, and Java adapters and their shared contract.
3. Inspect ParserRegistry, ParserScheduler, ParserService, FileIR builder, strict validator, and language registry.
4. Inspect the actual FileIR schema for imports, language metadata, symbols, type references, inheritance, diagnostics, and locations.
5. Inspect source retrieval extension registry, especially current `.h` classification.
6. Inspect parser tests and test scripts.
7. Inspect manifest behavior for duplicate basenames, generated files, and source-root hints.
8. Inspect whether build metadata is retrieved under current limits.
9. Compare candidate grammar metadata against current Node.js and Tree-sitter versions without installing anything.
10. Produce an architecture decision record with unresolved questions and an implementation sequence.

### Step 0 deliverables

Return:

- Current parser architecture summary based on actual code.
- Exact current dependency versions and candidate grammar compatibility table.
- Recommended C/C++ adapter organization.
- FileIR mapping table identifying unsupported concepts.
- Extension classification proposal, especially `.h`.
- Include resolution algorithm and evidence hierarchy.
- Preprocessor handling policy.
- Build metadata scope and limitations.
- Resource and security considerations.
- Proposed file-by-file implementation plan.
- Test plan and acceptance criteria.
- Decisions requiring user approval.

### Prohibited during Step 0

- No file edits.
- No dependency installation/removal.
- No package or lockfile changes.
- No schema changes.
- No parser implementation.
- No build-system execution.
- No production configuration changes.

If the existing repository cannot answer a question, state that it is unverified and propose a safe verification step. Do not guess.

## 15. Proposed implementation sequence after approval

| Step | Workstream | Expected output |
|---|---|---|
| 09A | Architecture and technology inspection | Approved architecture decision record |
| 09B | Grammar integration and adapter skeleton | C/C++ dispatch and basic FileIR |
| 09C | C syntax extraction | C declarations, types, calls, directives |
| 09D | C++ syntax extraction | Namespaces, types, methods, templates |
| 09E | Include and repository resolver | Evidence-based resolution |
| 09F | Build metadata reader | Bounded compile database and supported metadata |
| 09G | Hardening and regression | Full tests and installation/deployment verification |

This sequence is proposed only. The user must approve each meaningful implementation boundary before source changes or dependency installation.

## 16. Phase 09 acceptance criteria

Phase 09 is complete only when:

1. C and C++ files are classified without breaking existing language detection.
2. The selected grammar/runtime works in the actual backend runtime.
3. Adapters emit valid FileIR v1.0.0 without unapproved schema changes.
4. Declarations and definitions are extracted with accurate locations.
5. Header relationships are represented without pretending they are module imports.
6. Include resolution preserves unresolved and ambiguous cases.
7. Conditional compilation is represented conservatively.
8. Build metadata is read as bounded data only; no scripts or compiler commands execute.
9. Resource limits and hard timeouts are enforced.
10. Targeted tests, full backend tests, and frontend production build pass.
11. A clean installation is verified in the intended CI/container environment before claiming deployment readiness.
12. Limitations are documented, including macro expansion, compiler-specific behavior, templates, and incomplete semantic resolution.

## 17. Decision requested after Step 0

The coding agent must conclude with:

- Recommended grammar/runtime choice and supporting evidence.
- Separate adapters versus shared adapter with language-specific extractors.
- `.h` classification strategy and ambiguity handling.
- Whether `compile_commands.json` should be the first supported build metadata source.
- Exact files and dependencies proposed for the first implementation step.
- Risks and unresolved compatibility questions.
- Explicit request for approval before implementation.

**Stop after Step 0. Do not implement Phase 09 until the architecture report has been reviewed and approved.**
