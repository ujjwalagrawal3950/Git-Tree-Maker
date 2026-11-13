# Cartograph — Current Architecture

**Snapshot date:** 2026-11-12 (updated 2026-11-13 for Phase 03/04 repository verification)
**Status:** describes the code that exists on disk after the approved security remediation and the completed Phase 03 (GitHub URL validation) and Phase 04 (GitHub API repository verification) work. It does not claim that the database migration or live Clerk/Supabase configuration has been applied.
**Companions:**

- `Docs/audits/implementation-audit.md` — original findings and evidence.
- `Docs/audits/security-remediation.md` — fixes applied, checks run, and owner actions still required.
- `Docs/specs/phase-01.md` — the Phase 01 shell specification and reconciliation.
- `Docs/specs/phase-02.md` — the implemented authentication, authorization, organization, and data-security design.
- `Docs/specs/phase_03_github_url_validation.md` — accepted GitHub URL formats and the Phase 03 completion report.
- `Docs/specs/phase-04.md` — GitHub API repository verification design and status.

---

## 1. System context

Cartograph is a two-process application plus two managed services:

```text
┌─────────────────────────────┐
│ Browser                     │
│ Vite + React 19 + JSX       │
│ Clerk React SDK             │
│ React Flow + Dagre          │
│ Bundled sample repository   │
└──────────────┬──────────────┘
               │
               │ Clerk sign-in / session (HTTPS)
               ▼
┌─────────────────────────────┐
│ Clerk                       │
│ Users, sessions, orgs       │
│ Webhooks                    │
└──────────────┬──────────────┘
               │ Svix-signed webhooks
               │ (local development via opt-in ngrok)
               ▼
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ Backend                     │        │ Supabase                    │
│ Node.js + Express 5         │───────▶│ Postgres + RLS              │
│ Clerk session middleware    │        │ users                       │
│ Account + organization API  │        │ organizations               │
│ Clerk webhook handler       │        │ organization_members        │
│ Service-role client         │        │ webhook_events              │
│ (after explicit checks)     │        │ user/org/membership         │
│                             │        │ tombstones                  │
└─────────────────────────────┘        └─────────────────────────────┘
```

Important current facts:

- The frontend calls the backend for account deletion and for repository URL verification (`POST /api/repositories/verify`). Repository *graph* data is still fixture data in the browser; no parsing exists.
- The frontend does not query Supabase. The unused browser Supabase client was removed.
- User-facing backend routes require a verified Clerk session.
- Identity comes from `getAuth(req).userId`, never from a request body or URL parameter.
- Submitted GitHub URLs are validated locally against an exact `github.com` hostname, then verified against a fixed `https://api.github.com` URL rebuilt from the validated owner/repository (Phase 04). No user-supplied hostname is ever fetched.
- The service-role Supabase client is server-only and is used only after explicit self, membership, or admin checks.
- The Clerk webhook signature is the machine-to-machine authentication boundary.

---

## 2. Runtime topology

| Process / service | Default address | Entry point | Responsibility |
|---|---|---|---|
| Frontend dev server | Vite default `http://localhost:5173` | `Frontend/src/main.jsx` | Render the app, Clerk session UI, fixture graph, account-deletion call |
| Backend API | `http://localhost:3000` | `Backend/server.js` → `Backend/app.js` | Health, account API, organization API, Clerk webhook |
| ngrok tunnel | opt-in; domain from `NGROK_DOMAIN` | `Backend/server.js` | Expose the local backend to Clerk webhooks during development |
| Clerk | hosted | `ClerkProvider`; webhook to the backend | Identity provider and session issuer |
| Supabase | hosted | `Backend/config/DbConnect.js` | Persistence for users, organizations, memberships, and webhook state |

`ENABLE_NGROK=true` is required before the backend starts a tunnel. The tunnel is never enabled by default.

---

## 3. Repository layout

```text
Cartograph/
├── Backend/
│   ├── app.js                       Express app, middleware order, route mounting
│   ├── server.js                    Config validation, HTTP listener, opt-in ngrok
│   ├── config/
│   │   ├── env.js                   Environment loading and required-variable checks
│   │   └── DbConnect.js             Service-role client + optional user-scoped client
│   ├── middleware/
│   │   ├── auth.js                  Clerk session and organization-context checks
│   │   ├── errors.js                Async wrapper, safe 404/error responses
│   │   └── security.js              Request IDs, headers, CORS allowlist, rate limits
│   ├── lib/
│   │   ├── errors.js                AppError and safe Clerk/Supabase mapping
│   │   └── validation.js            Bounded input, role, ID, email, timestamp, GitHub URL helpers
│   ├── routes/
│   │   ├── userRoutes.js            /api/me and /api/account
│   │   ├── organizationRoutes.js    Organization, membership, and repository verify/manifest routes
│   │   └── repositoryRoutes.js      Top-level /api/repositories verify and manifest routes
│   ├── controllers/
│   │   ├── userController.js        Self profile and account deletion
│   │   ├── organizationController.js Organization/member/invitation handlers
│   │   ├── repositoryController.js  Tenant check, URL validation, GitHub verify, manifest
│   │   └── webhookController.js     Svix verification, ledger, ordered sync
│   ├── services/
│   │   ├── clerk.js                 Clerk backend API wrapper
│   │   ├── user.js                  User mirror, self-sync, cascade deletion
│   │   ├── organizations.js         Membership/admin authorization and org sync
│   │   ├── github.js                Fixed-host GitHub REST verification + tree discovery
│   │   ├── manifest.js              Normalized file-manifest generation
│   │   └── webhookEvents.js         Webhook ledger claim/finish operations
│   ├── migrations/
│   │   └── 001_phase02_security.sql Apply this to Supabase
│   ├── schema.sql                   Current schema; keep in sync with the migration
│   └── test/                        Node test runner tests (validation, github, repository API, schema)
│
├── Docs/
│   ├── Project_doc.md
│   ├── architecture/current-architecture.md
│   ├── audits/
│   │   ├── implementation-audit.md
│   │   └── security-remediation.md
│   └── specs/
│       ├── phase-01.md
│       ├── phase-02.md
│       ├── phase_03_github_url_validation.md
│       ├── phase-04.md
│       └── phase-0-1-1.md
│
└── Frontend/
    ├── src/
    │   ├── main.jsx                 StrictMode + ClerkProvider + React root
    │   ├── App.jsx                  Shell state, auth gate, selection
    │   ├── components/
    │   │   ├── TopBar.jsx           Auth controls, profile menu, delete-account entry
    │   │   ├── DeleteAccountDialog.jsx Confirmation dialog and error state
    │   │   └── ...                  Rails, panel, status bar, map nodes
    │   ├── data/sampleRepository.js Bundled fixture
    │   ├── hooks/useTheme.js
    │   └── lib/
    │       ├── api.js               Backend fetch helpers: account deletion, repository verification
    │       └── ...                  Graph math, GitHub URL validation, kinds
    ├── scripts/check-secrets.mjs    Frontend secret scan
    ├── index.html
    └── src/index.css                Shell + theme variables + modal styles
```

---

## 4. Frontend architecture

### 4.1 Entry and provider

`Frontend/src/main.jsx`:

- Wraps the app in `<StrictMode>`.
- Wraps `<App />` in `ClerkProvider`.
- Reads the publishable key from `VITE_CLERK_PUBLISHABLE_KEY`.
- Never receives a Clerk secret or Supabase service-role key.

### 4.2 Shell

`Frontend/src/App.jsx` owns shell state: expanded folder, selected file, repository URL, notice, and theme preference. `useAuth()` gates the shell in the UI, but the UI gate is not a security boundary; the backend independently verifies sessions.

Component responsibilities:

- `TopBar` — brand, repository form, theme toggle, Clerk auth controls, custom Delete account entry.
- `DeleteAccountDialog` — confirmation, busy state, and safe error display.
- `LeftRail` — repository summary, legends, reading hints, sample-data note.
- `DependencyMap` — React Flow canvas, node/edge conversion, fit view.
- `DetailPanel` — selected file metadata and neighbours.
- `StatusBar` — counts and current context.

### 4.3 Account UI

- `UserButton` keeps Clerk's profile but hides `profileSection__password`.
- The built-in `profileSection__danger` section is hidden and replaced by a custom **Delete account** menu item.
- The custom item opens a dialog, obtains a Clerk session token with `getToken()`, and calls `DELETE /api/account`.
- The backend deletes the Clerk identity, then deletes the local user row and cascades organization memberships.
- On success, the frontend signs out; if sign-out cannot complete after the identity was deleted, it reloads the signed-out app.

### 4.4 Graph pipeline and theme

The graph is computed entirely in the browser from `sampleRepository`:

```text
sampleRepository
  → buildFileMap / getFolders
  → getFolderStats / getFolderEdges
  → getLayout (Dagre, left-to-right)
  → buildElements (nodes + aggregated edges + selection tones)
  → React Flow nodes and edges
```

There is no server call in this pipeline and no parser. Theme handling remains unchanged: `useTheme` reads `localStorage`, resolves the system preference, applies `data-theme`, and persists changes. The pre-paint script in `index.html` prevents a wrong-theme flash.

---

## 5. Backend architecture

### 5.1 Bootstrap

```text
server.js
  → config/env.js loads Backend/.env
  → assertRuntimeConfig() exits when required variables are missing
  → require("./app")
  → app.listen(PORT)
  → if ENABLE_NGROK=true: start ngrok (errors are caught)
```

Required variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_WEBHOOK_SECRET`. `FRONTEND_ORIGIN` is required in production. The backend never falls back to the anon key.

### 5.2 Middleware order

1. Request ID.
2. Security headers and `Cache-Control: no-store`.
3. Raw-body Clerk webhook route with a dedicated rate limit. It is mounted before the JSON parser and outside CORS because Clerk is a server-to-server caller.
4. CORS allowlist for the frontend.
5. `express.json()` with a bounded body size.
6. `/api` rate limit.
7. Public `/api/health`.
8. `clerkMiddleware({ authorizedParties: config.frontendOrigins })`.
9. Authenticated account and organization routers.
10. Safe 404 and error handlers.

### 5.3 Routes

```text
POST   /api/webhooks/clerk                              Svix-verified webhook
GET    /api/health                                      public
GET    /api/me                                          authenticated self
DELETE /api/account                                     authenticated self; cascade delete

GET    /api/organizations                               authenticated self
POST   /api/organizations                               authenticated creator becomes admin
GET    /api/organizations/:orgId                        authenticated member
DELETE /api/organizations/:orgId                        authenticated admin + name confirmation
GET    /api/organizations/:orgId/members                authenticated member
PATCH  /api/organizations/:orgId/members/:userId        authenticated admin
DELETE /api/organizations/:orgId/members/:userId        self or admin; last-admin guard
POST   /api/organizations/:orgId/invitations            authenticated admin

POST   /api/repositories/verify                         authenticated + active org context; GitHub URL validation and public-repo verification
POST   /api/organizations/:orgId/repositories/verify    active org + membership; same handler
POST   /api/repositories/manifest                       authenticated + active org context; file-manifest generation
POST   /api/organizations/:orgId/repositories/manifest   active org + membership; same handler
```

Every `:orgId` route requires the verified Clerk session's active organization to match the route parameter. The database membership row is then checked independently. Organization routes return `404` when the caller is not a member, so they do not confirm that another organization exists.

Repository routes run the same tenant check (`ensureTenantAuthorization`) before reading the body. The URL is validated by `validateGithubRepositoryUrl` (exact `github.com` hostname, HTTPS only, structured `INVALID_GITHUB_URL` errors); only a valid owner/repository pair is used to rebuild a fixed `https://api.github.com/...` request. Invalid URLs are rejected before any outbound call or record creation.

### 5.4 Services and database access

- `services/user.js` mirrors Clerk users, recovers from a missed `user.created` event on `/api/me`, and invokes the atomic cascade-delete function.
- `services/organizations.js` performs membership/admin checks, active-admin protection, Clerk synchronization, and local mirroring.
- `services/webhookEvents.js` claims events atomically and records processed, ignored, or failed status.
- `services/clerk.js` is the only Clerk backend API wrapper.
- `services/github.js` calls the GitHub REST API against the fixed host `https://api.github.com` with a 10-second timeout, optional `GITHUB_TOKEN` (never logged), `redirect: "manual"`, and stable error codes (`REPOSITORY_NOT_FOUND`, `PRIVATE_REPOSITORY`, `GITHUB_RATE_LIMITED`, `GITHUB_TIMEOUT`, `GITHUB_UNAVAILABLE`, `GITHUB_INVALID_RESPONSE`, `REPOSITORY_MOVED`).
- `services/manifest.js` turns GitHub tree data into a normalized file manifest (Phase 05 file discovery; in flight as of 2026-11-13).
- All privileged operations use `supabaseAdmin` after explicit authorization. `createUserScopedClient()` exists for future RLS-backed reads but is not a fallback path.

### 5.5 Webhook flow

```text
Clerk
  → HTTPS POST /api/webhooks/clerk
  → express.raw body
  → require svix-id / svix-timestamp / svix-signature
  → Svix verify with CLERK_WEBHOOK_SECRET
  → JSON.parse
  → atomic claim in webhook_events
  → ordered switch:
       user.created / user.updated      → conditional user upsert
       user.deleted                     → tombstone + cascade delete
       organization.created / updated   → conditional organization upsert
       organization.deleted             → soft delete + membership deactivation
       organizationMembership.*         → conditional membership upsert/deactivate
  → mark processed, ignored, or failed
  → 200 for success/ignored, 4xx for permanent rejection, 500 for retryable failure
```

Safety properties:

- Duplicate deliveries return success without repeating side effects.
- A stale event is rejected by source-timestamp ordering.
- A processing event is not reclaimed until the lease expires.
- Failed events are retried up to `WEBHOOK_MAX_ATTEMPTS`.
- Malformed signed payloads are terminally rejected.
- User, organization, and membership deletions leave tombstones so stale
  create/update events cannot recreate deleted state. Membership tombstones
  allow a genuinely newer re-invite to win.
- Logs contain event IDs and codes, not payloads, signatures, or secrets.

---

## 6. Current data model

```text
public.users
├── id                 text primary key (Clerk user ID)
├── email              text
├── first_name         text
├── last_name          text
├── username           text
├── image_url          text
├── source_updated_at  timestamptz
├── deleted_at         timestamptz
├── created_at         timestamptz not null
└── updated_at         timestamptz not null

public.organizations
├── id                 text primary key (Clerk organization ID)
├── name               text not null
├── slug               text
├── image_url          text
├── created_by         text → users(id) on delete set null
├── source_updated_at  timestamptz
├── deleted_at         timestamptz
├── created_at         timestamptz not null
└── updated_at         timestamptz not null

public.organization_members
├── organization_id    text → organizations(id) on delete cascade
├── user_id            text → users(id) on delete cascade
├── role               text check (admin | member)
├── source_updated_at  timestamptz
├── deleted_at         timestamptz
├── created_at         timestamptz not null
├── updated_at         timestamptz not null
└── primary key (organization_id, user_id)

public.webhook_events
├── id                 text primary key (Svix event ID)
├── type               text
├── event_created_at   timestamptz
├── status             processing | processed | failed | ignored
├── attempts           integer
├── last_error         text (code only)
├── received_at        timestamptz
└── processed_at       timestamptz

public.deleted_user_tombstones
├── id                 text primary key
├── deleted_at         timestamptz
└── source_updated_at  timestamptz

public.deleted_organization_tombstones
├── id                 text primary key
├── deleted_at         timestamptz
└── source_updated_at  timestamptz

public.deleted_organization_membership_tombstones
├── organization_id    text
├── user_id            text
├── deleted_at         timestamptz
├── source_updated_at  timestamptz
└── primary key (organization_id, user_id)
```

RLS:

- Enabled on all seven tables.
- `users`: authenticated users may select only their own active row.
- `organizations`: authenticated users may select only organizations where they have an active membership.
- `organization_members`: authenticated users may select their own membership or memberships in an organization they belong to.
- `webhook_events` and all three tombstone tables: no anon/authenticated policies.
- No anon or authenticated write policies exist. Writes go through the backend service role after explicit checks.
- The previous `USING (true)` policies were dropped by the migration.

---

## 7. Trust boundaries

| Boundary | Current state | Assessment |
|---|---|---|
| Browser → Clerk | Clerk SDK session; publishable key | Correct for a public client |
| Browser → Backend | Bearer Clerk session token for account deletion | Verified by `clerkMiddleware` and `requireAuth` |
| Browser → Supabase | No browser client | Removed; no direct-database path |
| Clerk → Backend webhook | Svix signature verification | Correct; ledger, ordering, and retries added |
| Backend → Supabase | Service-role key | Server-only; explicit authorization before privileged queries |
| Frontend UI gate | Client-side `isSignedIn` | Convenience only; not a security boundary |
| Backend user routes | Session-verified self routes | Authorized from verified identity, not request data |
| Backend organization routes | Active-org context + membership/admin checks | Both Clerk context and database membership are required |

---

## 8. Build and run

### Frontend

```bash
cd Frontend
npm install
npm run dev
npm run lint
npm run build
npm run check:secrets
```

Current status:

- `npm run lint` passes (re-verified 2026-11-13).
- `npm run build` passes with the existing chunk-size warning (production build regenerated 2026-11-13).
- `npm run check:secrets` passes, including after a production build.
- No frontend automated tests; browser acceptance has not been run.

### Backend

```bash
cd Backend
npm install
npm test
npm run dev
# or
npm start
```

Current status:

- `npm test` passes 52 tests (2026-11-13), covering validation, GitHub URL handling, repository API authorization, webhook rejection (missing headers, bad signature, tampered payload, no ledger write), schema/RLS policy assertions, and file-manifest generation.
- Backend syntax checks pass.
- Ephemeral-server checks pass for health, unauthenticated `/api/me`, disallowed origin, missing webhook headers, invalid webhook signature, and the unauthenticated repository verify routes; manifest authorization is covered at controller level.
- The Supabase migration and live Clerk webhook delivery have not been exercised.

### Environment

Variable names are documented in `Backend/.env.example` and `Frontend/.env.example`. Values are not recorded. `Frontend/.env` no longer contains `CLERK_SECRET_KEY`; the previously exposed key still needs rotation in Clerk.

---

## 9. Owner actions still required

1. Rotate the Clerk secret key that was previously stored in `Frontend/.env`.
2. Apply `Backend/migrations/001_phase02_security.sql` to staging, then production.
3. Configure the Clerk webhook endpoint and event subscriptions.
4. Set `FRONTEND_ORIGIN` to the exact production frontend origin.
5. Configure Clerk as a Supabase third-party auth provider if direct user-scoped reads are added later.
6. Run browser acceptance for password-section hiding, account deletion, and signed-out state.
7. Run live organization and cross-tenant checks with two real Clerk users.

---

## 10. Architectural constraints to preserve

- The stack stays Vite + React 19 + JSX on the frontend and Node.js + Express 5 + JavaScript on the backend. No Next.js or TypeScript migration.
- The parser must be standalone and adapter-based when it is built. It does not exist yet.
- Graph calculations must remain pure functions over files and edges.
- Every box and edge must come from parsed evidence. AI may explain, never invent structure.
- Organization visibility must be enforced by database policy and server-side membership checks, not only by UI filtering.
- RLS stays on by default.
- The product is not a code reviewer; no scores, grades, or severity badges.
- Nothing moves on its own; derivable answers are instant and do not use spinners.
- The shell layout is permanent; later phases add to panels rather than rearranging them.
