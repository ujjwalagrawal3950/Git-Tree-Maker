# Cartograph — Phase 07 Implementation Blueprint
## Python Parser Adapter & Import Resolution

**Milestone:** Phase 07  
**Status:** Planned — implementation not yet started  
**Depends on:** Phase 03 Git Tree Manifest, Phase 04 Selective Source Retrieval, Phase 05A/B Unified FileIR and Parser Core, Phase 06 JavaScript/TypeScript Parser & Module Resolution  
**Primary outcome:** Parse Python source files into the existing language-neutral FileIR and resolve Python imports against the immutable repository manifest.

---

## 1. Objective

Implement Python static analysis as the next language adapter in Cartograph.

The Python subsystem must:

1. Consume source files already retrieved by Phase 04.
2. Parse Python syntax without executing repository code.
3. Extract declarations and syntax facts into the existing FileIR v1.0.0.
4. Resolve statically identifiable Python imports against the repository manifest.
5. Preserve unresolved, ambiguous, dynamic, and unsupported cases explicitly.
6. Integrate with the existing ParserRegistry, ParserScheduler, parser service, validation, authentication, and tenant authorization.
7. Avoid regressions in JavaScript/TypeScript parsing and all earlier phases.

**Non-goal:** Build a Python interpreter, execute imports, evaluate decorators, install repository dependencies, or perform full Python type checking.

---

## 2. Architectural Principles

### 2.1 Reuse the existing pipeline

```text
Phase 03 Immutable Repository Manifest
                 |
                 v
Phase 04 Retrieved Python Source Files
                 |
                 v
Existing ParserService / ParserScheduler
                 |
                 v
Existing ParserRegistry
                 |
                 v
          PythonAdapter
                 |
                 v
       Python Parser Engine
                 |
       +---------+----------+
       |         |          |
       v         v          v
  Declarations Imports  Type / Call Facts
       |         |          |
       +---------+----------+
                 |
                 v
           Existing irBuilder
                 |
                 v
          Existing irValidator
                 |
                 v
       Language-neutral FileIR
                 |
                 v
       PythonImportResolver
                 |
                 v
       Traceable Resolution Records
                 |
                 v
       Phase 10 Unified Dependency Graph
```

Do not create a parallel Python-only graph or a second FileIR format.

### 2.2 Facts and inferences must remain separate

- The parser records facts present in Python syntax.
- The import resolver determines whether an import target can be matched to a repository file or classified as external/standard-library/unknown.
- The Phase 10 graph engine owns final dependency-edge creation.
- Do not claim that a call site resolves to a function merely because the names match.
- Do not infer cross-language API dependencies from similar names.

### 2.3 No untrusted execution

Never use `exec`, `eval`, `compile`, `runpy`, `importlib` to load repository modules, subprocess execution of repository scripts, or package installation.

Treat all repository content as untrusted data, including:
- `.py` source files
- `pyproject.toml`
- `setup.py`
- `setup.cfg`
- `tox.ini`
- `requirements*.txt`
- `__init__.py`

Configuration may be parsed as data using bounded, safe parsers. Do not execute build backends, setup scripts, decorators, or module initialization.

---

## 3. Scope

### 3.1 Python files in scope

At minimum, recognize these source extensions:

| Extension | Treatment |
|---|---|
| `.py` | Python source |
| `.pyi` | Python interface/stub source |

The language registry should use one canonical language ID, `python`, unless the existing registry contract requires a separate file-kind field. Preserve the original extension and path in FileIR.

Optional later support, not required for this milestone:
- `.pyx` Cython
- `.pxd` Cython declarations
- `.ipynb` notebooks

Do not classify these optional formats as ordinary Python files unless their parsing support is explicitly implemented.

### 3.2 Extraction scope

**Declarations and symbols**
- Module-level and nested functions
- Async functions
- Classes
- Methods
- Constructors (`__init__` as a method, not a special graph edge)
- Parameters and parameter kinds
- Variable and annotated assignments
- Constants by naming convention only as a hint, not a semantic guarantee
- Nested classes and functions
- Decorators as syntax facts
- Base classes
- Type aliases where syntactically identifiable

**Imports**
- `import package`
- `import package.module`
- `import package as alias`
- `from package import name`
- `from package import name as alias`
- `from . import module`
- `from ..package import module`
- Parenthesized and multiline imports
- Imports under conditional blocks, functions, classes, and `try` blocks
- `TYPE_CHECKING` guarded imports as ordinary syntax imports with contextual metadata if supported

**Calls and type facts**
- Direct calls
- Attribute/member calls
- Constructor-like calls (syntactic only)
- Call locations and enclosing symbol
- Parameter and return annotations
- Variable annotations
- Generic/subscripted type expressions
- Base-class and metaclass expressions where representable

### 3.3 Explicitly out of scope

- Runtime call-target resolution
- Full type inference or type checking
- Evaluating decorators or metaclasses
- Resolving imports by executing Python's import machinery
- Installing or inspecting arbitrary third-party packages
- Dynamic import resolution for computed expressions
- Full framework-specific route discovery
- Cross-language service/API dependency inference
- Notebook parsing, Cython parsing, and Python 2 grammar unless separately approved

---

## 4. Parser Technology Selection

Phase 06 uses the official TypeScript Compiler API for JavaScript/TypeScript. Python requires a parser capable of producing a syntax tree from source text in the existing Node.js backend.

Evaluate the following options before adding a dependency:

| Option | Strengths | Risks / considerations |
|---|---|---|
| Tree-sitter Python grammar with Node binding | Concrete syntax tree, error recovery, source ranges, consistent future multi-language strategy | Native binding/build compatibility, grammar/runtime version compatibility, deployment packaging |
| Python parser compiled to WebAssembly | Avoids requiring a system Python runtime; may simplify deployment | Package maturity, WASM runtime cost, grammar/version coverage |
| Pure JavaScript Python parser | Potentially simpler installation | Verify Python grammar completeness, maintenance, locations, error recovery, and license |

### Required selection procedure

Before implementation:
1. Inspect `Backend/package.json`, lockfile, Node version constraints, module system, and deployment assumptions.
2. Inspect existing parser adapter conventions and scheduler input/output contracts.
3. Compare candidate parser package versions, grammar compatibility, license, maintenance, and native/WASM deployment requirements.
4. Run a small compatibility spike against representative Python snippets and malformed source.
5. Report the recommended package, exact dependency changes, trade-offs, and test evidence.
6. Wait for approval before installing a new dependency or changing source files.

**Recommendation:** Prefer a Tree-sitter-based Python grammar if the current Node runtime and deployment environment support it reliably. Do not assume package compatibility or add a native dependency without checking the actual project environment. Do not introduce a Python microservice or require a system Python installation for this phase.

---

## 5. Python Parser Contract

Implement a Python adapter that follows the existing `BaseAdapter` contract exactly.

The adapter should:
- Accept the same input shape used by JavaScriptAdapter and TypeScriptAdapter.
- Receive source text and manifest/repository context through existing parser service contracts.
- Return one schema-valid FileIR per input file.
- Use existing `irBuilder` helpers wherever possible.
- Use existing diagnostics and parser status conventions.
- Keep parser-specific implementation inside a Python adapter directory.
- Never fetch source files itself; Phase 04 owns retrieval.
- Never create or persist a separate graph.

Suggested structure (adapt to actual conventions after inspection):

```text
Backend/services/parser/
  adapters/
    python/
      parserFactory.js
      locationMapper.js
      PythonAdapter.js
      extractors/
        declarationExtractor.js
        importExtractor.js
        callExtractor.js
        typeExtractor.js
      helpers/
        decoratorExtractor.js
  resolvers/
    python/
      PythonImportResolver.js
      modulePathMapper.js
      packageClassifier.js
      configReader.js
```

Keep the structure proportionate. Do not create empty abstractions or one-file-per-trivial-helper modules without a concrete need.

---

## 6. FileIR Mapping Requirements

The existing FileIR v1.0.0 schema is authoritative. Do not silently change its field names, enums, or coordinate rules.

### 6.1 Symbols

Map Python declarations to existing symbol kinds where supported:
- `def` / `async def` → function
- `class` → class
- methods → method
- parameters → parameter metadata on the owning function/method
- assignments and annotated assignments → variable/constant only where the schema supports the distinction
- type aliases → existing type-alias representation where valid

Use `parentSymbolId` for nested declarations and class members when supported by the schema.

Do not classify every uppercase variable as a guaranteed constant. If the schema has no mutability or confidence field, preserve the name and use the closest valid symbol kind without claiming language-level immutability.

### 6.2 Parameters

Preserve, where the current schema allows:
- Parameter name
- Position
- Kind: positional-only, positional-or-keyword, var-positional (`*args`), keyword-only, var-keyword (`**kwargs`)
- Optional/default presence
- Default expression text (source text only; never evaluate)
- Annotation/type descriptor
- Source location

If the current schema cannot represent a Python parameter feature, document the limitation. Do not extend the schema without a separately reviewed change.

### 6.3 Decorators

Record decorator expressions as syntax facts if FileIR supports metadata or annotations. Do not execute decorators or assume their behavior.

Examples:
- `@staticmethod`
- `@classmethod`
- `@property`
- `@dataclass`
- Custom decorators

A decorator name is not proof of framework semantics.

### 6.4 Imports

Represent Python import forms using the existing language-neutral import model. Preserve:
- Original module expression
- Import form (`import` vs `from ... import`)
- Imported names
- Aliases
- Relative level (`.` count) for relative imports
- Whether the import is dynamic or statically specified
- Source location
- Conditional/nested context if the schema supports it

Do not force Python imports into JavaScript's ESM-specific fields. If the current FileIR schema cannot represent a necessary fact, stop and propose the smallest schema extension before implementation.

### 6.5 Calls and types

Extract call sites syntactically:
- `foo()`
- `obj.method()`
- `ClassName()`
- `super().__init__()`

Keep call resolution as `not_attempted` for Phase 10.

Extract type annotations and base-class expressions as syntax facts. Do not claim that annotation names are resolved types.

### 6.6 Source coordinates

Use the existing Cartograph convention:
- Lines: 1-based
- Columns: 0-based
- End positions: exclusive
- Offsets: follow the existing FileIR convention exactly

Tree-sitter and other parsers may use byte offsets while JavaScript strings use UTF-16 code units. Implement and test explicit conversion. Do not mix byte offsets, Unicode code points, and UTF-16 code units.

---

## 7. Python Import Resolution

Implement a dedicated resolver that consumes parsed import facts and the immutable Phase 03 manifest. It must not execute Python imports.

### 7.1 Resolution categories

Every import should receive a clear outcome using the existing resolution model where possible:
- `internal_resolved`
- `external_package`
- `standard_library`
- `unresolved`
- `ambiguous`
- `dynamic`
- `unsupported` or `unknown` only if supported by the existing schema

Do not add new status strings without checking the authoritative schema and validator.

### 7.2 Absolute imports

Examples:
```python
import requests
import myapp.services.auth
from myapp.models import User
```

Resolution strategy:
1. Normalize the module name into path segments.
2. Compare candidate module paths against the repository manifest.
3. Consider package directories containing `__init__.py`.
4. Consider namespace-package directories without `__init__.py`, but only where the resolver's evidence and policy allow it.
5. Preserve multiple valid candidates as ambiguous.
6. If no repository candidate exists, classify standard-library or external package only when there is sufficient evidence.
7. Otherwise mark unresolved/unknown; do not guess.

Do not assume that the first import segment always identifies an installed external package. A top-level name may be a local package, standard-library module, or third-party dependency.

### 7.3 Relative imports

Examples:
```python
from . import helpers
from .utils import parse
from ..services import api
from ...common.types import User
```

Resolution must use the importing file's package context and relative level.

Important:
- A relative import in a module file and one in a package `__init__.py` have different context.
- A file's directory alone is not always sufficient to infer package context.
- If the repository layout does not provide enough evidence to determine the package root, preserve the import as unresolved rather than inventing one.
- Handle attempts to traverse above the known package root safely.

### 7.4 Candidate module paths

Consider Python module conventions:
- `pkg/module.py`
- `pkg/module.pyi`
- `pkg/module/__init__.py`
- Namespace package directories (no `__init__.py`) when policy allows
- `pkg/__init__.py`

Define and test deterministic precedence when both `.py` and `.pyi` candidates exist. Do not silently discard competing candidates; retain evidence and ambiguity where the project policy cannot choose confidently.

### 7.5 Standard library classification

Use a versioned, explicit standard-library module-name dataset compatible with the Python version policy chosen for Cartograph.

Requirements:
- Do not use the host machine's installed Python environment as the source of truth.
- Record the dataset/version used by the resolver.
- Account for top-level standard-library module names separately from submodules.
- Avoid treating third-party packages with names that resemble standard-library modules as standard library without sufficient context.
- If Python-version compatibility is unknown, use a conservative classification and expose uncertainty.

### 7.6 Third-party package classification

Read dependency metadata as data only, where available:
- `pyproject.toml`
- `requirements.txt` and common variants
- `setup.cfg`
- `Pipfile`
- `poetry.lock`
- `uv.lock`

Do not execute `setup.py` or build backends. Do not install dependencies.

Package metadata can support an `external_package` classification, but it does not prove that the package is installed or that a particular import submodule exists.

### 7.7 Resolver evidence

Every internal resolution must include traceable evidence consistent with Phase 06 conventions:
- Importing source file
- Import location
- Original module expression
- Candidate target file(s)
- Resolution rule
- Resolver version
- Relevant package-context evidence

Repository-level summaries should report counts for resolved internal imports, standard-library imports, external packages, unresolved, ambiguous, dynamic, and unsupported imports.

---

## 8. Configuration Reader and Safety

Read only the configuration data needed for import context.

Potential inputs:
- `pyproject.toml`
- `setup.cfg`
- `requirements*.txt`
- `Pipfile`
- lockfiles

Requirements:
1. Use a safe parser for the relevant data format.
2. Enforce file-size and nesting/complexity limits.
3. Treat parse failures as diagnostics, not fatal repository failures.
4. Never import or execute configuration files.
5. Do not run package managers.
6. Do not treat dependency declarations as proof of successful resolution.
7. Preserve source/evidence for any classification based on configuration.

Do not add every configuration format in the first implementation step. Prioritize the minimum required for reliable Python import resolution.

---

## 9. Error Handling and Parser Status

Use the existing parser status contract.

- `complete`: parsing completed without material syntax or parser errors.
- `partial`: useful syntax facts were extracted, but syntax errors or recoverable limitations occurred.
- `failed`: parser execution or infrastructure failed such that a reliable FileIR could not be produced.
- `unsupported`: only for genuinely unsupported language/file cases according to existing conventions.

A malformed Python file should not abort parsing of other files.

Diagnostics should include:
- Stable diagnostic code
- Severity
- Message
- Source location when available
- Parser or resolver origin
- Relevant details without exposing secrets

Do not label a recoverable syntax error as `failed` if useful partial facts remain.

---

## 10. Resource and Security Requirements

Preserve Phase 04 and Phase 05B limits and contracts unless a measured requirement justifies a reviewed change.

- Reuse the existing bounded scheduler.
- Reuse the existing per-file timeout and file-size policy.
- Ensure CPU-bound parser work can actually be stopped at the enforced deadline; a `Promise.race()` alone does not terminate CPU-bound work.
- Avoid unbounded AST traversal or recursion on adversarially deep syntax.
- Bound diagnostics and extracted facts per file.
- Handle empty files, invalid UTF-8, large files, malformed syntax, and parser crashes.
- Do not log full source text or secrets.
- Do not weaken Clerk authentication, organization authorization, RLS, or tenant boundaries.
- Do not introduce a new service, queue, database migration, or infrastructure dependency for this phase without approval.

---

## 11. Registry and Service Integration

Register the Python adapter under canonical language ID `python`.

Integration requirements:
1. Preserve all existing JavaScript and TypeScript registry entries.
2. Preserve the unsupported adapter for languages not yet implemented.
3. Ensure `.py` and `.pyi` are classified consistently by the language registry.
4. Reuse the existing ParserService and ParserScheduler.
5. Preserve repository-level partial-success behavior.
6. Ensure a Python parse failure does not prevent JS/TS or other files from being processed.
7. Keep existing API authentication and organization tenant checks unchanged.
8. Do not add a new endpoint unless the existing parse endpoint cannot support the phase.

---

## 12. Testing Strategy

Tests must be deterministic and must not require network access or execute analyzed Python code.

### 12.1 Parser foundation tests
- `.py` and `.pyi` recognition
- Empty file
- Unicode identifiers and strings
- CRLF and LF line endings
- Source coordinate mapping
- Invalid UTF-8 handling through the existing retrieval boundary
- Syntax error and partial parse behavior
- Deeply nested/adversarial input limits

### 12.2 Declaration tests
- Functions and async functions
- Positional-only parameters
- Positional and keyword parameters
- Default values
- `*args` and `**kwargs`
- Keyword-only parameters
- Return and parameter annotations
- Classes and inheritance
- Methods, constructors, properties
- Nested functions/classes
- Decorators
- Annotated assignments
- Type aliases where supported
- Deterministic symbol IDs and parent relationships

### 12.3 Import extraction tests
- `import a`
- `import a.b`
- Aliases
- `from a import b`
- Multiple imported names
- Relative imports at multiple levels
- Parenthesized/multiline imports
- Imports inside functions and conditional blocks
- `TYPE_CHECKING` blocks
- Dynamic import expressions, e.g. `importlib.import_module(name)`
- Preserve unsupported/dynamic cases without guessing

### 12.4 Call and type tests
- Direct calls
- Attribute calls
- Constructor-like calls
- `super()` calls
- Enclosing function/method association
- Parameter and return annotations
- Generic/subscripted annotations
- Base classes
- Calls remain `not_attempted`

### 12.5 Import resolver tests
- Local module resolution
- Package `__init__.py`
- Namespace package policy
- `.py` versus `.pyi` candidate policy
- Relative imports from normal modules and package initializers
- Ambiguous candidates
- Unresolved imports
- Standard-library classification
- External packages supported by dependency metadata
- Unknown top-level modules
- Above-package-root relative imports
- Resolver evidence and deterministic summaries

### 12.6 Regression tests
- Existing Phase 01–06 backend suites remain green.
- JavaScript/TypeScript parse output remains unchanged for pinned fixtures.
- Unsupported adapters still work.
- Parser scheduler behavior remains unchanged.
- Frontend production build remains clean.

---

## 13. Implementation Sequence — Stop at Each Gate

Do not implement the entire phase in one large change. Work in the following steps and report results after each.

### Step 0 — Targeted inspection and technology decision
Inspect only:
- Existing Phase 05B adapter contract and parser service/scheduler
- Phase 06 JavaScript/TypeScript adapter and resolver interfaces
- `languageRegistry.js`
- `irBuilder.js` and `irValidator.js`
- `Backend/package.json` and lockfile
- Relevant parser tests

Deliver:
- Current contracts and reusable components
- Python parser technology comparison
- Runtime/deployment compatibility findings
- Any FileIR gaps for Python
- Proposed exact files and dependency changes
- Risks and test plan

**Stop and wait for approval. Do not edit files or install dependencies in Step 0.**

### Step 1 — Parser engine and Python adapter foundation
After approval:
- Add the approved parser dependency.
- Implement parser factory and location mapper.
- Implement `.py` and `.pyi` dispatch.
- Add a minimal PythonAdapter registered as `python`.
- Return schema-valid FileIR for empty/simple source.
- Add foundation tests.

Stop and report tests, package changes, and limitations.

### Step 2 — Declaration extraction
Implement functions, async functions, classes, methods, parameters, decorators, assignments, annotations, and parent-child symbol relationships.

Stop and report tests and schema coverage.

### Step 3 — Import extraction
Implement Python import syntax, aliases, relative levels, nested/conditional imports, and dynamic import recognition.

Keep resolution separate.

Stop and report tests and FileIR examples.

### Step 4 — Calls and type facts
Implement syntactic calls, enclosing scope, annotations, base classes, and type references where representable.

Keep call target resolution unattempted.

Stop and report tests.

### Step 5 — Import resolver
Implement manifest-based absolute and relative module resolution, package/namespace handling, standard-library classification, external package classification, and evidence.

Stop and report deterministic resolver results.

### Step 6 — Integration and regression
Run all backend tests, targeted Python tests, frontend build, security checks, and any existing static checks.

Report:
- Files created/modified
- Dependency and lockfile changes
- Test counts and failures
- Example Python FileIR
- Example import resolution records
- Unsupported syntax and known limitations
- Resource/security verification
- Explicit acceptance-criteria status

Only mark Phase 07 complete when all acceptance criteria are demonstrated.

---

## 14. Acceptance Criteria

| Area | Acceptance criterion |
|---|---|
| Parser integration | PythonAdapter registered through existing ParserRegistry |
| File support | `.py` and `.pyi` dispatched correctly |
| FileIR | Every successful/partial parse validates against the existing schema |
| Declarations | Functions, classes, methods, parameters, assignments extracted within supported schema |
| Imports | Python import forms and aliases preserved accurately |
| Relative imports | Relative level and package context handled conservatively |
| Calls | Syntactic call sites extracted; targets remain unattempted |
| Types | Supported annotation and inheritance facts extracted syntactically |
| Locations | Coordinates follow Cartograph's existing convention |
| Determinism | Identical source and parser version produce deterministic IDs and ordering |
| Error recovery | Malformed files produce partial output when useful facts remain |
| Resolution | Internal, external, standard-library, unresolved, ambiguous, and dynamic outcomes are distinguished where evidence permits |
| Evidence | Internal resolutions carry source and rule evidence |
| Security | No repository source/configuration is executed |
| Resource control | Existing size, concurrency, timeout, and output bounds are respected |
| Isolation | One bad file does not abort repository analysis |
| Regression | All previous backend tests and frontend build pass |
| Compatibility | JS/TS adapter behavior and existing API contracts remain intact |

---

## 15. Coding-Agent Handoff Prompt

Use the following prompt to begin Phase 07 Step 0:

> You are working on Cartograph, a GitHub repository code intelligence platform. Phase 06 (JavaScript/TypeScript parser and module resolution) is complete according to the supplied implementation report. Your task is to prepare Phase 07: Python Parser Adapter and Import Resolution.
>
> **This is Step 0 only: targeted inspection and architecture/technology recommendation. Do not edit source files, install packages, modify the lockfile, run migrations, or change application behavior.**
>
> Inspect only the existing parser contracts and the files directly relevant to Phase 07: Phase 05B BaseAdapter, ParserRegistry, ParserScheduler, ParserService, languageRegistry, irBuilder, irValidator, Phase 06 JavaScript/TypeScript adapters and resolver, relevant tests, Backend/package.json, and lockfile.
>
> Determine how Python `.py` and `.pyi` support should fit the existing language-neutral FileIR v1.0.0. Evaluate viable Python parser options for the actual Node.js runtime and deployment environment. Compare grammar coverage, error recovery, source coordinates, package maintenance, licensing, native/WASM requirements, and operational risks. Do not assume Tree-sitter package compatibility; verify it against the actual project.
>
> Identify any FileIR representation gaps for Python imports, relative import levels, parameter kinds, decorators, and package context. Do not change the schema. If an extension appears necessary, propose the smallest change and explain why.
>
> Provide:
> 1. Current reusable contracts and integration points.
> 2. Parser technology recommendation with exact package/version candidates and trade-offs.
> 3. Proposed Python adapter and resolver architecture.
> 4. Proposed file/folder changes.
> 5. Security/resource risks.
> 6. Step-by-step implementation plan and tests.
> 7. Explicit items that require my approval.
>
> Preserve the current stack: Node.js + Express 5 + JavaScript backend, React 19 + Vite frontend, existing Clerk/Supabase architecture, Phase 04 retrieval, Phase 05B parser infrastructure, and Phase 06 implementation. Do not introduce a Python microservice, database migration, new infrastructure, or unrelated refactor.
>
> **Stop after the report and wait for approval.**

---

## 16. Completion Report Template

At the end of Phase 07, provide a report containing:

1. Executive summary and exact supported Python versions/grammar.
2. Architecture and data flow.
3. Parser technology and dependency versions.
4. Declaration/import/call/type extraction coverage.
5. Import-resolution rules and limitations.
6. FileIR examples for representative Python files.
7. Files created and modified.
8. Targeted and full test results.
9. Frontend build and regression results.
10. Security and resource-limit verification.
11. Known limitations and deferred work.
12. Acceptance criteria ledger.
13. Explicit statement of whether Phase 07 is complete.

Do not claim production readiness solely from unit tests. Separate implementation verification from live deployment validation.

---

**End of Phase 07 Implementation Blueprint**
