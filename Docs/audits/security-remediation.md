# Cartograph — Security Remediation Record

**Date:** 2026-11-12
**Scope:** application code, SQL schema, frontend profile/delete flow, repository secrets.
**Status:** implemented and statically verified. Live database migration, Clerk/Supabase dashboard changes, secret rotation, webhook delivery, and browser acceptance are still owner actions.

Status labels:

- **Verified** — checked by running lint/build/tests or by reading the changed code.
- **Implemented, not exercised** — code exists but the live dependency was not available.
- **Owner action required** — cannot be completed from this repository alone.

---

## 1. Fixed in application code

| Audit finding | Status | Change |
| --- | --- | --- |
| Critical: unauthenticated user CRUD | Verified | Removed `/SignUp`, `/SignIn`, and public `/users/*` routes. Added Clerk middleware and `requireAuth`; only `/api/me` and `/api/account` remain. |
| Critical: client-supplied identity | Verified | Identity now comes only from `getAuth(req).userId`. No request body or URL can select the acting user. |
| Critical: mass assignment | Verified | User writes are internal webhook/Clerk sync only. Profile fields are explicitly whitelisted and bounded. |
| Critical: service-role key used without explicit authorization | Implemented, not exercised | The admin client is server-only and fails fast when unconfigured. Account, organization, and member routes perform explicit self/membership/admin checks before admin queries. |
| High: permissive CORS | Verified | CORS is an origin allowlist from `FRONTEND_ORIGIN`; development defaults are localhost only. Webhooks are server-to-server and sit outside CORS. |
| High: open RLS policy | Implemented, not exercised | `Backend/schema.sql` removes all existing policies on protected tables and adds self/member-only `SELECT` policies. No anon or authenticated write policies remain. |
| High: missing organization tenancy | Implemented, not exercised | Added organizations, memberships, active-admin protection, invitation/member routes, and `ON DELETE CASCADE` from users to memberships. |
| High: webhook replay/order issues | Implemented, not exercised | Added a `webhook_events` ledger, Svix signature verification, atomic claim, retry cap, processing lease, source timestamp ordering, and user/organization/membership tombstones for delete-before-create delivery. |
| High: webhook raw body | Verified | The webhook is mounted before `express.json()`, so Svix receives the raw bytes. |
| High: Clerk secret in frontend env | Verified (removal); owner action required (rotation) | Removed `CLERK_SECRET_KEY` from `Frontend/.env` without reading or printing the value. The exposed key must still be rotated in Clerk because it may have been copied. |
| Medium: no validation | Verified | Added bounded string, email, slug, Clerk ID, role, and JSON-body validation. Unknown role values are rejected on write routes. |
| Medium: error leakage | Verified | Added safe error bodies, request IDs, body-size limits, security headers, and server-side-only error logging. |
| Medium: anon-key fallback for backend | Verified | Removed the fallback. The service-role key is required for backend startup. |
| High: no cascade on account deletion | Implemented, not exercised | `DELETE /api/account` deletes the Clerk identity, then calls `delete_user_cascade`, which inserts a tombstone and deletes the local user row. `organization_members.user_id` has `ON DELETE CASCADE`. |
| Low: ngrok always started | Verified | ngrok is opt-in via `ENABLE_NGROK=true`; failures are caught and logged. |
| Low: unused Supabase browser client | Verified | Removed `Frontend/src/lib/supabaseClient.js`; the frontend no longer carries a dead direct-database path. |
| Low: lint failure | Verified | `StrictMode` is now used. `npm run lint` passes. |
| Low: placeholder backend test | Verified | Replaced with `node --test` and added validation/error-mapping tests. |

## 2. Frontend profile and deletion flow

- The Clerk `UserButton` profile hides `profileSection__password`.
- The built-in danger section is hidden and replaced by a custom **Delete account** menu item.
- The custom dialog calls `DELETE /api/account` with the Clerk session token.
- The backend deletes the Clerk user first, then the local user row; memberships are removed by foreign-key cascade.
- If local deletion fails after Clerk succeeds, the `user.deleted` webhook is the convergence path.
- The frontend never receives or stores a server secret.

## 3. Checks actually run

| Command | Result |
| --- | --- |
| `Backend: npm test` | Pass — 12 tests (validation, error mapping, and schema policy assertions) |
| `Backend: node --check` over all non-`node_modules` JavaScript | Pass |
| `Backend: node -e "require('./app')"` | Pass — module loaded |
| Backend ephemeral server: `GET /api/health` | Pass — 200 |
| Backend ephemeral server: `GET /api/me` without a session | Pass — 401 |
| Backend ephemeral server: disallowed `Origin` | Pass — 403 |
| Backend ephemeral server: webhook without Svix headers | Pass — 400 |
| Backend ephemeral server: webhook with invalid signature | Pass — 400, rejection logged without payload |
| `Frontend: npm run lint` | Pass |
| `Frontend: npm run build` | Pass — existing 634.72 kB chunk warning remains |
| `Frontend: npm run check:secrets` | Pass |
| `Frontend: npm run check:secrets` after build | Pass — built `dist/` also scanned |

Not run: Supabase migration, RLS integration tests, live Clerk webhook delivery, live account deletion, organization acceptance, and browser UI acceptance.

## 4. Owner actions still required

1. Rotate the Clerk secret key that was previously stored in `Frontend/.env`.
2. Apply `Backend/migrations/001_phase02_security.sql` to a staging Supabase project first. If the unique email index fails, resolve duplicate active emails before retrying.
3. Configure Clerk as a Supabase third-party auth provider if direct user-scoped Supabase reads are wanted later. The current backend uses the service role only after explicit checks.
4. Confirm Clerk session tokens include the `sub` claim required by the RLS policies.
5. Configure the Clerk webhook endpoint to `https://<backend>/api/webhooks/clerk` and subscribe to user, organization, and organization-membership create/update/delete events.
6. Set `FRONTEND_ORIGIN` in production to the exact frontend origin. Do not use `*`.
7. Set a strong `CLERK_WEBHOOK_SECRET` and keep it only in the backend environment.
8. Run browser acceptance for the hidden password section, delete-account dialog, and post-deletion signed-out state.
9. Reconcile Clerk organization settings with the role names `org:admin` and `org:member`.
