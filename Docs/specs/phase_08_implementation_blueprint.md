# Cartograph — Phase 08 Implementation Blueprint
## Java Parser Adapter & Import Resolution

**Milestone:** Phase 08  
**Status:** Planned — implementation not yet started  
**Depends on:** Phase 03 Git Tree Manifest, Phase 04 Selective Source Retrieval, Phase 05A/B Unified FileIR and Parser Core, Phase 06 JavaScript/TypeScript Parser, Phase 07 Python Parser and Import Resolution  
**Primary outcome:** Parse Java source files into the existing language-neutral FileIR and resolve Java package/type imports against the immutable repository manifest.

---

## 1. Objective

Implement Java static analysis as the next language adapter in Cartograph.

The Java subsystem must:

1. Consume source files already retrieved by Phase 04.
2. Parse Java syntax in memory without compiling or executing repository code.
3. Extract declarations, imports, calls, inheritance, annotations, and type facts into the existing FileIR v1.0.0.
4. Resolve statically identifiable Java types and imports against the immutable repository manifest.
5. Preserve unresolved, ambiguous, external, generated, and unsupported cases explicitly.
6. Integrate with the existing ParserRegistry, ParserScheduler, parser service, FileIR validator, and tenant-protected API.
7. Preserve JavaScript, TypeScript, and Python behavior.

**Non-goal:** Compile Java projects, invoke Maven/Gradle, download dependencies, run annotation processors, execute build scripts, or perform full Java semantic/type analysis.

---

## 2. Architectural Principles

### 2.1 Reuse the existing pipeline

```text
Phase 03 Immutable Repository Manifest
                 |
                 v
Phase 04 Retrieved Java Source Files
                 |
                 v
Existing ParserService / ParserScheduler
                 |
                 v
Existing ParserRegistry
                 |
                 v
            JavaAdapter
                 |
                 v
         Java Parser Engine
                 |
       +---------+----------+-----------+
       |         |          |           |
       v         v          v           v
 Declarations Imports   Calls/Types  Inheritance
       |         |          |           |
       +---------+----------+-----------+
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
          JavaImportResolver
                 |
                 v
       Traceable Resolution Records
                 |
                 v
       Phase 10 Unified Dependency Graph
```

Do not create a Java-specific graph or a second FileIR format.

### 2.2 Facts and inferences must remain separate

- The parser records syntax facts found in source.
- The resolver matches imports and type references against repository evidence.
- The Phase 10 graph engine owns final dependency-edge creation.
- A method call name is not proof of its target method.
- A type name is not proof of a unique declaration when multiple candidates exist.
- Do not infer cross-language service/API dependencies from naming similarity.

### 2.3 No untrusted execution

Never:
- Compile repository source.
- Execute Java classes or tests.
- Invoke Maven, Gradle, Ant, javac, annotation processors, or build plugins.
- Run `pom.xml`, `build.gradle`, `settings.gradle`, `gradlew`, or wrapper scripts.
- Download Maven/Gradle dependencies during analysis.
- Load arbitrary repository classes through reflection.

Build and dependency files may be parsed as bounded data only. Treat all repository content as untrusted.

---

## 3. Scope

### 3.1 Java files in scope

At minimum:
- `.java` — Java source files.

Optional later support, not required:
- `.kt` — Kotlin (separate Phase 09 or later adapter).
- `.scala` — Scala.
- `.groovy` — Groovy.
- `.jsp` — Java Server Pages.
- `.java` generated-source variants.

Do not classify optional formats as Java source.

Use canonical language ID `java`. Preserve original extension, path, repository revision, and blob identity.

### 3.2 Extraction scope

**Declarations and symbols**
- Package declarations
- Top-level classes
- Interfaces
- Enums and enum constants
- Records
- Annotation types
- Nested and inner classes
- Methods
- Constructors
- Fields
- Static and instance initializer blocks where the schema can represent them
- Parameters
- Generic type parameters
- Visibility/modifiers
- Abstract, static, final, synchronized, native, and default modifiers where representable
- Annotations as syntax metadata
- Nested declarations and parent-child relationships

**Imports**
- Single-type imports
- On-demand/package wildcard imports (`import a.b.*`)
- Static single-member imports
- Static on-demand imports
- Fully qualified names in declarations and type positions
- Duplicate imports
- Unused imports should still be extracted; usage analysis is not required in this phase

**Calls and type facts**
- Method invocations
- Constructor invocations and object creation expressions
- Explicit `this(...)` and `super(...)` constructor calls
- Field/member access where the existing FileIR supports it
- Method return and parameter types
- Field and local variable types
- Generic type arguments
- Array types
- Wildcard types (`? extends`, `? super`)
- Class/interface inheritance (`extends`, `implements`)
- Annotation type references
- Throws clauses
- Type bounds (`T extends ...`)

### 3.3 Explicitly out of scope

- Full Java compiler/type-checker semantics
- Overload resolution
- Runtime dispatch and call-target resolution
- Annotation processor execution
- Reflection analysis
- Full control-flow/data-flow analysis
- Bytecode analysis
- Maven/Gradle dependency downloads
- Resolving every external dependency to a source artifact
- Framework-specific route discovery unless later added as a separate evidence-backed feature
- Kotlin, Scala, Groovy, and other JVM languages

---

## 4. Parser Technology Selection

The Java parser must run inside the existing Node.js + Express backend. Do not introduce a Java microservice or require a JDK merely to parse source.

Evaluate viable options against the actual repository environment:

| Option | Strengths | Risks / considerations |
|---|---|---|
| Tree-sitter Java grammar with Node binding | Consistent with Phase 07, concrete syntax tree, source locations, error recovery, no JDK requirement | Native binding and grammar compatibility; CST normalization effort |
| Java grammar compiled to WebAssembly | Avoids native addon portability issues; syntax-only parsing | Runtime/package maturity, grammar coverage, WASM overhead |
| Java parser implemented in Java and exposed as a service | Mature Java parser ecosystem | Adds runtime/service/deployment complexity; not preferred for this modular monolith |

### Required selection procedure

Before implementation:
1. Inspect `Backend/package.json`, lockfile, Node version, module system, and deployment assumptions.
2. Inspect the exact Tree-sitter versions and integration used by Phase 07.
3. Evaluate the Java grammar version against the chosen parser runtime.
4. Test representative modern Java syntax: records, text blocks, modules, generics, annotations, lambdas, and switch expressions.
5. Verify license, maintenance, error recovery, source coordinate behavior, native/WASM deployment compatibility, and package installation.
6. Report exact package/version candidates and dependency changes.
7. Wait for approval before installing dependencies or editing source files.

**Recommendation:** Prefer reusing the Tree-sitter runtime already introduced in Phase 07, with a compatible Java grammar, if the actual package and deployment compatibility checks pass. Do not assume compatibility solely because Python parsing works.

---

## 5. Java Parser Contract

Implement a `JavaAdapter` following the existing `BaseAdapter` contract exactly.

The adapter must:
- Accept the same input shape as the existing language adapters.
- Receive source text and manifest/repository context through existing parser service contracts.
- Return one schema-valid FileIR per input file.
- Reuse existing `irBuilder` and `irValidator`.
- Preserve parser status and diagnostics conventions.
- Keep Java-specific logic under a Java adapter directory.
- Never retrieve files itself; Phase 04 owns retrieval.
- Never compile or execute repository code.

Suggested structure, to be adapted after inspection:

```text
Backend/services/parser/
  adapters/
    java/
      parserFactory.js
      locationMapper.js
      JavaAdapter.js
      extractors/
        declarationExtractor.js
        importExtractor.js
        callExtractor.js
        typeExtractor.js
      helpers/
        modifierExtractor.js
        annotationExtractor.js
  resolvers/
    java/
      JavaImportResolver.js
      packagePathMapper.js
      classpathContext.js
```

Keep the design proportionate. Avoid empty abstractions and unnecessary files.

---

## 6. FileIR Mapping Requirements

The existing FileIR v1.0.0 schema is authoritative. Do not silently change field names, enums, or coordinate conventions.

### 6.1 Symbols

Map Java declarations to supported symbol kinds:
- Class → class
- Interface → interface, if supported; otherwise use the closest schema-approved representation and document it
- Enum → enum
- Enum constant → enum member, if supported
- Record → class or another existing compatible kind, with `languageMetadata` identifying `record`
- Annotation type → interface/type-like representation supported by the schema, with metadata identifying annotation declaration
- Method → method
- Constructor → constructor or method, depending on existing schema enum
- Field/local variable → variable/field-compatible kind supported by the schema
- Parameter → parameter metadata on its owning callable
- Generic type parameter → type parameter metadata where supported

Use `parentSymbolId` for nested types and members when supported.

Do not add unsupported symbol kinds or undeclared properties. If Java constructs cannot be faithfully represented, identify the exact gap during Step 0 and propose the smallest schema-compatible approach.

### 6.2 Modifiers and visibility

Preserve modifiers in `symbol.languageMetadata` if the schema supports arbitrary metadata objects. Examples:
- `public`, `protected`, `private`
- `static`, `final`, `abstract`
- `synchronized`, `native`, `default`
- `sealed`, `non-sealed`
- `transient`, `volatile`
- `strictfp`

Do not infer package-private visibility as public. Java package-private access is a distinct visibility state; if the current schema lacks it, preserve it in metadata and document the limitation.

### 6.3 Annotations

Record annotation names and argument expressions as syntax facts in `languageMetadata` or the existing metadata structure.

Examples:
- `@Override`
- `@Deprecated`
- `@SuppressWarnings("unchecked")`
- Custom annotations

Never execute annotation processors or assume framework behavior from an annotation name alone.

### 6.4 Imports

Represent Java imports using the existing language-neutral import model. Preserve:
- Fully qualified import name
- Static vs non-static import
- Wildcard/on-demand import
- Imported member/type name
- Source location
- Package context

Use `languageMetadata` for Java-specific facts when appropriate. Do not add undeclared top-level properties to strict FileIR objects.

Important: a wildcard import does not identify every imported class. Preserve the wildcard as a package-level import fact; do not fabricate one dependency edge per class.

### 6.5 Calls and types

Extract syntactic calls and type references:
- `foo()`
- `object.method()`
- `new UserService()`
- `this(...)`
- `super(...)`
- Method references (`Type::method`) if representable

Keep call target resolution as `not_attempted` for Phase 10.

Record generic arguments, array dimensions, wildcard bounds, and qualified names as syntax facts where the schema permits. Do not claim full semantic type resolution.

### 6.6 Source coordinates

Use Cartograph's existing convention:
- Lines: 1-based
- Columns: 0-based
- End positions: exclusive
- Offsets: follow the existing FileIR convention exactly

Tree-sitter may expose byte offsets. Convert explicitly to the existing FileIR offset unit. Test Unicode before and inside declarations, comments, string literals, and text blocks. Never mix UTF-8 byte offsets, Unicode code points, and UTF-16 code units.

---

## 7. Java Import and Type Resolution

Implement a dedicated resolver using the immutable Phase 03 manifest and parsed FileIR facts. Do not invoke javac or build tools.

### 7.1 Resolution categories

Inspect and reuse the existing Phase 06/07 resolver-record contract. Keep resolution separate from FileIR syntax facts.

Possible outcomes, subject to the existing contract:
- Internal repository type/file resolved
- External dependency
- Java platform/JDK type
- Unresolved
- Ambiguous
- Wildcard/package-level
- Unknown/unsupported

Do not invent status strings without checking the shared resolver contract.

### 7.2 Package declarations and source paths

Use package declarations as primary evidence for Java type identity.

Examples:
```java
package com.example.auth;
public class AuthService {}
```

A conventional path may be:
```text
src/main/java/com/example/auth/AuthService.java
```

But repositories may use nonstandard source roots. Therefore:
- Do not assume every Java source file lives under `src/main/java`.
- Build a package-to-file index from parsed package declarations.
- Preserve package/path mismatches as diagnostics or metadata.
- Use repository paths as evidence, not as the sole source of package identity.
- If duplicate fully qualified type declarations exist, preserve ambiguity.

### 7.3 Single-type imports

Examples:
```java
import com.example.auth.AuthService;
import static com.example.util.Constants.DEFAULT_TIMEOUT;
```

Resolve the imported qualified name against the repository type index. For static imports, preserve the owning type and imported member separately where the FileIR model supports it.

A static import does not prove which overloaded method or field is used at each call site.

### 7.4 Wildcard imports

Examples:
```java
import com.example.models.*;
import static com.example.util.Constants.*;
```

Do not expand wildcard imports into guessed class/member dependencies.

Resolve the package or owning type if evidence supports it, and retain a wildcard import record. Phase 10 may later use symbol references and package indexes to derive more precise relationships.

### 7.5 External dependencies and JDK types

Potential evidence sources:
- `pom.xml`
- `build.gradle`
- `build.gradle.kts`
- `settings.gradle`
- `gradle/libs.versions.toml`
- `module-info.java`

Read supported files as bounded data only. Never execute build scripts or resolve dependencies over the network.

Use a versioned Java platform/JDK type catalogue only if it can be maintained reliably. If the project Java version is unknown or a type is not in the catalogue, preserve uncertainty rather than misclassifying it as an external dependency.

Dependency declarations can support external classification, but they do not prove a dependency is installed or that every imported type exists in it.

### 7.6 Generated sources

Java projects may contain generated source code. Do not assume a path is generated merely because it contains `generated`. If reliable build configuration indicates generated source roots, record that context as evidence. Do not run generators.

### 7.7 Resolution evidence

Every internal resolution must include traceable evidence consistent with previous resolvers:
- Importing source file
- Import location
- Fully qualified name
- Candidate target file/type
- Resolution rule
- Resolver version
- Package declaration evidence
- Relevant source-root or configuration evidence

Repository-level summaries should report resolved internal types, external dependencies, JDK/platform types, wildcard imports, unresolved, ambiguous, and unsupported outcomes.

---

## 8. Build Configuration Reader and Safety

Read only the minimum build metadata required for Java resolution.

Potential inputs:
- `pom.xml`
- `build.gradle`
- `build.gradle.kts`
- `settings.gradle`
- `settings.gradle.kts`
- `gradle/libs.versions.toml`
- `module-info.java`

Requirements:
1. Use safe parsers for the relevant formats.
2. Enforce file-size and complexity limits.
3. Treat parse failures as diagnostics, not fatal repository failures.
4. Never evaluate Gradle scripts or Maven plugins.
5. Never run wrappers, compilers, tests, annotation processors, or dependency managers.
6. Do not download dependencies.
7. Keep build configuration interpretation deliberately limited and evidence-backed.
8. If a format cannot be parsed safely without executing it, leave it unsupported and document the limitation.

Do not attempt to implement full Maven/Gradle model resolution in Phase 08.

---

## 9. Error Handling and Parser Status

Use the existing parser status contract:
- `complete`: parsing completed without material syntax or parser errors.
- `partial`: useful syntax facts were extracted, but recoverable syntax errors or limitations occurred.
- `failed`: parser execution or infrastructure failed such that a reliable FileIR could not be produced.
- `unsupported`: only for genuinely unsupported language/file cases under existing conventions.

A malformed Java file must not abort parsing of other files.

Diagnostics should include:
- Stable diagnostic code
- Severity
- Message
- Source location when available
- Parser/resolver origin
- Relevant details without exposing secrets

Do not label recoverable syntax errors as `failed` if useful facts remain.

---

## 10. Resource and Security Requirements

Preserve Phase 04 and Phase 05B resource limits unless a measured need justifies a reviewed change.

- Reuse the existing bounded ParserScheduler.
- Ensure CPU-bound parsing can actually be terminated at the enforced deadline; `Promise.race()` alone does not stop CPU-bound work.
- Bound AST/CST traversal depth.
- Bound extracted symbols, imports, calls, type references, and diagnostics per file.
- Handle empty files, invalid UTF-8, large files, malformed syntax, and parser crashes.
- Avoid logging full source text or secrets.
- Do not weaken Clerk authentication, organization authorization, RLS, or tenant isolation.
- Do not introduce a new service, queue, database migration, or infrastructure dependency for this phase without approval.

---

## 11. Registry and Service Integration

Register `JavaAdapter` under canonical language ID `java`.

Integration requirements:
1. Preserve existing JavaScript, TypeScript, and Python registry entries.
2. Preserve `UnsupportedAdapter` for languages not yet implemented.
3. Ensure `.java` is classified as Java source by the language registry.
4. Reuse existing ParserService and ParserScheduler.
5. Preserve repository-level partial-success behavior.
6. Ensure one Java parser failure does not prevent other files from being processed.
7. Keep existing API authentication and organization tenant checks unchanged.
8. Do not add a new endpoint unless the existing parse endpoint cannot support the phase.

---

## 12. Testing Strategy

Tests must be deterministic, local, and must not compile or execute analyzed Java code.

### 12.1 Parser foundation
- `.java` recognition
- Empty file
- Unicode identifiers and comments
- CRLF and LF line endings
- Source coordinate mapping
- Text blocks
- Parser diagnostics and partial recovery
- Deeply nested/adversarial input limits

### 12.2 Declaration extraction
- Classes and nested classes
- Interfaces
- Enums and enum constants
- Records
- Annotation types
- Constructors and methods
- Fields
- Parameters
- Generic type parameters
- Visibility and modifiers
- Annotations and annotation arguments
- `throws` clauses
- Package declarations
- Deterministic IDs and parent-child relationships

### 12.3 Import extraction
- Single-type imports
- Wildcard imports
- Static single-member imports
- Static wildcard imports
- Duplicate imports
- Fully qualified names
- Package declarations
- Imports with comments and unusual whitespace

### 12.4 Calls and type facts
- Direct method calls
- Member method calls
- Object creation
- `this()` and `super()` constructor calls
- Method references where supported
- Generic types
- Arrays
- Wildcard bounds
- Inheritance and interface implementation
- Annotation type references
- Parameter, return, field, and local variable types
- Call targets remain `not_attempted`

### 12.5 Resolver tests
- Package-to-file mapping
- Nonstandard source roots
- Single-type imports
- Duplicate fully qualified type declarations
- Static imports
- Wildcard imports without fabricated class edges
- JDK/platform type classification
- Maven/Gradle dependency metadata parsing as data
- Unknown Java version
- Generated-source metadata
- Unresolved and ambiguous types
- Resolver evidence and deterministic repository summaries

### 12.6 Regression tests
- All Phase 01–07 backend suites remain green.
- JavaScript/TypeScript/Python outputs remain unchanged for pinned fixtures.
- Unsupported adapters still work.
- Parser scheduler behavior remains unchanged.
- Frontend production build remains clean.

---

## 13. Implementation Sequence — Stop at Each Gate

Do not implement the entire phase in one large change.

### Step 0 — Targeted inspection and technology decision
Inspect only:
- Existing BaseAdapter, ParserRegistry, ParserScheduler, and ParserService
- `languageRegistry.js`
- `irBuilder.js` and `irValidator.js`
- Phase 06 JavaScript/TypeScript adapter and resolver
- Phase 07 Python adapter and resolver
- Relevant tests
- `Backend/package.json` and lockfile

Deliver:
- Reusable parser and resolver contracts
- Java parser technology comparison and compatibility findings
- Modern Java grammar coverage
- FileIR gaps for Java constructs
- Proposed exact files and dependency changes
- Deployment and native/WASM risks
- Test plan

**Stop and wait for approval. Do not edit files or install dependencies in Step 0.**

### Step 1 — Parser engine and adapter foundation
After approval:
- Add the approved Java grammar dependency.
- Implement parser factory and location mapper.
- Implement `.java` dispatch.
- Add a minimal JavaAdapter registered as `java`.
- Return schema-valid FileIR for empty/simple Java source.
- Add foundation tests.

Stop and report dependency changes and test results.

### Step 2 — Package, declarations, and symbols
Implement package declarations, classes, interfaces, enums, records, annotation types, methods, constructors, fields, parameters, modifiers, and annotations.

Stop and report schema coverage and tests.

### Step 3 — Import extraction
Implement single-type, wildcard, and static imports. Preserve syntax and package context. Keep resolution separate.

Stop and report FileIR examples and tests.

### Step 4 — Calls and type facts
Implement syntactic calls, enclosing scope, inheritance, generics, arrays, annotations, and type references where representable.

Keep call-target resolution unattempted.

Stop and report tests.

### Step 5 — Java import/type resolver
Build a package/type index from parsed repository FileIR. Implement evidence-backed internal resolution, wildcard handling, external dependency classification, JDK classification, and ambiguity.

Stop and report deterministic resolver records.

### Step 6 — Integration and regression
Run:
- Targeted Java parser and resolver tests
- Full backend test suite
- Frontend production build
- Existing security and static checks

Report exact files, dependencies, test counts, sample FileIR, resolver examples, limitations, and acceptance criteria.

Only mark Phase 08 complete when the acceptance criteria are demonstrated.

---

## 14. Acceptance Criteria

| Area | Acceptance criterion |
|---|---|
| Parser integration | JavaAdapter registered through existing ParserRegistry |
| File support | `.java` dispatched correctly |
| FileIR | Successful/partial outputs validate against existing schema |
| Declarations | Core Java declarations and members extracted |
| Package context | Package declarations preserved and indexed |
| Imports | Single, wildcard, and static imports represented accurately |
| Calls | Syntactic call sites extracted; targets remain unattempted |
| Types | Inheritance, generic, array, and annotation type facts extracted where supported |
| Locations | Coordinates follow Cartograph's existing convention |
| Determinism | Identical source and parser version produce deterministic IDs and ordering |
| Error recovery | Malformed files produce partial output when useful facts remain |
| Resolution | Internal, external, JDK, unresolved, ambiguous, and wildcard cases are distinguished conservatively |
| Evidence | Internal resolutions carry source and rule evidence |
| Security | No repository source or build configuration is executed |
| Resource control | Existing size, concurrency, timeout, and output bounds are respected |
| Isolation | One bad file does not abort repository analysis |
| Regression | All previous backend tests and frontend build pass |
| Compatibility | JS/TS/Python adapter behavior and existing API contracts remain intact |

---

## 15. Coding-Agent Handoff Prompt

Use this prompt to begin Phase 08 Step 0:

> You are working on Cartograph, a GitHub repository code intelligence platform. Phases 06 and 07 have implemented JavaScript/TypeScript and Python parsing using the shared FileIR and parser infrastructure. Your task is to prepare Phase 08: Java Parser Adapter and Import Resolution.
>
> **This is Step 0 only: targeted inspection and architecture/technology recommendation. Do not edit source files, install packages, modify the lockfile, run migrations, or change application behavior.**
>
> Inspect only the existing parser contracts and files directly relevant to Phase 08: BaseAdapter, ParserRegistry, ParserScheduler, ParserService, languageRegistry, irBuilder, irValidator, Phase 06 adapters/resolver, Phase 07 adapter/resolver, relevant tests, Backend/package.json, and lockfile.
>
> Evaluate Java parser options for the actual Node.js runtime and deployment assumptions. Prefer reusing the existing Tree-sitter runtime only if a compatible Java grammar is verified. Check modern Java syntax coverage, error recovery, source coordinates, package maintenance, licensing, native/WASM requirements, and clean-install behavior.
>
> Identify FileIR representation gaps for Java records, annotation types, constructors, package-private visibility, modifiers, static imports, wildcard imports, generic types, and nested declarations. Do not change the schema. Propose the smallest compatible representation or schema extension where necessary.
>
> Design a syntax-only Java parser and a separate manifest-backed package/type resolver. Do not compile source, execute repository code, invoke Maven/Gradle, run annotation processors, download dependencies, or introduce a Java microservice.
>
> Provide:
> 1. Existing reusable contracts and integration points.
> 2. Parser technology recommendation with exact package/version candidates and trade-offs.
> 3. Modern Java grammar coverage and known gaps.
> 4. Proposed adapter and resolver architecture.
> 5. Proposed exact file/folder changes.
> 6. FileIR compatibility analysis.
> 7. Security, resource, and deployment risks.
> 8. Step-by-step implementation and testing plan.
> 9. Explicit approval requirements.
>
> Preserve the current stack: Node.js + Express 5 + JavaScript backend, React 19 + Vite frontend, Clerk/Supabase architecture, Phase 04 retrieval, Phase 05B parser infrastructure, and Phase 06/07 implementations. Do not introduce a Python/Java microservice, database migration, new infrastructure, or unrelated refactor.
>
> **Stop after the report and wait for approval.**

---

## 16. Completion Report Template

At the end of Phase 08, provide:

1. Executive summary and supported Java language level.
2. Parser technology and exact dependency versions.
3. Architecture and data flow.
4. Declaration, import, call, and type extraction coverage.
5. Package/type resolution rules and limitations.
6. Representative Java FileIR examples.
7. Files created and modified.
8. Targeted and full test results.
9. Frontend build and regression results.
10. Security, resource, and deployment verification.
11. Known limitations and deferred work.
12. Acceptance criteria ledger.
13. Explicit statement of whether Phase 08 is complete.

Do not claim production readiness solely from unit tests. Separate implementation verification from deployment validation.

---

**End of Phase 08 Implementation Blueprint**
