# Cartograph — Implementation Audit

**Audit date:** 2026-11-12
**Scope:** current repository state of `Frontend/`, `Backend/`, `Docs/`
**Purpose:** reconcile documentation with implementation, record security gaps, and provide the verified baseline for `Docs/specs/phase-02.md`.
**Status:** audit complete. No application code, database schema, Clerk setting, Supabase policy, or environment value was changed by the audit.
**Remediation:** the approved fixes are recorded in `Docs/audits/security-remediation.md`.

Status labels used in this document:

- **Verified** — confirmed by reading the current file or by running the command shown.
- **Partially verified** — the code exists, but the behaviour was not exercised end to end.
- **Not found** — no implementation was found in the repository.
- **Needs manual verification** — requires a browser, Clerk dashboard, Supabase dashboard, or live webhook delivery.

---

## 1. Executive summary

Cartograph currently consists of:

- A **Phase 01 frontend shell** built with Vite, React 19, JSX, Tailwind CSS v3, React Flow, and Dagre. It renders a bundled sample repository, folder expansion, deterministic layout, selection highlighting, and a file detail panel.
- A **Clerk sign-in gate** wrapped around that shell. The Phase 01 shell is not visible to signed-out users.
- A **small Express 5 backend** that exposes unprotected user CRUD routes and a Clerk webhook endpoint. It talks to Supabase with the service-role key.
- **At audit time: no organization model, no repository parsing, no GitHub discovery, no real graph data, no AI features, and no automated tests.**

At audit time the frontend build passed and the lint command failed on one unused import. The manual Phase 01 acceptance check had not been run. Phase 01 is therefore **not closed**.

The most serious findings are:

1. **Critical — unauthenticated user CRUD backed by the Supabase service-role key.** Anyone who can reach the backend can read, create, update, or delete any user row.
2. **Critical — the `users` RLS policy allows `anon` and `authenticated` to read every row.** The Supabase anon key can read all stored profiles if RLS is the only guard.
3. **High — the Clerk secret key is present in `Frontend/.env`.** It is not currently bundled by Vite because it lacks the `VITE_` prefix, but it is exposed to anyone with access to the frontend workspace and should be removed and rotated.
4. **High — no organization model or organization-scoped authorization exists**, despite organizations being central to the product.

The full findings are in section 6. Phase 02 was specified separately and was **not implemented at audit time**. The approved remediation subsequently implemented the application code and SQL; see `Docs/audits/security-remediation.md`.

---

## 2. Repository inventory

Top level:

```text
Cartograph/
├── Backend/
├── Docs/
└── Frontend/
```

There is no Git repository in this directory. `git status` returns `fatal: not a git repository`. There is no commit history to diff against.

Source files inspected (excluding `node_modules/` and generated `dist/`):

```text
Backend/
├── .env
├── .env.example
├── .gitignore
├── app.js
├── config/DbConnect.js
├── controllers/userController.js
├── controllers/webhookController.js
├── package.json
├── package-lock.json
├── routes/userRoutes.js
├── schema.sql
├── server.js
└── services/user.js

Docs/
├── Project_doc.md
└── specs/
    ├── phase-01.md
    └── phase-0-1-1.md   (the audit/planning prompt; not application documentation)

Frontend/
├── .env
├── .env.example
├── .gitignore
├── eslint.config.js
├── index.html
├── Opencode.md
├── package.json
├── postcss.config.js
├── tailwind.config.js
├── vite.config.js
├── README.md
└── src/
    ├── App.css
    ├── App.jsx
    ├── index.css
    ├── main.jsx
    ├── assets/
    ├── components/
    │   ├── DetailPanel.jsx
    │   ├── Icons.jsx
    │   ├── LeftRail.jsx
    │   ├── StatusBar.jsx
    │   ├── TopBar.jsx
    │   └── map/
    │       ├── DependencyMap.jsx
    │       ├── FileNode.jsx
    │       ├── FolderNode.jsx
    │       └── buildElements.js
    ├── data/sampleRepository.js
    ├── hooks/useTheme.js
    └── lib/
        ├── githubUrl.js
        ├── kinds.js
        ├── repositoryGraph.js
        └── supabaseClient.js
```

Approximate source size:

- Frontend `src/` — 2,482 lines across JS, JSX, and CSS.
- Backend JS + SQL — 314 lines.
- No test files anywhere outside `node_modules/`.

---

## 3. Verified frontend state

### 3.1 Stack

**Verified** in `Frontend/package.json`:

- React `^19.2.8`, React DOM `^19.2.8`
- Vite `^8.2.2`
- `@xyflow/react` `^12.12.0` (React Flow)
- `dagre` `^0.8.5`
- Tailwind CSS `^3.4.19` via PostCSS
- `@clerk/react` `^6.18.4`
- `@supabase/supabase-js` `^2.118.0`
- ESLint 10 with `eslint-plugin-react-hooks` and `eslint-plugin-react-refresh`

The installed `@tailwindcss/vite` v4 package is present but is not used. `Frontend/vite.config.js` only registers `@vitejs/plugin-react`. Tailwind is loaded through `postcss.config.js` and `src/index.css` (`@tailwind base/components/utilities`). This matches the Phase 01 stack decision.

### 3.2 Application shell

**Verified by inspection.** The shell is assembled in `Frontend/src/App.jsx`:

- `TopBar.jsx` — brand, GitHub URL form, theme control, Clerk auth controls.
- `LeftRail.jsx` — repository summary, edge legend, file-kind legend, reading hints, sample-data note.
- `DependencyMap.jsx` — React Flow canvas with background and controls.
- `DetailPanel.jsx` — selected file, kind badge, path, fan-in/fan-out, import lists.
- `StatusBar.jsx` — repository name, file/edge counts, expanded folder, selected path, hints.

Layout CSS lives in `Frontend/src/index.css`. `Frontend/src/App.css` is unused scaffold CSS and is not imported anywhere.

### 3.3 Theme

**Verified by inspection.**

- `Frontend/src/hooks/useTheme.js` implements `system`, `light`, and `dark` preferences.
- The preference is stored in `localStorage` under `cartograph-theme`.
- A pre-paint inline script in `Frontend/index.html` applies the theme before first paint.
- A `matchMedia('(prefers-color-scheme: dark)')` listener reacts to OS changes while the app is open.
- Both palettes are defined as CSS variables in `Frontend/src/index.css`; dark mode is not an inversion of light mode.

**Needs manual verification:** no flash on reload, and live OS-theme switching.

### 3.4 Sample repository and graph

**Verified by inspection and by executing the fixture module.**

- `Frontend/src/data/sampleRepository.js` exports 22 files and 23 edges across 7 folders: `root`, `app`, `components`, `hooks`, `lib`, `styles`, `tests`.
- The fixture is labelled “Sample” in the left rail and status bar.
- `Frontend/src/lib/repositoryGraph.js`:
  - `buildFileMap`, `getFolders`, `getFolderStats`, `getFolderEdges`
  - `getLayout` uses Dagre with `rankdir: 'LR'`, fixed `nodesep`/`ranksep`/margins
  - `getFileNeighbours` computes direct imports and imported-by lists
- `Frontend/src/components/map/buildElements.js`:
  - expands exactly one folder at a time
  - aggregates collapsed folder edges with counts
  - resolves edges touching the expanded folder to individual files
  - applies `default`, `incoming`, `outgoing`, and `dim` tones
- `DependencyMap.jsx` sets nodes non-draggable, non-connectable, non-selectable; `fitView` is enabled.
- `App.jsx` clears selection on Escape and canvas click.

The layout is deterministic for the same repository and expansion state because Dagre is fed sorted folder and edge data.

### 3.5 Repository URL validation

**Verified by inspection.**

- `Frontend/src/lib/githubUrl.js` accepts `http(s)://(www.)github.com/owner/repository`.
- The Open button is disabled until the URL matches.
- Submitting shows the honest notice: repository parsing is not part of this phase and the sample stays loaded (`App.jsx` `handleSubmit`).
- No network request is made by the submit handler.

### 3.6 Authentication UI

**Verified by inspection.** This is **beyond Phase 01 scope**.

- `Frontend/src/main.jsx` wraps the app in `ClerkProvider` using `VITE_CLERK_PUBLISHABLE_KEY`.
- `Frontend/src/App.jsx` uses `useAuth()`:
  - while `isLoaded` is false, it shows a loading screen;
  - when `isSignedIn` is false, it shows a signed-out card with `SignInButton`;
  - when signed in, it renders the Phase 01 shell.
- `Frontend/src/components/TopBar.jsx` adds `SignInButton`, `SignUpButton`, `SignOutButton`, and `UserButton`.

This is a **client-side UI gate only**. It is not an authorization boundary. The frontend makes no API calls to the backend and does not attach a Clerk token to any request.

### 3.7 Supabase client in frontend

**Partially verified / unused.**

- `Frontend/src/lib/supabaseClient.js` creates a Supabase client from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- No file imports it. It is dead code today.
- `Frontend/.env.example` documents the two `VITE_SUPABASE_*` variables, but does not document `VITE_CLERK_PUBLISHABLE_KEY`, even though `main.jsx` requires it.

### 3.8 Frontend documentation drift

- `Frontend/Opencode.md` says the stack is Next.js 16, TypeScript strict, Tailwind v4, and pnpm. That is not the implemented stack. The Phase 01 spec explicitly kept Vite + React 19 + JSX + Tailwind v3.
- `Frontend/README.md` points to `docs/specs/phase-01.md` relative to `Frontend/`; the actual file is `Docs/specs/phase-01.md`.
- `Frontend/README.md` does not mention the Clerk sign-in gate.

These are documentation issues, not runtime issues. They are reconciled in this audit pass.

---

## 4. Verified backend state

### 4.1 Runtime and dependencies

**Verified** in `Backend/package.json`:

- `express` `^5.3.0`
- `@supabase/supabase-js` `^2.118.0`
- `@clerk/backend` `^3.26.5`
- `@clerk/express` `^2.1.86`
- `svix` `^2.9.1`
- `dotenv` `^18.0.9`
- `@ngrok/ngrok` `^1.7.0`
- `nodemon` `^3.1.14`

Scripts:

- `start`: `node server.js`
- `dev`: `nodemon server.js`
- `test`: `echo "Error: no test specified" && exit 1` — **no backend tests exist**

There is no backend lint or build script.

### 4.2 Bootstrap and middleware order

**Verified** in `Backend/app.js`:

1. `express()` app is created.
2. A permissive CORS middleware sets `Access-Control-Allow-Origin: *`, all common methods, and allows `Authorization` plus Svix headers (`app.js` lines 9–23).
3. A wrapper skips `express.json()` only when `req.originalUrl === "/api/webhooks/clerk"` (`app.js` lines 25–32).
4. `express.urlencoded({ extended: true })` is registered globally.
5. `GET /api/health` is public.
6. `userRoutes` are mounted at the root (`app.js` line 45).
7. A JSON 404 handler and a global error handler follow.

There is **no `clerkMiddleware()`**, no `requireAuth`, no `getAuth` call, and no other request-authentication middleware anywhere in the backend.

`Backend/server.js` starts the Express listener and, on startup, calls `ngrok.forward(...)` to expose `localhost:3000` on a fixed ngrok domain. `NGROK_AUTHTOKEN` is read implicitly from the environment (`authtoken_from_env: true`).

### 4.3 Routes

**Verified** in `Backend/routes/userRoutes.js`:

| Method | Path | Handler | Protection |
|---|---|---|---|
| POST | `/api/webhooks/clerk` | `handleClerkWebhook` | Svix signature only |
| POST | `/SignUp` | `createUser` | none |
| POST | `/SignIn` | `createUser` | none |
| GET | `/users/:id` | `getUser` | none |
| PATCH | `/users/:id` | `updateUser` | none |
| DELETE | `/users/:id` | `deleteUser` | none |

The webhook route uses `express.raw({ type: "application/json" })`. The raw-body bypass in `app.js` allows this to work for the exact path. The route is registered before the standard user routes in the same router.

### 4.4 Controllers and services

**Verified** in `Backend/controllers/userController.js` and `Backend/services/user.js`:

- `createUser` passes the entire `req.body` to `upsertUser`.
- `updateUser` merges `{ id: req.params.id, ...req.body }` and passes it to `upsertUser`. A body field named `id` can overwrite the path parameter because the spread comes last only for fields not already present; the explicit `id` is first, so a body `id` does overwrite it.
- `getUser` reads `req.params.id` directly.
- `deleteUser` deletes `req.params.id` directly.
- `upsertUser` performs `supabase.from("users").upsert(userData, { onConflict: "id" }).select().single()`.
- `GetUserById` selects by `id`.
- `DeleteUserById` deletes by `id`.

There is no input schema validation, no field whitelist, and no ownership check.

### 4.5 Supabase client

**Verified** in `Backend/config/DbConnect.js`:

- Reads `SUPABASE_URL`.
- Selects `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY`.
- Creates a single shared client with the selected key.
- Falls back to placeholder URL/key values when the environment is missing, so the server can start in a misconfigured state.
- The service-role key **bypasses RLS**. Because this client is used for every user operation, RLS is not an effective guard for backend routes.

### 4.6 Clerk webhook

**Verified** in `Backend/controllers/webhookController.js`:

1. Reads `CLERK_WEBHOOK_SECRET`. Missing secret returns 500.
2. Requires `svix-id`, `svix-timestamp`, and `svix-signature`. Missing headers return 400.
3. Normalizes `req.body` to a string. Because the route uses `express.raw`, this is normally a `Buffer`.
4. Calls `new Webhook(secret).verify(payloadString, headers)`. This verifies the signature and the Svix timestamp tolerance.
5. Parses JSON only after verification.
6. Handles:
   - `user.created` and `user.updated` — extracts email, first name, last name, username from Clerk fields and OAuth fallbacks, then upserts `users`.
   - `user.deleted` — deletes the user row.
   - `session.created` — logs only.
   - default — logs and returns 200.
7. Returns 200 for handled events; 500 if the database operation throws.

**Positive finding:** webhook signature verification is implemented correctly with the raw request body. This is the strongest security control in the current backend.

**Gaps:** no event-id idempotency, no event ordering protection, no allowlist for subscribed event types, no organization events, no storage of delivery metadata, and no protection against a late `user.updated` resurrecting a deleted user.

### 4.7 Data persistence

**Verified** in `Backend/schema.sql`:

Only one table exists: `public.users`.

| Column | Type | Constraint |
|---|---|---|
| `id` | `TEXT` | primary key (Clerk user ID) |
| `email` | `TEXT` | none |
| `first_name` | `TEXT` | none |
| `last_name` | `TEXT` | none |
| `username` | `TEXT` | none |
| `created_at` | `TIMESTAMPTZ` | default `NOW()` |
| `updated_at` | `TIMESTAMPTZ` | default `NOW()` |

RLS is enabled. Two policies exist:

1. `"Service role full access on users"` — `FOR ALL TO service_role USING (true) WITH CHECK (true)`.
2. `"Allow users to read user profiles"` — `FOR SELECT TO authenticated, anon USING (true)`.

There is no trigger to maintain `updated_at`, no unique index on email, no check constraints, and no organization, membership, repository, analysis, or webhook-event table.

There is no migrations directory or migration tool. `schema.sql` is a single manual SQL file.

---

## 5. Verified authentication and persistence behaviour

### 5.1 What happens today

1. A visitor loads the Vite app.
2. `ClerkProvider` loads the Clerk session. Until `isLoaded` is true, the app shows “Loading Cartograph…”.
3. If signed out, the visitor sees a welcome card and a Clerk sign-in modal button. The Phase 01 shell is not mounted.
4. If signed in, the visitor sees the Phase 01 shell.
5. Clerk delivers `user.created` / `user.updated` / `user.deleted` webhooks to the backend (when ngrok and the Clerk dashboard are configured).
6. The backend verifies the Svix signature and upserts or deletes the row in `public.users` using the service-role key.
7. The frontend never calls the backend and never sends a Clerk token to it.
8. The backend never verifies a Clerk session for any user-facing route.

### 5.2 What is and is not an authorization boundary

- The Clerk sign-in gate in `App.jsx` is a **UI convenience**, not a security boundary. Any bundle can be modified in a browser.
- The webhook signature is a real **machine-to-machine** authentication boundary.
- The user CRUD routes have **no authentication boundary at all**.
- Supabase RLS is enabled but is bypassed by the backend’s service-role key and is misconfigured for direct anon/authenticated access.

### 5.3 Persistence scope

The only persisted application data is the `users` row. There is no persisted repository, graph, analysis, organization, membership, invitation, or audit data.

---

## 6. Security findings

Severity reflects current reachability and impact, not eventual production deployment.

### Critical

#### SEC-01 — Unauthenticated user CRUD over a service-role database client

**Evidence:**

- `Backend/routes/userRoutes.js` lines 11–15 register `/SignUp`, `/SignIn`, `GET /users/:id`, `PATCH /users/:id`, and `DELETE /users/:id` with no middleware.
- `Backend/app.js` has no `clerkMiddleware()`, `requireAuth`, or equivalent.
- `Backend/controllers/userController.js` trusts `req.params.id` and `req.body`.
- `Backend/config/DbConnect.js` line 5 uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.

**Impact:** anyone who can reach the backend can:

- create or overwrite a user row with any `id`;
- read any user’s stored profile by ID;
- change any user’s name, email, or username;
- delete any user row.

The caller does not need a Clerk session or any credential.

**Recommended fix:** Phase 02 must add Clerk session middleware to every non-public route, remove the public `/SignUp` and `/SignIn` routes, remove the arbitrary `:id` user routes, and perform self/org authorization before any service-role query.

#### SEC-02 — RLS policy exposes every user row to `anon` and `authenticated`

**Evidence:** `Backend/schema.sql` lines 23–28:

```text
CREATE POLICY "Allow users to read user profiles"
ON public.users
FOR SELECT
TO authenticated, anon
USING (true);
```

**Impact:** if the Supabase anon key is used from a browser or any untrusted client, `select * from users` returns every profile, including email addresses. RLS is enabled but the policy is effectively public read access.

**Recommended fix:** drop this policy. Replace it with a self-only policy for `authenticated`, and add organization-scoped read policies only where the product deliberately shares profile fields. Verify with the anon key that the table returns zero rows. Do not treat “RLS is enabled” as sufficient; the policy must be restrictive.

### High

#### SEC-03 — The service-role key is the default database credential with no authorization layer

**Evidence:** `Backend/config/DbConnect.js` line 5 selects the service-role key first; all services import that single client (`Backend/services/user.js` line 1). No controller performs an authorization check before using it.

**Impact:** RLS is bypassed for every backend query. A single missing check or a future careless route becomes a full-database compromise. The current SEC-01 routes demonstrate the failure mode.

**Recommended fix:** use the service-role client only for webhook processing, backfill/sync jobs, and explicitly authorized administrative operations. Normal user-facing reads should use a per-request Supabase client carrying the Clerk token so RLS applies. Every privileged operation must call an explicit `assertSelf` / `assertOrgMember` / `assertOrgAdmin` helper first. Do not rely on the key’s secrecy as authorization.

#### SEC-04 — Clerk secret key present in `Frontend/.env`

**Evidence:** `Frontend/.env` contains a variable named `CLERK_SECRET_KEY` with a non-empty value. The value was **not** recorded or printed. The filename and variable name are the finding.

**Impact:** Vite only exposes `VITE_`-prefixed variables to client code, and a scan of the current `Frontend/dist/assets` bundle found no Clerk secret or Supabase service-role marker. The secret is therefore not currently shipped to browsers. It is still exposed to anyone with access to the frontend workspace, backups, or any accidental commit. It also creates a high risk that someone will later add the `VITE_` prefix or read the file in a client-side tool.

**Recommended fix:** remove `CLERK_SECRET_KEY` from `Frontend/.env` immediately. Keep it only in the backend environment. Because the value has existed in a frontend file, treat it as exposed and rotate it in the Clerk dashboard with owner approval. Add a pre-commit/CI check that rejects `CLERK_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `sk_` values under `Frontend/`.

#### SEC-05 — No organization model or organization-scoped authorization

**Evidence:** `Backend/schema.sql` contains only `public.users`. No backend source file contains organization, membership, `org_id`, or role logic. `Frontend/src` contains no organization UI or API usage.

**Impact:** the product’s core tenancy rule — an analysis belongs to an organization and visibility follows membership — cannot be enforced. Any future repository or analysis table created without a deliberate organization column and policy would be globally shared by default.

**Recommended fix:** Phase 02 must add organizations, memberships, roles, organization context, RLS policies, and server-side membership checks before any repository/analysis data is introduced. The proposed design is in `Docs/specs/phase-02.md`.

#### SEC-06 — Webhook processing is not idempotent or order-safe

**Evidence:** `Backend/controllers/webhookController.js` verifies the signature, then directly upserts or deletes. It does not record the Svix delivery ID, does not compare event timestamps, and does not guard against stale events.

**Impact:**

- A retried `user.created`/`user.updated` is usually harmless because it upserts, but it can overwrite newer data if the retry is stale.
- A delayed `user.updated` delivered after `user.deleted` can recreate a deleted user.
- Duplicate `user.deleted` events are harmless today, but the pattern will not extend safely to organization membership events.
- There is no record of which events were processed, so failures cannot be audited or replayed deliberately.

**Recommended fix:** add a `webhook_events` ledger keyed by `svix-id`; make processing idempotent; compare Clerk `updated_at`/event timestamps before applying updates; soft-delete users or keep a tombstone so stale updates cannot resurrect them. See Phase 02.

### Medium

#### SEC-07 — Mass assignment and identity trust in user routes

**Evidence:** `Backend/controllers/userController.js` line 6 passes `req.body` directly to `upsertUser`; line 20 spreads `req.body` after setting `id` from the path, allowing a body `id` to override the path.

**Impact:** even after authentication is added, a caller could attempt to write fields that were not intended to be client-writable. The current route also lets the caller choose the identity (`id`) rather than deriving it from the verified session.

**Recommended fix:** whitelist writable fields, validate types and lengths, never accept `id`, `email`, `role`, or ownership fields from the request body, and derive identity exclusively from the verified Clerk session.

#### SEC-08 — Permissive CORS

**Evidence:** `Backend/app.js` lines 10–18 set `Access-Control-Allow-Origin: *` and allow `Authorization`.

**Impact:** any website can call the API from a browser. This is not a direct authentication bypass, but it broadens exposure and makes token exfiltration or CSRF-style abuse easier if credentials are ever stored in cookies. It also prevents a meaningful origin allowlist.

**Recommended fix:** configure an explicit `FRONTEND_ORIGIN` allowlist per environment. Do not use `*` in production. Keep `Authorization` in the allowed headers and do not enable credentials unless cookies are deliberately introduced.

#### SEC-09 — Internal error messages returned to clients

**Evidence:** `Backend/controllers/userController.js` lines 13, 30, 47, 63 return `error.message`; `Backend/services/user.js` wraps Supabase error messages.

**Impact:** database errors, constraint names, and query details can leak to callers. This aids reconnaissance and can expose schema details.

**Recommended fix:** log the detailed error server-side with a correlation ID, and return a stable error code plus a safe message to the client.

#### SEC-10 — Silent fallback from service-role key to anon key

**Evidence:** `Backend/config/DbConnect.js` line 5 uses `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY`.

**Impact:** a missing service-role key does not fail fast. The backend may start with the anon key, silently changing which RLS policies apply and producing confusing partial failures. It also makes it harder to prove which credential is in use.

**Recommended fix:** require `SUPABASE_SERVICE_ROLE_KEY` for the admin client and fail startup if it is missing. Use a separate, clearly named client for any user-scoped operations.

#### SEC-11 — Schema integrity, constraints, and indexes are insufficient

**Evidence:** `Backend/schema.sql`:

- `email` has no unique or case-insensitive index.
- `updated_at` has no trigger, so it is only correct when the writer supplies a value.
- No `CHECK` constraints on names or usernames.
- No foreign keys or organization tables.
- No index on `email` or `username`.
- No `deleted_at`/tombstone for safe deletion.

**Impact:** duplicate or malformed profiles are possible; lookups degrade as the table grows; out-of-order webhooks cannot be detected; a deleted user can be recreated.

**Recommended fix:** add the constraints and indexes in Phase 02, including a case-insensitive unique email index where appropriate, an `updated_at` trigger, and source-timestamp/tombstone columns.

#### SEC-12 — No automated tests

**Evidence:** no test files outside `node_modules`; `Backend/package.json` line 16 is a placeholder that intentionally exits 1; the frontend has no test script.

**Impact:** authentication, authorization, RLS, and webhook behaviour cannot be regression-tested. The current critical issues would not be caught by a test suite because none exists.

**Recommended fix:** add backend tests for auth, authorization, webhook verification, idempotency, and RLS. Use the Node built-in test runner where possible; any additional package requires approval. Add a small frontend smoke test only if the owner approves a test tool.

### Low

#### SEC-13 — Webhook raw-body bypass is path-string fragile

**Evidence:** `Backend/app.js` line 28 compares `req.originalUrl === "/api/webhooks/clerk"`. `originalUrl` includes the query string, so `/api/webhooks/clerk?foo=1` would be JSON-parsed before the webhook handler and signature verification would fail.

**Impact:** a webhook delivered with a query string is rejected or retried. This is availability/robustness, not a bypass.

**Recommended fix:** mount the webhook route with its raw parser before the global JSON parser, rather than using a string comparison in a global middleware.

#### SEC-14 — Unused frontend Supabase client and dead scaffold CSS

**Evidence:** `Frontend/src/lib/supabaseClient.js` is not imported anywhere. `Frontend/src/App.css` is not imported anywhere.

**Impact:** dead code creates confusion about whether the browser talks to Supabase directly, and it can hide an accidental future exposure of the anon key. The anon key is intended to be public, but the unused client makes the security model ambiguous.

**Recommended fix:** remove the unused client or use it deliberately with RLS and a documented purpose. Remove `App.css` if it is confirmed unused. This is cleanup, not a security fix on its own.

#### SEC-15 — ngrok tunnel starts automatically with the server

**Evidence:** `Backend/server.js` lines 5–12 call `ngrok.forward` on every startup, with a fixed domain and `authtoken_from_env: true`. The async call is not awaited or caught inside the listen callback.

**Impact:** local development always attempts an external tunnel, depends on a network and a valid token, and may expose the development server if the tunnel is left running. A failed tunnel can also produce an unhandled promise rejection. It is not appropriate for production.

**Recommended fix:** move ngrok into a separate dev script or guard it behind `NODE_ENV !== "production"` and an explicit opt-in flag.

#### SEC-16 — Build warning and documentation drift

**Evidence:** `npm run build` warns that the main JS chunk is 632.33 kB (191.83 kB gzip), above the 500 kB warning threshold. `Frontend/Opencode.md` describes a different stack. `Frontend/README.md` links to the wrong relative docs path and omits the auth gate.

**Impact:** no direct security impact; the bundle size is a performance concern and the documentation drift can cause future agents to build the wrong stack.

**Recommended fix:** track bundle size as a performance item; reconcile the docs in this audit pass. Do not migrate the stack.

---

## 7. Data model and RLS assessment

### Current

- One table: `public.users`.
- RLS enabled.
- Two policies: service-role full access (redundant because service role bypasses RLS) and public read for `anon`/`authenticated` (critical exposure).
- No organization, membership, repository, analysis, or webhook-event tables.
- No migration history.

### Required before any organization-owned data

- Every organization-owned table must have a non-null organization identifier.
- RLS must be enabled on every table by default.
- A table with no policy must return nothing to untrusted roles, not everything.
- Server-side service-role operations must still perform explicit authorization checks.
- Cross-organization access must be tested by query, not only by UI.

The proposed schema and policies are in `Docs/specs/phase-02.md`. They are **not** applied by this audit.

---

## 8. Environment and secret inventory

Values were not read into this document. Only filenames and variable names are recorded.

### `Frontend/.env`

| Variable | Expected exposure | Current use | Assessment |
|---|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Public | `Frontend/src/main.jsx` | Correct prefix for a public key |
| `VITE_SUPABASE_URL` | Public | `Frontend/src/lib/supabaseClient.js` (unused) | Public by design |
| `VITE_SUPABASE_ANON_KEY` | Public | `Frontend/src/lib/supabaseClient.js` (unused) | Public by design, but the client is unused |
| `CLERK_SECRET_KEY` | **Secret** | Not referenced by frontend code | **Must be removed; rotate with owner approval** |

### `Backend/.env`

| Variable | Expected exposure | Current use | Assessment |
|---|---|---|---|
| `PORT` | Non-secret | `Backend/server.js` | Fine |
| `SUPABASE_URL` | Non-secret | `Backend/config/DbConnect.js` | Fine |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | `Backend/config/DbConnect.js` | Server-only; must be paired with explicit authorization checks |
| `CLERK_PUBLISHABLE_KEY` | Public | Not referenced by backend code | Unnecessary but not harmful |
| `CLERK_SECRET_KEY` | **Secret** | Not referenced by current backend code, but required by `@clerk/express` once middleware is added | Correct location |
| `CLERK_WEBHOOK_SECRET` | **Secret** | `Backend/controllers/webhookController.js` | Correct |
| `NGROK_AUTHTOKEN` | **Secret** | Implicitly read by `@ngrok/ngrok` in `Backend/server.js` | Dev-only; should not be required in production |

### Environment documentation drift

- `Backend/.env.example` lists `PORT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, and `CLERK_WEBHOOK_SECRET`.
- It omits `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, and `NGROK_AUTHTOKEN`, all of which exist in the real environment or are required by the intended auth flow.
- `Frontend/.env.example` omits `VITE_CLERK_PUBLISHABLE_KEY`, which the app requires.
- `Frontend/.env.example` documents an anon key for a client that is not used.

The Phase 02 spec includes a corrected environment matrix. Do not copy secret values into examples.

### Bundle scan

A text scan of the freshly built `Frontend/dist/assets` bundle found no occurrences of Clerk secret markers, Supabase service-role markers, or webhook secret markers. This is consistent with Vite’s `VITE_`-only exposure rule. It does **not** remove the risk of the secret sitting in `Frontend/.env`.

---

## 9. Build, lint, and test status

Commands were run from the directories shown. No packages were installed.

### Frontend lint — **FAIL**

```text
cd Frontend
npm run lint
```

Result:

```text
Frontend/src/main.jsx
  2:10  error  'StrictMode' is defined but never used  no-unused-vars

✖ 1 problem (1 error, 0 warnings)
```

The failure is exactly the reported unused import. `StrictMode` is imported in `Frontend/src/main.jsx` but not used because the root is rendered without a `<StrictMode>` wrapper.

### Frontend build — **PASS** (with warning)

```text
cd Frontend
npm run build
```

Result:

- Vite 8.3.5
- 543 modules transformed
- `dist/index.html` 1.27 kB
- `dist/assets/index-lwEbzFXP.css` 33.04 kB
- `dist/assets/index-Ch00XWuM.js` 632.33 kB (191.83 kB gzip)
- Warning: chunk larger than 500 kB after minification.

### Backend test — **NO TEST SUITE**

```text
cd Backend
npm test
```

The script is `echo "Error: no test specified" && exit 1`. There are no test files. Running it is expected to fail by design. This is reported, not hidden.

### Backend lint/build — **NOT CONFIGURED**

There is no backend lint or build script. Backend code is plain CommonJS JavaScript and is not type-checked.

### Summary

| Check | Status |
|---|---|
| `Frontend/npm run lint` | **Fail** — 1 unused-import error |
| `Frontend/npm run build` | **Pass** — chunk-size warning |
| `Backend/npm test` | **No tests** — placeholder script exits 1 |
| Backend lint | Not configured |
| Backend build | Not applicable |
| TypeScript check | Not applicable — JavaScript project |

---

## 10. Features not found

The following items from the product definition are **not found** in the repository. They are not partially implemented; they do not exist.

- GitHub repository discovery or fetching.
- Source-file parsing of any kind.
- Language adapters.
- Dependency resolution (imports, re-exports, dynamic imports, `require()`).
- Coverage reporting.
- Live parsing progress.
- Real repository data or a real dependency graph.
- Blast-radius analysis.
- Dependency-chain analysis.
- AI file explanations.
- Repository chat.
- File labelling for convention-unidentified files.
- Organization model, membership, roles, or organization context.
- Repository/analysis persistence.
- Billing or plan limits.
- Private repository support.
- Automated tests.
- Database migrations or migration history.
- Rate limiting, request validation, or structured logging.
- Production deployment configuration.

---

## 11. Phase 01 scope reconciliation

The original Phase 01 spec (`Docs/specs/phase-01.md`) defined an app shell driven by fixture data, with no authentication, organizations, real data, or network requests.

### 11.1 Implemented and verified by inspection

- Fixed shell layout: top bar, left rail, map canvas, detail panel, status bar.
- Three-state theme with `localStorage` persistence and a pre-paint script.
- System-theme change listener.
- Bundled sample repository: 22 files, 23 edges, 7 folders.
- Folder collapse/expand with one expanded folder at a time.
- Aggregated folder edges with counts.
- Deterministic Dagre layout.
- File selection, incoming/outgoing highlighting, unrelated element dimming.
- Detail panel with fan-in/fan-out and clickable import lists.
- Escape and canvas-background selection clearing.
- GitHub URL validation and honest out-of-scope notice.
- File-kind colours and edge-direction colours from CSS variables.
- Focus-visible styles are defined globally in `index.css`. No ambient or looping animation was found in the shell CSS; motion is limited to user-driven React Flow interactions.

### 11.2 Implemented but not manually verified

- No theme flash on reload.
- Live OS theme switching.
- Initial folder-only map and correct counts.
- Folder expansion and collapse in the browser.
- Edge colouring and dimming in the browser.
- Detail-panel selection changes.
- Escape and background clearing.
- URL notice and sample retention.
- Window resize behaviour and shell non-scrolling.
- Clerk sign-in, sign-up, sign-out, and user-button flows.
- Webhook delivery through ngrok.

### 11.3 Added beyond Phase 01 scope

- Clerk authentication UI and session gate.
- Express backend with user CRUD.
- Supabase `users` table and RLS.
- Clerk webhook sync for `user.created`, `user.updated`, and `user.deleted`.
- ngrok tunnel startup.
- Frontend Supabase client scaffold (unused).

These additions are real, but they were not part of the Phase 01 acceptance criteria.

### 11.4 Deviations from the Phase 01 spec

- The shell is not visible when signed out. Phase 01 assumed no authentication.
- Clerk auth introduces network requests, while Phase 01 said “no network request.”
- `npm run lint` fails; the Phase 01 completion rule requires it to pass.
- `Frontend/Opencode.md` describes a different stack (Next.js/TypeScript/Tailwind v4) than the implemented Vite/JSX/Tailwind v3 stack.
- `Frontend/src/App.css` is dead scaffold CSS.
- The frontend requires `VITE_CLERK_PUBLISHABLE_KEY` but `.env.example` does not document it.

### 11.5 Closure status

**Phase 01 is not closed.**

| Requirement | Status |
|---|---|
| Shell and map implemented | Verified by inspection |
| Theme implemented | Verified by inspection; manual check pending |
| Fixture map implemented | Verified by inspection |
| Selection and detail panel implemented | Verified by inspection |
| URL notice implemented | Verified by inspection |
| `npm run lint` | **Fail** |
| `npm run build` | **Pass** |
| Manual acceptance check | **Not run** |

Do not mark Phase 01 accepted until the owner runs the nine manual checks in `Docs/specs/phase-01.md` and lint is fixed.

---

## 12. Manual checks still required

### Phase 01

1. Reload with each theme choice; confirm the correct palette appears with no flash.
2. Change the OS theme while “follow system” is selected; confirm the app follows.
3. Confirm the initial map shows folder boxes only, with correct counts.
4. Expand a folder; confirm its files appear inside it and other folders collapse.
5. Select a file; confirm outgoing edges are amber, incoming are green, unrelated elements dim, and the detail panel lists the right files.
6. Click an import in the panel; confirm selection moves and the panel updates.
7. Press Escape and click the background; confirm selection clears.
8. Enter a GitHub URL and press Open; confirm the honest notice appears and the sample stays.
9. Resize the window; confirm the map resizes and the shell does not scroll.

### Authentication

10. Sign in with the configured Clerk instance; confirm the shell appears.
11. Sign out; confirm the signed-out card appears.
12. Sign up through Clerk; confirm the webhook creates a `users` row.
13. Update the Clerk profile; confirm the webhook updates the row.
14. Delete the Clerk user; confirm the webhook deletes the row.
15. Confirm the browser request does not expose any secret.

### Backend and database

16. Confirm which Supabase key the backend actually uses at startup.
17. Confirm RLS behaviour with the anon key (expected to fail current policy — this is the finding).
18. Confirm CORS from the real frontend origin.
19. Confirm webhook signature rejection for an invalid signature.
20. Confirm the backend does not accept a forged user ID without a session (expected to fail currently — this is SEC-01).

### Phase 02

The full test matrix is in `Docs/specs/phase-02.md`.

---

## 13. Documentation drift and disposition

| Document | Drift | Disposition |
|---|---|---|
| `Docs/Project_doc.md` | Describes product intent, not current implementation | Add an implementation-status note pointing to this audit and the architecture doc |
| `Docs/specs/phase-01.md` | Written as a forward spec; no record of what was actually built | Append a reconciliation section with verified/unverified/out-of-scope status |
| `Docs/specs/phase-02.md` | Did not exist | Created as a proposed specification; application code and SQL were subsequently implemented by the security remediation |
| `Docs/architecture/current-architecture.md` | Did not exist | Created from the audited code; updated after the security remediation |
| `Docs/audits/implementation-audit.md` | Did not exist | This document |
| `Frontend/Opencode.md` | Says Next.js 16, TypeScript, Tailwind v4, pnpm | Reconciled to Vite, React 19, JSX, Tailwind v3, npm |
| `Frontend/README.md` | Wrong relative docs path; omits auth gate | Corrected path and added current auth note |
| `Frontend/README.md` / `.env.example` | Missing `VITE_CLERK_PUBLISHABLE_KEY` | Documented in the Phase 02 environment matrix; example file update is listed as a Phase 02 task |

`Docs/specs/phase-0-1-1.md` is the audit/planning prompt. It is not application documentation and was left unchanged.

---

## 14. Audit limitations

- No Git history exists, so change history and authorship could not be audited.
- The backend server and ngrok tunnel were not started; no live webhook was sent.
- The live Clerk and Supabase dashboards were not inspected. Organization enablement, webhook subscriptions, and actual RLS behaviour in the hosted project are **needs manual verification**.
- The Supabase anon-key RLS exposure is based on `schema.sql` plus the presence of an anon key; it was not exercised against the hosted database.
- The frontend was not opened in a browser; all UI findings are code inspection plus a production build.
- No dependency vulnerability audit was performed. Package versions were read, not audited against advisories.
- Secret values were intentionally not read into this document. The presence and variable names are verified.
- The current `dist/` bundle was scanned after the build; it contains no obvious secret markers, but this is not a substitute for removing the secret from `Frontend/.env`.

---

## 15. Recommended sequence after approval

This section preserves the original recommendation. The approved code/SQL remediation is recorded in `Docs/audits/security-remediation.md`; live migration, secret rotation, and acceptance checks remain owner actions.

1. Remove `CLERK_SECRET_KEY` from `Frontend/.env` and rotate it with owner approval.
2. Fix the unused `StrictMode` import and run `npm run lint`.
3. Add Clerk session middleware and remove the unauthenticated user routes.
4. Replace the open `users` RLS policy with self-only access.
5. Add organizations, memberships, webhook idempotency, and organization-scoped RLS as specified in Phase 02.
6. Add the Phase 02 test matrix and run it against a staging project.
7. Run the Phase 01 manual acceptance check and close Phase 01 separately.
