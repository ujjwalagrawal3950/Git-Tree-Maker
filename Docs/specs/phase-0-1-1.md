# Cartograph — Project Reconciliation & Phase 02 Planning Prompt

Use this prompt with your coding agent (OpenCode, Cursor, or another repository-aware agent) from the **Cartograph project root**.

---

## Prompt

You are the senior software architect and repository auditor for **Cartograph**, a GitHub repository dependency-mapping application.

Your task is to inspect the existing project, reconcile the documentation with the implementation, identify security and architectural gaps, and prepare an accurate Phase 02 specification. **Do not start implementing Phase 02 in this task.**

### 1. Project context

The project currently has three top-level areas:

```text
Cartograph/
├── Frontend/
├── Backend/
└── Docs/
```

The intended stack is:

- Frontend: React 19, Vite, JSX, Tailwind CSS v3
- Graph visualization: React Flow and Dagre
- Backend: Node.js and Express 5, JavaScript
- Authentication: Clerk
- Database: Supabase

Do not migrate the project to Next.js or TypeScript. Do not replace the existing stack without presenting a compelling reason and obtaining approval.

The product goal is to accept a GitHub repository URL, discover its source files efficiently, parse actual source code, resolve dependencies, and display a trustworthy dependency graph. Graph nodes and edges must be grounded in parser and resolver evidence. AI may explain verified findings later, but must not invent dependencies or graph relationships.

### 2. Known project status (starting information, not unquestionable truth)

A recent progress report stated:

**Frontend**
- Vite + React 19 + JSX, approximately 2,500 source lines.
- Tailwind CSS v3, React Flow and Dagre.
- Clerk UI integration.
- `npm run build` passes.
- `npm run lint` fails because `StrictMode` is imported but unused in `Frontend/src/main.jsx`.
- Phase 01 app shell and sample dependency map are approximately 95% complete.
- Implemented: top bar, left rail, map, detail panel, status bar, three-state theme, sample repository, folder expansion, aggregated folder edges, deterministic Dagre layout, selection highlighting, fan-in/fan-out details, and repository URL validation with an honest out-of-scope notice.
- Manual Phase 01 acceptance checks have not yet been run.

**Backend**
- Express 5, Supabase client, Clerk webhook and user CRUD.
- Clerk webhook handles `user.created`, `user.updated`, and `user.deleted`.
- ngrok is used for local webhook testing.
- Reported concerns:
  - No authentication middleware on `/SignUp` or `/users/:id`.
  - No organization model or organization-scoped authorization.
  - Backend uses the Supabase service-role key, which bypasses RLS.
  - `CLERK_SECRET_KEY` was reportedly present in `Frontend/.env`.

**Documentation and product gaps**
- `Docs/specs/phase-01.md` is the only known phase specification.
- Existing implementation has moved beyond Phase 01 into authentication, despite Phase 01 documentation saying authentication, organizations, real data, and network requests are out of scope.
- No real GitHub fetching, repository parsing, language adapters, dependency resolution, coverage reporting, live parsing progress, blast-radius analysis, AI explanations, repository chat, file labelling, or automated tests were reported.
- There is no Git repository/history available to measure changes against.

Treat these points as leads to verify. Inspect the actual files and scripts. Do not assume the report is completely accurate or current.

### 3. Required operating rules

1. **Audit before editing.** Inspect the repository structure, package scripts, source files, environment variable names (never print secret values), database schema, and existing documentation.
2. Do not expose, copy, or print credentials, tokens, private keys, or secret environment values. If a secret appears in a frontend environment file or tracked file, report the filename and variable name only.
3. Do not rotate keys, change Clerk settings, change Supabase policies, run migrations, delete files, or modify application behavior without explicit approval.
4. Do not install packages.
5. Do not rewrite working code just to make it look cleaner.
6. Preserve the current JavaScript/JSX stack and existing naming conventions.
7. Do not invent completed functionality. Mark each finding as **Verified**, **Partially verified**, **Not found**, or **Needs manual verification**.
8. Distinguish current implementation from proposed architecture and future work.
9. Keep filenames short and consistent with the existing project.
10. Do not begin GitHub discovery or parser implementation as part of this task.

### 4. Repository audit

Inspect at least:

- Full top-level directory structure.
- `Frontend/package.json` and `Backend/package.json`.
- Frontend entry point, app shell, routing, authentication components, graph components, and state/theme handling.
- Backend entry point, app setup, routes, controllers, services, middleware, webhook verification, Supabase client setup, and user operations.
- Supabase SQL/schema files and RLS policies.
- All files under `Docs/`, especially `Docs/specs/phase-01.md`, `Docs/Project_doc.md`, and any architecture or agent instruction documents.
- Lint and build scripts. Run existing build/lint commands only if safe and practical; do not install dependencies.

For each important finding, include the exact file path and relevant symbol, route, or configuration name. Use line numbers if the tool provides reliable line numbers.

### 5. Security review

Review the following areas carefully:

**Clerk**
- Is the webhook signature verified using the raw request body and correct signing secret?
- Is the webhook route registered before JSON body parsing if raw body verification requires it?
- Are webhook event types and payloads validated?
- Are user-facing routes protected by Clerk authentication middleware?
- Does the backend verify the authenticated user identity rather than trusting a user ID supplied in request parameters or body?
- Are authorization checks applied to every user-specific operation?

**Supabase**
- Which key is used by the backend?
- Is the service-role key kept exclusively on the server?
- Are RLS policies enabled and appropriate?
- Does the backend enforce ownership and organization membership before using privileged database access?
- Are database constraints and indexes adequate for the current user data model?

**Environment and secrets**
- Identify environment variable names and the files where they are referenced.
- Never reveal values.
- Flag any secret that is placed in a frontend-exposed environment file, committed file, or client bundle.
- Do not claim that moving a key alone fixes authorization; explain the required server-side checks.

**Organizations**
- Determine whether organization support exists in code or schema.
- If absent, propose a minimal data model and authorization flow compatible with Clerk organizations and Supabase.
- Do not implement it yet.

Classify each issue as **Critical**, **High**, **Medium**, or **Low**, explain its impact, and recommend a concrete fix.

### 6. Documentation reconciliation

Update or propose documentation so it accurately represents the code that exists today.

Create or update these documents only where appropriate:

```text
Docs/
├── Project_doc.md
├── architecture/
│   └── current-architecture.md
├── audits/
│   └── implementation-audit.md
└── specs/
    ├── phase-01.md
    └── phase-02.md
```

If the repository already uses a different documentation structure, preserve it rather than creating duplicate structures.

The audit document must include:
- Verified current frontend capabilities.
- Verified current backend capabilities.
- Verified authentication and persistence behavior.
- Security findings with severity and evidence.
- Build/lint/test status and commands run.
- Features not found.
- Manual checks still required.
- Differences between the original Phase 01 scope and the actual implementation.

Update Phase 01 documentation to distinguish:
- Original acceptance criteria.
- Implemented and verified behavior.
- Implemented but not yet verified behavior.
- Work that was added beyond the phase scope.

Do not mark manual acceptance checks as passed unless they were actually performed.

### 7. Prepare Phase 02 specification

Create a detailed, implementation-ready `phase-02.md`.

**Proposed Phase 02 title:** Authentication, Authorization, Organizations, and Data Security.

The specification should define:

1. Goals and explicit non-goals.
2. Current-state assumptions that were verified during the audit.
3. User identity and Clerk session authentication flow.
4. Protected backend route policy.
5. User ownership checks and authorization rules.
6. Organization creation, membership, roles, and organization context.
7. Proposed Supabase schema and relationships.
8. RLS policy requirements.
9. Safe use of the Supabase service-role key, including mandatory server-side authorization checks.
10. Clerk webhook verification, event handling, idempotency, and failure behavior.
11. Environment variable placement and secret handling.
12. API route contracts and expected error responses.
13. Migration and rollout strategy.
14. Testing strategy, including authentication, authorization, cross-user access, cross-organization access, webhook verification, and RLS tests.
15. Acceptance criteria that can be objectively checked.
16. Risks, dependencies, and unresolved decisions.

Do not assume that Clerk organizations are already configured. State which Clerk dashboard configuration or user approval is required.

Do not write implementation code or execute database migrations. The deliverable is a specification for review and approval.

### 8. Phase 02 design principles

- Authentication answers **who is making the request**.
- Authorization answers **whether that user may access this resource**.
- Never trust `userId`, `orgId`, or ownership claims supplied by the browser without verifying them against the authenticated identity and database.
- A Supabase service-role key bypasses RLS. If used on the server, the application must perform explicit authorization checks before every privileged read or write.
- Organization membership and role checks must be enforced server-side.
- Webhook delivery may be retried or arrive out of order. Design idempotent processing and safe handling of stale events.
- Never put Clerk secret keys or Supabase service-role keys in frontend-exposed environment variables.
- Keep webhook signature verification separate from normal user-session authentication.
- Avoid unnecessary abstractions and packages.

### 9. Required final response

After the audit and documentation work, report:

1. **What you inspected** — relevant directories and files.
2. **Verified current state** — what actually exists.
3. **Security findings** — severity, evidence, and recommended fix.
4. **Documentation changes** — files created or updated.
5. **Phase 01 closure status** — passed, failed, or not tested for each criterion.
6. **Phase 02 summary** — scope, design decisions, acceptance criteria.
7. **Unresolved questions** — only decisions that genuinely require the project owner's input.
8. **Next recommended action** — one concrete next step.

Do not claim the product is production-ready. Do not start Phase 02 implementation. Stop after the audit and specification are ready for review.

---

## Expected outcome

At the end of this task, Cartograph should have an accurate record of its current implementation and a reviewed Phase 02 plan. No application behavior should have changed. The next implementation task should begin only after the project owner approves the audit and Phase 02 specification.
