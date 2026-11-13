# Phase 02 — Authentication, Authorization, Organizations, and Data Security

**Status:** IMPLEMENTED IN CODE — database migration and live dashboard checks remain owner actions.
**Date:** 2026-11-12
**Depends on:** approval of `Docs/audits/implementation-audit.md`.
**Baseline:** the audited Phase 01 shell plus the existing Clerk/Supabase/Express scaffold.
**Remediation record:** `Docs/audits/security-remediation.md`.

This document is a specification for review. It does not authorize database migrations, Clerk dashboard changes, Supabase policy changes, or application-code changes. No Phase 02 implementation has started.

---

## 1. Goals and non-goals

### 1.1 Goals

1. Establish **who is making every request** using a verified Clerk session, not a client-supplied user ID.
2. Establish **whether that user may access the requested resource** using server-side ownership, membership, and role checks.
3. Introduce **organizations** as the tenancy boundary for all future repository and analysis data.
4. Make **RLS the default** for database access, with policies that are restrictive rather than permissive.
5. Restrict the **Supabase service-role key** to server-only, explicitly authorized operations.
6. Make **Clerk webhook processing** verifiable, idempotent, order-safe, and auditable for user and organization events.
7. Correct **environment and secret placement**, especially the Clerk secret currently present in `Frontend/.env`.
8. Add an **automated test baseline** for authentication, authorization, cross-user access, cross-organization access, webhook handling, and RLS.
9. Leave the Phase 01 shell, the JavaScript/JSX stack, and the visual design intact.
10. Produce an objectively checkable definition of done.

### 1.2 Non-goals

- GitHub repository discovery or fetching.
- Source-file parsing, language adapters, import resolution, coverage reporting, or live parsing progress.
- Real repository data, real dependency graphs, blast radius, dependency chains, AI explanations, repository chat, or file labelling.
- Private repositories or GitHub token storage.
- Billing, plans, seat limits, or usage metering.
- Custom organization roles beyond the default Clerk `org:admin` and `org:member`.
- A redesign of the Phase 01 shell.
- Migration to Next.js, TypeScript, or another stack.
- Installing packages without separate approval.
- Running migrations or changing Clerk/Supabase settings as part of this planning task.
- Production deployment.

### 1.3 Design principles

- **Authentication** answers *who is calling*.
- **Authorization** answers *what that caller may touch*.
- Never trust `userId`, `orgId`, ownership, or role claims supplied by the browser without verifying them against the authenticated identity and the database.
- A service-role key bypasses RLS. If the backend uses it, the backend must perform explicit authorization before every privileged read or write.
- Organization membership and role checks are enforced server-side.
- Webhooks may be retried or arrive out of order. Processing must be idempotent and ordering-aware.
- Clerk secrets and Supabase service-role keys never appear in frontend-exposed variables or client bundles.
- Webhook signature verification is separate from user-session authentication.
- Prefer the smallest design that is correct. Avoid new abstractions and packages unless they remove a demonstrated risk.

---

## 2. Verified current-state assumptions

These assumptions come from the audit. If any is false in the live environment, stop and re-audit before implementing.

| Assumption | Status | Evidence |
|---|---|---|
| Frontend is Vite + React 19 + JSX + Tailwind v3 | Verified | `Frontend/package.json`, `vite.config.js`, `postcss.config.js` |
| Clerk is already used for frontend sign-in | Verified | `Frontend/src/main.jsx`, `App.jsx`, `TopBar.jsx` |
| Backend is Express 5 + CommonJS JavaScript | Verified | `Backend/package.json`, `Backend/app.js` |
| Backend has no Clerk session middleware | Verified | `Backend/app.js` contains no `clerkMiddleware`/`requireAuth` |
| User routes are unauthenticated | Verified | `Backend/routes/userRoutes.js` lines 11–15 |
| Backend uses the Supabase service-role key | Verified | `Backend/config/DbConnect.js` line 5 |
| RLS is enabled on `public.users` | Verified | `Backend/schema.sql` line 13 |
| `anon` and `authenticated` can read every user row | Verified | `Backend/schema.sql` lines 23–28 |
| No organization tables or code exist | Verified | `Backend/schema.sql`; no org symbols in backend source |
| Clerk webhook signature verification is implemented | Verified | `Backend/controllers/webhookController.js` lines 12–38 |
| Webhook processing is not idempotent or order-aware | Verified | `Backend/controllers/webhookController.js` lines 40–107 |
| Clerk secret key is present in `Frontend/.env` | Verified by variable name only | `Frontend/.env`; value not recorded |
| No automated tests exist | Verified | no test files; `Backend/package.json` placeholder |
| No Git history exists | Verified | `git status` reports not a repository |
| Clerk Organizations are enabled | **Needs manual verification** | Cannot be confirmed without the Clerk dashboard |
| Supabase third-party auth for Clerk is configured | **Needs manual verification** | Cannot be confirmed without the Supabase dashboard |
| Live webhook subscriptions include organization events | **Needs manual verification** | Cannot be confirmed without the Clerk dashboard |

The implementation must not assume the last three items are true. They are prerequisites listed in section 16.

---

## 3. User identity and Clerk session authentication flow

### 3.1 Frontend

1. Keep `ClerkProvider` in `Frontend/src/main.jsx`.
2. Keep the existing sign-in, sign-up, sign-out, and user-button UI.
3. When calling the backend, obtain a Clerk session token with `getToken()` and send it as `Authorization: Bearer <token>`.
4. Do not send a `userId` in the body or query string as identity.
5. Do not store the token in `localStorage`, `sessionStorage`, or a URL. Keep it in memory and let Clerk refresh it.
6. For organization-aware calls, ensure the desired organization is the **active organization** in the Clerk session before calling an org-scoped route. Use Clerk's organization switcher or `useOrganization`/`setActive` if the UI scope includes it.
7. If the session is missing or expired, redirect to sign-in or let Clerk refresh the token; do not retry with a stale token.
8. The existing `isSignedIn` gate remains a UI convenience, not a security control.

### 3.2 Backend

1. Register `clerkMiddleware()` once, before protected routes.
2. Protected routes use a `requireAuth` middleware that:
   - rejects requests without a valid Clerk session with `401 UNAUTHENTICATED`;
   - attaches the verified user ID to the request context;
   - never reads identity from `req.body`, `req.query`, or route parameters.
3. The backend may read `req.auth().userId`, `req.auth().orgId`, `req.auth().orgRole`, and `req.auth().orgSlug`.
4. Organization claims are **hints**. The database membership row is authoritative. A token claim that is stale, missing, or inconsistent with the route must not grant access.
5. The backend must reject a request whose active organization (`orgId` claim) does not match the `:orgId` route parameter for org-scoped routes. The client switches active organization first.
6. No user-facing route may fall back to an unauthenticated path or a development bypass.
7. Webhook routes do **not** use session authentication. They use Svix signature verification only.

### 3.3 Token content

The Clerk session token must expose at least:

- `sub` — Clerk user ID, used as `public.users.id`.
- `org_id` — active organization ID, when an organization is active.
- `org_role` — active organization role, when an organization is active.
- `org_slug` — optional, used for display only.

If Supabase third-party auth is used, Supabase must receive the same Clerk token and read `sub` from `auth.jwt()`. The exact Clerk JWT template and Supabase provider configuration require owner approval and dashboard access.

### 3.4 Request flow

```text
Browser
  → Clerk session
  → getToken()
  → Authorization: Bearer <Clerk token>
  → Express clerkMiddleware()
  → requireAuth
  → route authorization helpers
  → Supabase client
      ├── user-scoped client (Clerk token) → RLS enforces
      └── admin client (service role) → explicit checks already performed
  → response
```

---

## 4. Protected backend route policy

### 4.1 Public routes

Only these routes are public:

| Method | Path | Protection |
|---|---|---|
| GET | `/api/health` | None; returns no sensitive data |
| POST | `/api/webhooks/clerk` | Svix signature verification; no user session |

### 4.2 Authenticated routes

| Method | Path | Authorization |
|---|---|---|
| GET | `/api/me` | Self only |
| PATCH | `/api/me` | Self only, whitelisted fields |
| GET | `/api/organizations` | Self; returns the caller's active memberships |
| GET | `/api/organizations/:orgId` | Active org + membership |
| GET | `/api/organizations/:orgId/members` | Active org + membership; response shaped by role |
| POST | `/api/organizations` | Authenticated; creator becomes admin via Clerk |
| POST | `/api/organizations/:orgId/invitations` | Active org + admin |
| PATCH | `/api/organizations/:orgId/members/:userId` | Active org + admin; last-admin protection |
| DELETE | `/api/organizations/:orgId/members/:userId` | Active org + admin, or self-leave; last-admin protection |
| DELETE | `/api/organizations/:orgId` | Active org + admin; optional in Phase 02 |

### 4.3 Removed or deprecated routes

| Current route | Phase 02 decision | Reason |
|---|---|---|
| `POST /SignUp` | Remove | Clerk owns sign-up; the frontend never calls it |
| `POST /SignIn` | Remove | Clerk owns sign-in; the frontend never calls it |
| `GET /users/:id` | Remove | Replaced by `GET /api/me`; arbitrary-ID reads are not needed |
| `PATCH /users/:id` | Remove | Replaced by `PATCH /api/me`; identity must not come from the path |
| `DELETE /users/:id` | Remove | Account deletion must go through a deliberate flow, not an unauthenticated route |

If a compatibility window is required, return `410 Gone` with a safe error body for one release, then remove the routes. No compatibility window is needed today because the frontend does not call them.

### 4.4 Route declaration order

1. Webhook route with `express.raw()`.
2. `express.json()` for all other routes.
3. Health route.
4. Clerk middleware.
5. Protected routes.
6. 404 handler.
7. Error handler.

The webhook route must be mounted **before** the global JSON parser. Do not use a string comparison on `req.originalUrl` as the raw-body switch.

---

## 5. User ownership and authorization rules

### 5.1 Identity rules

- The only trusted user identity is the Clerk `sub` from a verified session.
- `GET /api/me`, `PATCH /api/me`, and self-leave use that identity directly.
- No route accepts `userId` from the request body as the acting identity.
- A route may accept a `:userId` path parameter only for an administrative action on another user; the actor's identity still comes from the session.

### 5.2 Ownership rules

- A user may read their own `public.users` row. Profile edits are owned by Clerk; if `PATCH /api/me` is included, it must write to Clerk first and then mirror the result. It must not make Supabase the source of truth.
- A user may list organizations only where they have an active membership.
- A user may read an organization and its member list only when they have an active membership in that organization.
- A user may read another member's profile fields only through the organization member-list contract, and only while they are a member of the same organization.
- Email addresses are visible to the user themselves and to organization admins. Regular members see display fields only. This is a response-shaping rule, not an RLS row rule, because RLS cannot hide columns.

### 5.3 Role rules

- `admin` may invite, change roles, and remove members.
- `member` may read organization data and leave the organization.
- The last active admin cannot be demoted or removed. Attempting it returns `409 LAST_ADMIN`.
- A user may leave an organization if they are not the last active admin.
- An admin may remove themselves only if another admin remains.
- Organization creation makes the creator an admin through Clerk.

### 5.4 Privileged operation rules

Before any service-role read or write, the handler must complete the relevant check:

- **Self operation:** `assertSelf(req, targetUserId)`.
- **Membership operation:** `assertActiveOrg(req, orgId)` then `assertOrgMember(userId, orgId)`.
- **Admin operation:** the above, then `assertOrgAdmin(userId, orgId)`.
- **Last-admin operation:** the above, then `assertNotLastAdmin(orgId, targetUserId)`.

A failure must stop the operation before the privileged query. Logging a failed check is not a substitute for returning the correct status.

### 5.5 Status-code policy

| Situation | Status | Code |
|---|---|---|
| Missing or invalid session | 401 | `UNAUTHENTICATED` |
| Authenticated but no active organization on an org-scoped route | 403 | `NO_ACTIVE_ORGANIZATION` |
| Active organization does not match the route | 403 | `ORG_CONTEXT_MISMATCH` |
| Known organization, requester is not a member | 404 | `NOT_FOUND` |
| Insufficient role | 403 | `FORBIDDEN` |
| Invalid input | 400 | `VALIDATION_ERROR` |
| Duplicate membership/invitation or last admin | 409 | `CONFLICT` or `LAST_ADMIN` |
| Unknown resource | 404 | `NOT_FOUND` |
| Clerk API unavailable or rejected the request | 502 | `CLERK_UNAVAILABLE` |
| Unhandled server error | 500 | `INTERNAL` |

Cross-organization requests return **404**, not 403, to avoid confirming that an organization exists. This is a deliberate existence-leak reduction. The rule must be applied consistently and documented in the route tests.

---

## 6. Organizations: creation, membership, roles, and context

### 6.1 Source of truth

Clerk is the source of truth for:

- organization existence
- organization name and slug
- membership
- roles
- invitations
- active organization in the session

Supabase mirrors the minimum needed for authorization and joins. The mirror is updated by webhooks and by explicit backend operations that have already succeeded in Clerk.

### 6.2 Default roles

Use Clerk's default roles:

- `org:admin`
- `org:member`

Normalize them in Supabase to:

- `admin`
- `member`

Custom roles are out of scope. If Clerk returns an unknown role, map it to `member` and log a warning with the organization and user IDs. Do not grant admin privileges to an unknown role.

### 6.3 Organization creation

1. Requester is authenticated.
2. Validate `name` (1–100 characters) and optional `slug` (lowercase letters, digits, hyphens; 2–64 characters).
3. Call the Clerk Backend API to create the organization, with the requester as creator.
4. Clerk makes the creator an admin.
5. Mirror the organization and creator membership in Supabase using the service-role client, after verifying the Clerk call succeeded and the creator is the authenticated user.
6. Return the organization and the caller's role.
7. The frontend may switch the active organization to the new organization. If it does not, the user can switch manually.

If the Supabase mirror write fails after Clerk succeeds, return a success response only if the webhook will converge the mirror; otherwise return `502` with a message that the organization was created but the local mirror is pending. The webhook must be able to repair the mirror.

### 6.4 Invitations

1. Requester is authenticated and is an active admin of the organization.
2. Validate the email address and role (`member` by default, `admin` allowed).
3. Call Clerk's `createOrganizationInvitation`.
4. Do not insert a Supabase invitation row in Phase 02; Clerk remains the source of truth.
5. On acceptance, Clerk sends `organizationMembership.created`; the webhook mirrors the membership.
6. Return the invitation status from Clerk.
7. Duplicate invitations return `409 CONFLICT` or Clerk's duplicate response, mapped safely.

### 6.5 Role changes

1. Requester is an active admin.
2. Target is an active member of the same organization.
3. If demoting an admin, verify another active admin remains.
4. Call Clerk's `updateOrganizationMembership`.
5. Update the Supabase mirror after Clerk confirms, or let the webhook converge it.
6. Return the updated role.

### 6.6 Member removal

1. Requester is an active admin, or the requester is removing themselves.
2. Target is an active member.
3. If removing an admin, verify another active admin remains.
4. Call Clerk's `deleteOrganizationMembership`.
5. Mark the Supabase membership inactive (soft delete) after Clerk confirms, or let the webhook converge it.
6. Return `204`.

### 6.7 Organization deletion

Optional in Phase 02, but if included:

1. Requester is an active admin.
2. Require an explicit confirmation value in the body (for example, the exact organization name).
3. Call Clerk's `deleteOrganization`.
4. Soft-delete the Supabase organization and deactivate its memberships.
5. Return `204`.

Organization deletion is listed as an unresolved decision because it is destructive and not required for the core security goal.

### 6.8 Organization context

- The active organization comes from the Clerk session (`org_id`).
- `GET /api/organizations` lists all active memberships for the user, regardless of the active organization.
- Org-scoped routes require `session.orgId === :orgId` and an active membership row.
- A user who wants to access a different organization must switch the active organization in Clerk first.
- The backend never trusts an `orgId` supplied only by the browser. The route parameter is checked against both the session claim and the database membership.
- A missing active organization on an org-scoped route returns `403 NO_ACTIVE_ORGANIZATION`; it does not silently choose one.

---

## 7. Proposed Supabase schema and relationships

All IDs are `text` because Clerk IDs are strings (`user_...`, `org_...`). Do not introduce UUIDs that require an extra mapping layer.

### 7.1 `public.users` (evolve the existing table)

| Column | Type | Constraints / notes |
|---|---|---|
| `id` | `text` | Primary key; Clerk user ID |
| `email` | `text` | Nullable; normalized lowercase on write |
| `first_name` | `text` | Nullable |
| `last_name` | `text` | Nullable |
| `username` | `text` | Nullable |
| `image_url` | `text` | Nullable; Clerk profile image |
| `source_updated_at` | `timestamptz` | Clerk event timestamp used for ordering |
| `deleted_at` | `timestamptz` | Nullable soft-delete tombstone |
| `created_at` | `timestamptz` | Not null; default now() |
| `updated_at` | `timestamptz` | Not null; default now(); maintained by trigger |

Constraints and indexes:

- Case-insensitive unique index on `lower(email)` where `email IS NOT NULL AND deleted_at IS NULL`.
- Partial index on active rows (`WHERE deleted_at IS NULL`) for list queries.
- `updated_at` trigger.
- No client-supplied `id` or email writes.

### 7.2 `public.organizations`

| Column | Type | Constraints / notes |
|---|---|---|
| `id` | `text` | Primary key; Clerk organization ID |
| `name` | `text` | Not null; 1–100 characters |
| `slug` | `text` | Nullable; lowercase slug |
| `image_url` | `text` | Nullable |
| `created_by` | `text` | References `users(id)` on delete set null |
| `source_updated_at` | `timestamptz` | Clerk event timestamp |
| `deleted_at` | `timestamptz` | Nullable soft-delete tombstone |
| `created_at` | `timestamptz` | Not null; default now() |
| `updated_at` | `timestamptz` | Not null; default now(); trigger |

Constraints and indexes:

- Case-insensitive unique index on `lower(slug)` where `slug IS NOT NULL AND deleted_at IS NULL`.
- Partial index on active rows.
- `updated_at` trigger.

### 7.3 `public.organization_members`

| Column | Type | Constraints / notes |
|---|---|---|
| `organization_id` | `text` | Not null; references `organizations(id)` on delete cascade |
| `user_id` | `text` | Not null; references `users(id)` on delete cascade |
| `role` | `text` | Not null; check in (`admin`, `member`) |
| `source_updated_at` | `timestamptz` | Clerk event timestamp |
| `deleted_at` | `timestamptz` | Nullable soft-delete; supports re-invite and stale-event safety |
| `created_at` | `timestamptz` | Not null; default now() |
| `updated_at` | `timestamptz` | Not null; default now(); trigger |

Constraints and indexes:

- Primary key `(organization_id, user_id)`.
- Partial index on `user_id` where `deleted_at IS NULL`.
- Partial index on `organization_id` where `deleted_at IS NULL`.
- Index used by last-admin checks on `(organization_id, role)` where active.
- A membership row is reactivated by a newer create/update event; it is not duplicated.

### 7.4 `public.webhook_events`

| Column | Type | Constraints / notes |
|---|---|---|
| `id` | `text` | Primary key; Svix `svix-id` |
| `type` | `text` | Not null; Clerk event type |
| `event_created_at` | `timestamptz` | Not null; event timestamp |
| `status` | `text` | Not null; check in (`processing`, `processed`, `failed`, `ignored`) |
| `attempts` | `integer` | Not null; default 1 |
| `last_error` | `text` | Nullable; safe summary, no secrets or full payload |
| `received_at` | `timestamptz` | Not null; default now() |
| `processed_at` | `timestamptz` | Nullable |

Constraints and indexes:

- Primary key on `id` provides idempotency.
- Index on `(status, received_at)` for operations and cleanup.
- Do not store the full webhook payload; it can contain personal data.

### 7.5 Relationships

```text
users 1 ──── N organization_members N ──── 1 organizations
                    │
                    └── role: admin | member

organizations.created_by ──── 1 users

webhook_events  (independent ledger, service-role only)
```

### 7.6 Not included in Phase 02

- `repositories`
- `analyses`
- `analysis_files`
- `analysis_edges`
- `ai_explanations`
- `chat_messages`
- invitation mirror tables

These are intentionally deferred. When they are introduced, every organization-owned table must have `organization_id text not null` and an RLS policy from day one. Do not create them in Phase 02.

---

## 8. RLS policy requirements

### 8.1 Default posture

- RLS is enabled on **every** table, including new tables, from the migration that creates them.
- A table with no policy returns nothing to `anon` and `authenticated`.
- Do not create `USING (true)` policies for `anon` or `authenticated`.
- The service role bypasses RLS; that does not make policies optional.
- Revoke direct table privileges from `anon` where they are not needed, as defense in depth.
- Add a verification query or CI check that fails if any table in `public` has `relrowsecurity = false`.

### 8.2 Clerk identity in Supabase

Policies use the Clerk user ID from the verified JWT:

```text
current_clerk_user_id() = nullif(auth.jwt() ->> 'sub', '')
```

This requires Supabase third-party auth for Clerk, or an equivalent verified JWT bridge. If that configuration is absent, `auth.jwt()` will not contain the Clerk `sub` and the policies will deny access. That is the safe failure mode, but it means the backend cannot use a user-scoped Supabase client until the integration is configured.

### 8.3 Helper functions

Create two `security definer`, `stable` helper functions with a fixed `search_path`:

- `is_org_member(target_org_id text)` — true when the current Clerk user has an active membership in the organization.
- `is_org_admin(target_org_id text)` — true when the current Clerk user has an active membership with role `admin`.

Rules:

- Use no dynamic SQL.
- Revoke execute from `public`; grant execute to `authenticated`.
- Filter `deleted_at IS NULL`.
- Keep them small and indexed.
- Do not use these helpers as the only server-side check; the backend still checks membership and role explicitly before privileged operations.

### 8.4 Policy matrix

| Table | Role | Operation | Policy rule |
|---|---|---|---|
| `users` | `authenticated` | SELECT | `id = current_clerk_user_id() AND deleted_at IS NULL` |
| `users` | `authenticated` | UPDATE | Self only, and only whitelisted profile columns; recommended: no direct client updates |
| `users` | `anon`, `authenticated` | INSERT | No policy |
| `users` | `anon`, `authenticated` | DELETE | No policy |
| `organizations` | `authenticated` | SELECT | `is_org_member(id) AND deleted_at IS NULL` |
| `organizations` | `anon`, `authenticated` | INSERT/UPDATE/DELETE | No policy; backend and Clerk own writes |
| `organization_members` | `authenticated` | SELECT | `(user_id = current_clerk_user_id() OR is_org_member(organization_id)) AND deleted_at IS NULL` |
| `organization_members` | `anon`, `authenticated` | INSERT/UPDATE/DELETE | No policy; backend and Clerk own writes |
| `webhook_events` | `anon`, `authenticated` | ALL | No policy; revoke table privileges; service role only |
| Future org-owned tables | `authenticated` | SELECT | `is_org_member(organization_id)` and active-row filter |
| Future org-owned tables | `authenticated` | INSERT/UPDATE/DELETE | Admin check or no client policy; prefer backend-only writes |

### 8.5 Policy verification

Run these checks against a staging project, not production:

1. With the anon key: `select * from users` returns 0 rows.
2. With the anon key: `select * from organizations` returns 0 rows.
3. With user A's Clerk JWT: `select * from users` returns only user A.
4. With user A's Clerk JWT: `select * from organizations` returns only organizations where A is an active member.
5. With user A's Clerk JWT: `select * from organization_members` returns A's rows plus members of A's organizations.
6. With user A's Clerk JWT: querying organization B's rows returns 0 rows.
7. With a token missing `sub`: all policy-protected queries return 0 rows.
8. Confirm every `public` table has RLS enabled.

These are security tests, not optional smoke tests.

---

## 9. Safe use of the Supabase service-role key

### 9.1 Required separation

Create two clearly named clients:

- **`supabaseAdmin`** — service-role key. Server-only. Used for webhooks, backfill, and explicitly authorized administrative writes.
- **`supabaseForUser(token)`** — anon key plus the caller's Clerk token. Used for normal user-scoped reads and self-updates so RLS applies.

The current single shared client in `Backend/config/DbConnect.js` is replaced by this separation. The anon-key fallback for the admin client is removed; missing service-role configuration must fail fast.

### 9.2 Mandatory server-side checks

Every privileged path must perform the checks in section 5.4 **before** touching `supabaseAdmin`. The service-role key is not permission to skip authorization; it is a capability that makes authorization checks more important.

Examples:

- `GET /api/organizations/:orgId/members` may use `supabaseAdmin` to join `organization_members` and `users` after `assertOrgMember`. It must shape the response so email addresses are visible only to admins.
- `POST /api/organizations` may use `supabaseAdmin` to mirror a Clerk-created organization after verifying the creator is the authenticated user.
- `PATCH /api/organizations/:orgId/members/:userId` may use `supabaseAdmin` after `assertOrgAdmin` and last-admin validation.
- Webhook handlers may use `supabaseAdmin` because the signature is the authentication boundary.

### 9.3 Rules

1. The service-role key never leaves the backend.
2. Never expose it through a `VITE_` variable, a client bundle, a log, or an error response.
3. Do not silently fall back to the anon key when the service-role key is missing.
4. Prefer the user-scoped client for normal reads.
5. Keep service-role imports limited to webhook/sync/admin modules; do not import the admin client into general controllers.
6. Comment each service-role use with the authorization check that precedes it.
7. Log the actor user ID, organization ID, and action — never the token or key.
8. If the key is exposed, rotate it with owner approval and redeploy before considering the incident closed.
9. Add a test that imports the frontend bundle and fails on secret markers.

### 9.4 Why moving the key is not enough

Moving the service-role key out of the frontend fixes exposure. It does **not** fix authorization. The backend must still:

- verify the Clerk session;
- derive the actor identity from the session;
- verify ownership or organization membership;
- verify the role for administrative actions;
- validate input and whitelist fields.

The current unauthenticated routes demonstrate why a secret location alone is not an authorization strategy.

---

## 10. Clerk webhook verification, event handling, idempotency, and failure behavior

### 10.1 Verification

1. Register the webhook route before the global JSON parser.
2. Use `express.raw({ type: 'application/json', limit: '1mb' })`.
3. Require `svix-id`, `svix-timestamp`, and `svix-signature`.
4. Verify the raw body with `CLERK_WEBHOOK_SECRET` using Svix or Clerk's official verification helper.
5. Parse JSON only after verification succeeds.
6. Reject missing headers or invalid signatures with `400` and no database write.
7. Never log the full payload, signature, or secret. Log the Svix ID and event type.

### 10.2 Event allowlist

Subscribe to and handle:

- `user.created`
- `user.updated`
- `user.deleted`
- `organization.created`
- `organization.updated`
- `organization.deleted`
- `organizationMembership.created`
- `organizationMembership.updated`
- `organizationMembership.deleted`

Remove `session.created` from the subscription unless it is needed for analytics. If it arrives, record it as ignored and return `200`.

Unknown event types return `200` after recording an `ignored` ledger row. This prevents Clerk from retrying an event the application will never handle.

### 10.3 Payload validation

For every handled event:

- require a non-empty `type`;
- require `data.id` (or the documented organization membership identifiers);
- validate that the payload shape matches the event family;
- ignore unknown fields rather than passing them to the database;
- never use the payload to choose an arbitrary user or organization ID that is not part of the event's documented subject;
- treat malformed or contradictory payloads as `400` and record a safe failure reason.

### 10.4 Idempotency

Use `public.webhook_events` as the delivery ledger keyed by `svix-id`.

Processing algorithm:

1. Verify the signature and parse the event.
2. Validate the type and required identifiers.
3. Atomically claim the event:
   - Insert a row with status `processing` and attempts `1`.
   - On primary-key conflict, read the existing row.
   - If status is `processed` or `ignored`, return `200` without repeating side effects.
   - If status is `processing`, return `200`; a concurrent duplicate should not double-apply. All writes must be idempotent anyway. If the `processing` row is older than a documented stale threshold (for example, five minutes), reclaim it and retry so a crashed worker cannot block delivery forever.
   - If status is `failed` and attempts are below the retry limit, atomically increment attempts and set `processing`, then continue.
   - If the retry limit is exceeded, return `500` only if the failure is transient; otherwise return `200` with a recorded terminal failure to stop retries.
4. Apply the side effect idempotently.
5. Mark the ledger row `processed` with `processed_at`.
6. On a transient database/network error, mark `failed` with a safe `last_error` and return `500` so Clerk retries.
7. On a permanent validation error, mark `failed` or `ignored` and return `400` for malformed input or `200` for an unsupported event.

The ledger write and the side effect are separate database operations unless an RPC/transaction is used. The implementation must be safe if the process crashes between them: replaying an already-applied event must not duplicate or corrupt data. Idempotent upserts and conditional updates provide that safety.

### 10.5 Ordering and stale events

Clerk may retry or deliver out of order. Use event timestamps, not arrival order.

- Store `source_updated_at` from the event's `data.updated_at` (or the event `created_at` when the resource has no update timestamp).
- Apply an update only when the incoming timestamp is greater than or equal to the stored `source_updated_at`; ignore older updates.
- For `user.deleted`, set `deleted_at` to the event timestamp and deactivate the user's organization memberships. Keep the `users` row as a tombstone so foreign keys and stale-event detection remain possible.
- Ignore a later `user.updated` whose `source_updated_at` is older than or equal to `deleted_at`.
- For `organization.deleted`, soft-delete the organization and deactivate memberships.
- For `organizationMembership.deleted`, soft-delete the membership row only when the event timestamp is not older than the stored `source_updated_at`.
- For a re-invite, a newer `organizationMembership.created`/`updated` reactivates the same row (`deleted_at = null`, new role) rather than creating a duplicate.
- Prefer a small Postgres function for the conditional compare-and-apply if the Supabase client cannot express it atomically. Do not implement ordering with client-side read-then-write without a lock.

### 10.6 Failure behavior summary

| Failure | Status | Side effect |
|---|---|---|
| Missing webhook secret | 500 | None; log configuration error without the secret |
| Missing Svix headers | 400 | None |
| Invalid signature | 400 | None |
| Malformed JSON after a valid signature | 400 | Record a safe failed ledger row |
| Unsupported event type | 200 | Record `ignored` |
| Missing required IDs | 400 | Record a safe failed ledger row |
| Transient database error | 500 | Record `failed`; Clerk retries |
| Permanent validation error | 400 or 200 | Record terminal failure; no partial write |
| Duplicate processed event | 200 | No repeated side effect |
| Stale update | 200 | No change; record as processed |

### 10.7 Webhook security

- The webhook route is public; the signature is the authentication.
- Do not accept a session token as a substitute for the signature.
- Do not accept the webhook secret from a request.
- Rate-limit the endpoint at the edge if the deployment supports it.
- Keep the webhook secret only in the backend environment.
- Rotate the secret if it is exposed; coordinate the Clerk dashboard update and the backend redeploy.

---

## 11. Environment variables and secret handling

### 11.1 Frontend

| Variable | Exposure | Required | Purpose |
|---|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Public | Yes | Clerk React provider |
| `VITE_SUPABASE_URL` | Public | Only if the browser queries Supabase directly | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Public | Only if the browser queries Supabase directly | RLS-protected anon access |

Frontend rules:

- Never add a `VITE_` variable containing a Clerk secret, Supabase service-role key, webhook secret, or ngrok token.
- Remove `CLERK_SECRET_KEY` from `Frontend/.env`. It is not used by frontend code and must not be present.
- If the browser does not query Supabase directly, remove the unused Supabase client and its variables rather than keeping a dormant path.
- `Frontend/.env.example` must include `VITE_CLERK_PUBLISHABLE_KEY` and must contain placeholders only.

### 11.2 Backend

| Variable | Exposure | Required | Purpose |
|---|---|---|---|
| `PORT` | Non-secret | Yes | HTTP listener |
| `NODE_ENV` | Non-secret | Yes | Environment behavior |
| `FRONTEND_ORIGIN` | Non-secret | Yes in production | CORS allowlist |
| `SUPABASE_URL` | Non-secret | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Public but server-side here | Yes if the user-scoped client is used | RLS-protected user-scoped client |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | Yes for webhooks/sync/admin operations | Privileged client; explicit checks required |
| `CLERK_SECRET_KEY` | **Secret** | Yes | Clerk Backend API and session verification |
| `CLERK_PUBLISHABLE_KEY` | Public | Optional | Only if a backend helper needs it |
| `CLERK_WEBHOOK_SECRET` | **Secret** | Yes | Svix verification |
| `NGROK_AUTHTOKEN` | **Secret** | Development only | Local webhook tunnel |

Backend rules:

- `.env` stays gitignored in both `Frontend/` and `Backend/`.
- Add a root `.gitignore` that covers both subprojects and common secret files.
- `.env.example` contains placeholders only, never real values.
- Do not log environment values, tokens, cookies, signatures, or full request bodies.
- Fail startup when required secrets for the selected mode are missing. Do not start with placeholder credentials and pretend the service is healthy.
- Restrict CORS to `FRONTEND_ORIGIN`. Do not use `*` in production.
- If the service-role key or Clerk secret was ever exposed, rotate it with owner approval; updating the value is not enough if the old value remains valid.

### 11.3 Secret scanning

Add a repository check that fails when:

- `CLERK_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` appears under `Frontend/`;
- a `sk_`-prefixed Clerk secret appears in tracked files;
- a built frontend bundle contains service-role or Clerk secret markers;
- `.env` (without `.example`) is tracked.

The check must report the filename and variable name, never the value.

### 11.4 Supabase third-party auth configuration

If the user-scoped client is used, Supabase must be configured to accept Clerk session tokens:

- Enable Clerk as a third-party auth provider in the Supabase dashboard.
- Configure the Clerk issuer/JWKS according to Supabase's current documentation.
- Ensure the JWT contains `sub` (Clerk user ID) and, when needed, `org_id`, `org_role`, and `org_slug`.
- Use Clerk's `getToken()` for the Supabase token exchange if a template is required.
- Test with a real Clerk token before enabling policies that depend on `auth.jwt()`.

This is dashboard configuration. It requires owner approval and is not performed by this specification.

---

## 12. API route contracts and expected error responses

### 12.1 Response envelope

Success:

```json
{
  "success": true,
  "data": {}
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to perform this action."
  }
}
```

Rules:

- Never return raw database or Clerk error messages.
- Include a stable machine-readable `code`.
- Keep `message` safe for display.
- Use the correct HTTP status.
- Do not include stack traces, SQL, tokens, or internal identifiers beyond the requested resource.

### 12.2 Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid Clerk session |
| `NO_ACTIVE_ORGANIZATION` | 403 | Org-scoped request without an active organization |
| `ORG_CONTEXT_MISMATCH` | 403 | Route organization differs from the active session organization |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Unknown resource or non-member access |
| `VALIDATION_ERROR` | 400 | Invalid input |
| `CONFLICT` | 409 | Duplicate resource or state conflict |
| `LAST_ADMIN` | 409 | The action would leave the organization without an admin |
| `CLERK_UNAVAILABLE` | 502 | Clerk API failure |
| `INTERNAL` | 500 | Unhandled server error |

### 12.3 Endpoint contracts

#### `GET /api/health`

- Public.
- `200` `{ success: true, data: { status: "ok" } }`.
- No secrets, dependency details, or environment values.

#### `POST /api/webhooks/clerk`

- Public, Svix-verified.
- `200` for processed, duplicate, ignored, or stale events.
- `400` for missing headers, invalid signature, or malformed payload.
- `500` for transient processing failure so Clerk retries.
- No session token required.

#### `GET /api/me`

- Authenticated.
- Returns the caller's `public.users` row.
- If the row is missing, the backend may fetch the Clerk user for the verified `sub` and upsert it, then return it. This is a bounded webhook-race recovery path.
- `200` user; `401`; `404` if the user is deleted; `410` if tombstoned and the product chooses a distinct status.

User shape:

```json
{
  "id": "user_...",
  "email": "user@example.com",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "username": "ada",
  "imageUrl": "https://...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

#### `PATCH /api/me`

- Optional in Phase 02.
- Authenticated; self only.
- Profile data is owned by Clerk. If this route is included, it calls the Clerk Backend API first and mirrors the confirmed result; it must not update `public.users` as an independent source of truth.
- Potentially allowed fields: `firstName`, `lastName`, `username` — only if the Clerk-first flow is implemented and approved.
- Never allowed: `id`, `email`, `role`, organization membership, or timestamps.
- `200` updated user; `400 VALIDATION_ERROR`; `401`.
- Profile email changes go through Clerk, not this route.
- If the Clerk-first flow is not in scope, omit this route and leave profile editing to Clerk's hosted user profile UI.

#### `GET /api/organizations`

- Authenticated.
- Returns active organizations where the caller has an active membership.
- `200` list; `401`.

Organization shape:

```json
{
  "id": "org_...",
  "name": "Acme",
  "slug": "acme",
  "imageUrl": null,
  "role": "admin",
  "createdAt": "..."
}
```

#### `GET /api/organizations/:orgId`

- Authenticated; active org must match; caller must be an active member.
- `200` organization; `401`; `403 ORG_CONTEXT_MISMATCH`; `404` for non-member or unknown.

#### `GET /api/organizations/:orgId/members`

- Authenticated; active org must match; caller must be an active member.
- `200` list; `401`; `403`; `404`.
- Response shaping: all members see `userId`, names, username, image, role, joined date. Only admins see `email`.
- Do not expose a member's email to a regular member through this route.
- This route may use the service-role client after `assertOrgMember`, because it joins profile fields across users and shapes columns by role. That use is explicitly authorized and must be commented.

#### `POST /api/organizations`

- Authenticated.
- Body: `{ "name": "Acme", "slug": "acme" }`; slug optional.
- Validate lengths and slug format.
- Creates through Clerk; mirrors locally.
- `201` organization; `400`; `401`; `409` duplicate slug; `502` Clerk failure.

#### `POST /api/organizations/:orgId/invitations`

- Authenticated; active org + admin.
- Body: `{ "emailAddress": "person@example.com", "role": "member" }`.
- Role defaults to `member`; `admin` allowed.
- `201` invitation; `400`; `401`; `403`; `404`; `409` already invited/member; `502` Clerk failure.

#### `PATCH /api/organizations/:orgId/members/:userId`

- Authenticated; active org + admin.
- Body: `{ "role": "admin" }` or `{ "role": "member" }`.
- `200` updated membership; `400`; `401`; `403`; `404`; `409 LAST_ADMIN`; `502`.

#### `DELETE /api/organizations/:orgId/members/:userId`

- Authenticated; active org; caller is an admin or is removing themselves.
- `204`; `401`; `403`; `404`; `409 LAST_ADMIN`; `502`.

#### `DELETE /api/organizations/:orgId`

- Optional in Phase 02.
- Authenticated; active org + admin; explicit confirmation body.
- `204`; `400`; `401`; `403`; `404`; `502`.

### 12.4 Removed routes

`POST /SignUp`, `POST /SignIn`, `GET /users/:id`, `PATCH /users/:id`, and `DELETE /users/:id` return `404` or `410` after removal. The frontend must not call them. There is no client dependency today, so removal is preferred to a compatibility shim.

---

## 13. Migration and rollout strategy

### 13.1 Preconditions

Before any migration or code change:

- Project owner approves this specification.
- Clerk Organizations are enabled; confirm the plan supports the expected organization count.
- The Clerk webhook is configured and the signing secret is in the backend environment.
- The Supabase project is backed up or a restore point exists.
- A staging or disposable test project is available for RLS and webhook tests.
- The Clerk secret in `Frontend/.env` is scheduled for removal and rotation.
- The owner decides whether Supabase third-party auth for Clerk will be configured.

### 13.2 Rollout order

Use additive, reversible steps. Do not combine schema changes, auth enforcement, and route removal in one unreviewable change.

1. **Secret hygiene**
   - Remove `CLERK_SECRET_KEY` from `Frontend/.env`.
   - Add a root `.gitignore` and secret-scanning check.
   - Rotate the Clerk secret with owner approval after the backend is updated.
2. **Schema (additive)**
   - Add `organizations`, `organization_members`, and `webhook_events`.
   - Add `source_updated_at`, `deleted_at`, and `image_url` to `users`.
   - Add constraints, indexes, and the `updated_at` trigger.
   - Do not remove the existing `users` rows.
3. **RLS foundation**
   - Add helper functions.
   - Add self-only and organization-scoped policies.
   - Drop the open `anon`/`authenticated` read policy in a controlled step after the new policies are verified.
   - Keep the service-role backend working during the transition.
4. **Backend webhook upgrade**
   - Add the ledger, idempotency, ordering, and organization event handlers.
   - Verify with replayed and out-of-order test events.
5. **Backend auth**
   - Add `clerkMiddleware()` and `requireAuth`.
   - Add `/api/me` and organization routes.
   - Keep the old user routes temporarily disabled or returning `410`.
6. **Frontend integration**
   - Send the Clerk token to the backend.
   - Add organization context/switcher only if the owner approves that UI scope.
   - Remove the unused Supabase client if direct browser access is not part of the design.
7. **Remove legacy routes**
   - Delete `/SignUp`, `/SignIn`, and `/users/:id`.
   - Confirm no frontend calls remain.
8. **Verification**
   - Run the test matrix in section 14.
   - Run the manual Clerk and Supabase checks.
   - Run `npm run lint`, `npm run build`, and backend tests.
9. **Documentation**
   - Update `Docs/architecture/current-architecture.md` to describe the implemented Phase 02 state.
   - Update `Docs/specs/phase-02.md` status from proposed to implemented with evidence.

### 13.3 Backfill

- A one-time script reads users, organizations, and memberships from the Clerk Backend API and upserts them into Supabase.
- The script must be idempotent, support a dry run, and log counts only.
- Do not log emails, tokens, or full payloads.
- Run it in staging first.
- Reconcile row counts with Clerk before declaring success.
- Do not delete Supabase rows that are absent from Clerk without an explicit reconciliation report and owner approval.

### 13.4 Rollback

- Schema changes are additive; keep old columns until the new path is proven.
- The backend can continue using the service-role client while the user-scoped client is introduced.
- Keep the existing routes returning `410` until the frontend is verified, so rollback does not require restoring an insecure route.
- RLS tightening affects direct clients, not the service-role backend. If a direct client breaks, roll back the frontend, not the security policy.
- If a migration fails, restore the backup/restore point; do not edit production tables by hand without a reviewed script.
- Secret rotation requires a coordinated backend deploy; keep the old secret only for the shortest possible overlap.

### 13.5 Migration tooling

There is no migration history today. Choose one and document it before writing SQL:

- numbered SQL files under `Backend/migrations/` applied manually in order; or
- an approved migration tool.

Do not introduce a new package as part of this specification. The owner must approve the tooling decision. The single `Backend/schema.sql` file is not sufficient for an auditable Phase 02 rollout.

---

## 14. Testing strategy

### 14.1 Layers

1. **Unit tests** — authorization helpers, role normalization, last-admin rules, validation, error mapping.
2. **Route integration tests** — Express app with mocked Clerk auth and a test database; verify status codes and response shapes.
3. **RLS tests** — direct Supabase queries with anon and user-scoped tokens; verify row visibility.
4. **Webhook tests** — signed and unsigned payloads, duplicates, stale events, deletes, re-invites, unsupported types.
5. **Secret tests** — scan the frontend workspace and built bundle for secret markers.
6. **Manual checks** — real Clerk session, real webhook delivery, Supabase dashboard policy confirmation.

### 14.2 Required test matrix

| # | Scenario | Expected result |
|---|---|---|
| 1 | Request a protected route with no token | `401 UNAUTHENTICATED` |
| 2 | Request with an invalid/expired token | `401 UNAUTHENTICATED` |
| 3 | User A reads `/api/me` | Only A's row |
| 4 | User A reads or patches user B by ID | `404`/`403`; no data; no write |
| 5 | Request body includes a different `userId` | Rejected or ignored; identity remains the session user |
| 6 | User A lists organizations | Only A's active memberships |
| 7 | User A requests organization B without membership | `404`; no organization data |
| 8 | User A has no active org and calls an org route | `403 NO_ACTIVE_ORGANIZATION` |
| 9 | Active org does not match the route | `403 ORG_CONTEXT_MISMATCH` |
| 10 | Member reads organization and member list | `200`; email hidden from non-admin |
| 11 | Member invites, changes a role, or removes a member | `403 FORBIDDEN` |
| 12 | Admin invites a new member | `201`; Clerk called; webhook mirror converges |
| 13 | Admin promotes/demotes a member | `200`; role mirrored |
| 14 | Admin removes the last admin | `409 LAST_ADMIN`; no Clerk change |
| 15 | Member leaves a multi-admin org | `204`; membership inactive |
| 16 | Webhook with missing headers | `400`; no write |
| 17 | Webhook with invalid signature | `400`; no write |
| 18 | Duplicate `svix-id` for a processed event | `200`; one side effect |
| 19 | Retry of a failed event below the retry limit | Reprocessed once |
| 20 | Stale `user.updated` after a newer update | Older data ignored |
| 21 | `user.updated` after `user.deleted` | Deleted user is not resurrected |
| 22 | `organizationMembership.deleted` then a stale `created` | Membership remains inactive |
| 23 | Re-invite after removal | Membership reactivated, not duplicated |
| 24 | Unknown event type | `200`; ledger `ignored` |
| 25 | Anon Supabase `select * from users` | 0 rows |
| 26 | User A Supabase `select * from users` | Only A |
| 27 | User A Supabase `select * from organizations` | Only A's organizations |
| 28 | User A Supabase query for org B | 0 rows |
| 29 | Any `public` table with RLS disabled | Test fails |
| 30 | Frontend build/workspace secret scan | No secret markers |

### 14.3 Test implementation notes

- Prefer the Node built-in test runner (`node --test`) to avoid an unnecessary dependency.
- Route tests need an HTTP harness. `supertest` is the conventional choice but is an added package; request owner approval before installing it. A minimal `fetch` against an ephemeral listener is an alternative.
- Mock Clerk's session verification for most route tests, but keep at least one integration check with a real Clerk test session.
- Use a disposable Supabase project or schema for RLS tests. Never run destructive tests against production data.
- For webhook tests, use a test signing secret and construct valid/invalid Svix signatures locally. Do not call Clerk for every test.
- Clean up test users, organizations, memberships, and ledger rows after each run.
- Record the exact commands and results in the implementation report.

### 14.4 Commands

```bash
# Frontend
cd Frontend
npm run lint
npm run build

# Backend (to be added)
cd Backend
npm test
```

Phase 02 is not complete unless the commands above pass and the manual checks are recorded.

---

## 15. Acceptance criteria

Phase 02 is accepted only when all of the following are objectively true.

### Authentication

1. `GET /api/health` and `POST /api/webhooks/clerk` are the only public routes.
2. Every other route returns `401 UNAUTHENTICATED` without a valid Clerk session.
3. The backend derives the actor identity from the verified Clerk session, never from `req.body`, `req.query`, or a client-supplied ownership field.
4. `GET /api/me` returns only the caller's row.
5. `PATCH /api/me` rejects non-whitelisted fields and cannot change identity, email, role, or timestamps.

### Authorization

6. User A cannot read, update, or delete user B's row; the response is `404` or `403` and contains no user B data.
7. User A cannot read an organization or member list without an active membership; the response is `404`.
8. Org-scoped routes require the active Clerk organization to match the route and require a database membership row.
9. A member cannot invite, change roles, or remove members.
10. An admin can invite, change roles, and remove members.
11. The last active admin cannot be demoted or removed; the response is `409 LAST_ADMIN`.
12. A user may leave an organization when another admin remains.

### Data and RLS

13. `organizations`, `organization_members`, and `webhook_events` exist with the specified keys, constraints, and indexes.
14. RLS is enabled on every `public` table.
15. The open `anon`/`authenticated` read policy on `users` is gone.
16. Anon Supabase access to `users`, `organizations`, `organization_members`, and `webhook_events` returns no rows.
17. A user-scoped Supabase client returns only the user's own rows and organizations where they are an active member.
18. A cross-organization query returns no rows.
19. The service-role key is used only on the backend and only after an explicit authorization check, except in webhook/backfill paths where the signature or job boundary is the authorization.
20. The frontend workspace and built bundle contain no Clerk secret, Supabase service-role key, or webhook secret.

### Webhooks

21. Invalid or missing signatures return `400` and make no database changes.
22. Duplicate `svix-id` deliveries produce one side effect.
23. Stale updates do not overwrite newer data.
24. A deleted user is not resurrected by a late `user.updated`.
25. Organization create/update/delete and membership create/update/delete events are mirrored.
26. A re-invite reactivates the membership row rather than duplicating it.
27. Webhook failures are recorded with a safe error summary and the correct retry behavior.

### Operations and documentation

28. CORS uses an explicit frontend origin in production.
29. Errors use stable codes and do not expose database or Clerk internals.
30. `Frontend/npm run lint` passes.
31. `Frontend/npm run build` passes.
32. Backend authentication, authorization, webhook, and RLS tests pass.
33. The Clerk dashboard checklist in section 16 is completed and recorded.
34. The Supabase third-party auth decision and configuration are recorded.
35. Phase 01 manual acceptance is completed separately; Phase 02 does not claim it.
36. No GitHub discovery, parser, graph-data, AI, or chat implementation is added.

---

## 16. Risks, dependencies, and unresolved decisions

### 16.1 Dependencies and prerequisites

| Dependency | Why it matters | Owner action |
|---|---|---|
| Clerk Organizations enabled | The entire organization model depends on it | Enable in Clerk; confirm plan limits |
| Clerk webhook subscriptions | Organization and membership mirroring depend on them | Subscribe to the event list in section 10.2 |
| Webhook signing secret | Signature verification cannot work without it | Place only in backend env |
| Supabase third-party auth for Clerk | Required for `auth.jwt()->>'sub'` policies and user-scoped clients | Configure in Supabase or approve the fallback |
| Supabase backup/restore point | Schema and RLS changes are risky without rollback | Create before migration |
| Staging project | RLS and webhook tests must not touch production | Provide a disposable project |
| Owner approval to rotate the exposed Clerk secret | The current secret has lived in a frontend file | Coordinate rotation and redeploy |
| Migration tooling decision | No migration history exists | Approve numbered SQL files or a tool |
| Test tooling approval | `supertest` or another harness may be needed | Approve before installing |

### 16.2 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Clerk Organizations not enabled or plan-limited | Phase 02 cannot deliver organizations | Confirm before implementation; do not fake org data |
| Supabase third-party auth unavailable | RLS cannot read Clerk identity | Use service-role + explicit checks as a documented fallback; do not pretend RLS is enforcing |
| Webhook event schema changes | Sync failures or silent data drift | Validate shapes, log safe failures, keep the ledger, monitor |
| Out-of-order or duplicate events | Resurrected users, wrong roles, duplicated memberships | Idempotency ledger, source timestamps, soft deletes, conditional writes |
| Last-admin race | Organization left without an admin | Transaction/advisory lock or Clerk-side guard; re-check after write |
| Backfill mismatch | Missing organizations or memberships | Dry run, counts, reconcile with Clerk, idempotent upserts |
| Secret already exposed | Clerk secret may be compromised | Remove from frontend, rotate, redeploy, audit access |
| Secret scanning false negatives | Future secret leak | CI check plus code review; never rely on one scanner |
| RLS policy mistake | Data exposure or total denial | Staging tests for anon, member, admin, and cross-org; review every policy |
| RLS helper recursion or performance | Query failures or slow lists | `security definer` helpers, fixed `search_path`, indexes |
| CORS misconfiguration | Browser calls blocked or overly broad | Explicit `FRONTEND_ORIGIN`; no wildcard in production |
| No Git history | Hard to review or roll back changes | Create a Git repository before implementation; keep migrations reviewed |
| Local ngrok tunnel | Development-only exposure and startup failure | Move behind a dev script/flag; never use in production |
| Scope creep into parsing or AI | Phase 02 becomes unshippable | Enforce the non-goals; no repositories/analyses tables |
| Frontend org UI scope unclear | Backend may be ready with no usable org context | Decide the UI scope before implementation |
| Test suite adds packages | Violates the no-install rule | Approve tooling; prefer built-ins |

### 16.3 Unresolved decisions requiring the project owner

1. **Supabase authorization path:** configure Supabase third-party auth for Clerk and use user-scoped clients with RLS (recommended), or use the service-role client for all server access with explicit checks and accept that RLS is defense-in-depth only. The former matches `Docs/Project_doc.md`; the latter is a documented deviation.
2. **Frontend scope:** does Phase 02 include an organization switcher, organization creation, invitations, and member management UI, or only the backend/API and the minimum token/org-context wiring? The backend spec is the same either way; the UI scope changes the effort and acceptance checks.
3. **Account deletion:** should users delete their own account through a new backend flow that calls Clerk, or is account deletion handled entirely in Clerk for now? The current unauthenticated `DELETE /users/:id` must not remain.
4. **Email visibility:** should regular organization members see each other's email addresses, or only admins? This specification recommends admins only.
5. **Legacy route removal:** remove `/SignUp`, `/SignIn`, and `/users/:id` immediately, or keep them returning `410` for one release? The frontend does not call them, so immediate removal is recommended.
6. **Organization deletion:** include `DELETE /api/organizations/:orgId` in Phase 02, or defer it to a later phase? It is destructive and not required for the core security goal.
7. **Test tooling:** approve `supertest`/an equivalent route-test harness, or require tests to use only Node built-ins and `fetch`? No package will be installed without approval.
8. **Migration execution:** numbered SQL files applied manually, or an approved migration tool? No tooling should be installed as part of the spec.
9. **Direct browser-to-Supabase access:** if it is not planned, remove `Frontend/src/lib/supabaseClient.js` and the `VITE_SUPABASE_*` variables rather than leaving a dormant path.
10. **Cross-organization status:** confirm `404` for non-member access (recommended to avoid existence leaks) rather than `403`.

---

## Appendix A — Clerk dashboard checklist (owner action)

- [ ] Organizations enabled.
- [ ] Default roles `org:admin` and `org:member` available.
- [ ] Webhook endpoint points to the backend `/api/webhooks/clerk`.
- [ ] Webhook subscribes to the nine events in section 10.2.
- [ ] Webhook signing secret copied to `Backend/.env` only.
- [ ] `CLERK_SECRET_KEY` present in the backend environment only.
- [ ] `CLERK_SECRET_KEY` removed from `Frontend/.env`.
- [ ] Exposed Clerk secret rotated after the backend is ready.
- [ ] Clerk JWT includes `sub`, `org_id`, `org_role`, and `org_slug` when an organization is active.
- [ ] Test user and test organization available for staging checks.

## Appendix B — Supabase dashboard checklist (owner action)

- [ ] Backup or restore point created.
- [ ] Clerk configured as a third-party auth provider, if that path is approved.
- [ ] JWT verification tested with a real Clerk token.
- [ ] RLS helpers and policies applied in staging first.
- [ ] Anon key cannot read `users`, `organizations`, `organization_members`, or `webhook_events`.
- [ ] User-scoped token can read only the user's own and organization rows.
- [ ] Every `public` table has RLS enabled.
- [ ] Service-role key confirmed server-only.
- [ ] No open `USING (true)` policy remains for `anon` or `authenticated`.

## Appendix C — Implementation order summary

```text
Approve audit + spec
  → secret hygiene + Git baseline
  → additive schema
  → webhook ledger + organization events
  → RLS helpers + policies (staging first)
  → Clerk middleware + protected routes
  → `/api/me` + organization routes
  → frontend token/org context
  → remove legacy routes
  → test matrix + manual checks
  → documentation update + Phase 02 closure
```

Phase 02 is complete only after the owner reviews the test evidence and accepts the unresolved decisions. It is not complete because the code compiles.
