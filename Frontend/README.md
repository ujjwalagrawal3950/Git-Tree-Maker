# Cartograph — frontend

The interface for Cartograph: a dense dependency map of a repository, with a
file detail panel and light/dark themes.

This phase renders a bundled fixture. Nothing is parsed, fetched, or stored by the map. Clerk sign-in gates the shell, but the frontend does not call the backend yet.

## Run

```bash
npm install
npm run dev
```

## Checks

```bash
npm run lint
npm run build
```

## Phase 01

See `../Docs/specs/phase-01.md`.

Built: app shell, three-state theme, sample repository map, folder expansion,
file selection, incoming/outgoing edge highlighting, and the file detail panel.

Not built: repository parsing, GitHub discovery, organizations, coverage, blast
radius, explanations, and chat. The repository URL field says so when submitted.

Current check status: `npm run lint`, `npm run build`, and
`npm run check:secrets` pass. The Phase 01 manual acceptance check has not been
run. See `../Docs/audits/implementation-audit.md`.

## Account and security notes

- The Clerk user profile keeps account deletion but hides Clerk's password
  section. Password changes are not offered by this app.
- Account deletion calls the backend, deletes the Clerk identity, then removes
  the local user row. Organization memberships are removed by database cascade.
- `VITE_API_URL` defaults to `http://localhost:3000` when unset.
- Never place `CLERK_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, a webhook secret,
  or an ngrok token in a `VITE_` variable.

## Stack note

The scaffold is Vite + React 19 + JSX. It uses the Tailwind CSS v3 already
installed through PostCSS. The map uses React Flow (`@xyflow/react`) and dagre.
