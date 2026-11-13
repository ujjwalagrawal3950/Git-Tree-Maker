# Phase 01 — App shell and dependency map

> **Implementation status (updated after security remediation 2026-11-12): NOT CLOSED.**
> The shell and map are implemented, lint and the production build pass, and the
> backend test baseline passes. The nine manual acceptance checks have still not
> been run. Clerk authentication and a backend were added beyond this phase's
> scope. See `Docs/audits/implementation-audit.md` for the original evidence,
> `Docs/audits/security-remediation.md` for the fixes, and
> `Docs/architecture/current-architecture.md` for the current design.
> The original specification below is preserved; the reconciliation is at the
> end of this file.

## Goal

Build the first usable Cartograph screen: a dense repository shell around an
interactive dependency map, driven by bundled fixture data.

This phase establishes the permanent panel layout. Later phases add data and
actions to these panels; they do not rearrange them.

## Stack decision

The repository is already a Vite + React 19 + JSX project. The user approved
keeping that stack instead of migrating to Next.js + TypeScript for this phase.
The installed Tailwind CSS is v3, so this phase uses it through PostCSS; the
`@tailwindcss/vite` v4 plugin in the scaffold was not usable without installing
Tailwind v4 and has been left out of the Vite config. The map uses
`@xyflow/react` (React Flow) and `dagre` for layout, as named in `Opencode.md`.

No other packages are added.

## In scope

- Application shell: top bar, left rail, map canvas, detail panel, status bar.
- Light / dark / follow-system theme, persisted across reloads.
- A bundled sample repository with files, folders, kinds and import edges.
- Folder-level map that expands into file-level nodes.
- File selection, edge direction highlighting, and a detail panel.
- Incoming and outgoing dependency lists that can be used to move selection.
- A repository URL field that is honest about parsing not existing yet.

## Out of scope

Parsing, GitHub auth, organizations, real repository data, coverage reporting,
blast radius, dependency chains, file explanations, AI chat, scores, and any
network request.

## Layout

The shell is fixed to the viewport. The map is the only region that grows.

```
┌──────────────────────────────────────────────────────────────┐
│ top bar: brand · repository URL · open · theme                │
├───────────────┬──────────────────────────────┬───────────────┤
│ left rail     │ map canvas                   │ detail panel  │
│ 232px         │ flexible                     │ 320px, on     │
│               │                              │ selection     │
├───────────────┴──────────────────────────────┴───────────────┤
│ status bar                                                   │
└──────────────────────────────────────────────────────────────┘
```

- Top bar: 48px. Brand, repository input, Open button, three-state theme
  control.
- Left rail: repository summary, legend, and a short "how to read this" block.
- Detail panel: hidden until a file is selected. It overlays nothing; the map
  narrows.
- Status bar: file and edge counts, plus canvas hints.

## Fixture data

`src/data/sampleRepository.js` exports a plain object:

```js
{
  name: 'acme/storefront',
  branch: 'main',
  files: [{ id, path, name, folder, kind, imports: [fileId] }],
  edges: [{ source, target }],
}
```

- One small, realistic React/Next-style repository, roughly 18–22 files across
  a handful of top-level folders.
- `kind` is one of: `entry`, `component`, `hook`, `utility`, `style`, `config`,
  `test`.
- Edges always point from importer to imported file.
- The fixture is clearly labelled "Sample" everywhere it is presented as data.
- Presentation code must not hard-code fixture names.

## Behaviour

### Theme

1. Three states: follow system, force light, force dark.
2. The choice is stored in `localStorage` and survives reloads.
3. Follow-system reacts to OS theme changes while the app is open.
4. The resolved theme is applied before first paint, so there is no flash.
5. Both palettes are complete; dark is not an inverted light theme.

### Map

1. Initially every top-level folder is a collapsed box.
2. A collapsed folder shows its name, file count, and aggregated incoming and
   outgoing dependency counts.
3. Clicking a folder expands it into file nodes inside the folder boundary.
4. Only one folder is expanded at a time. Expanding another collapses the
   previous one.
5. Clicking the expanded folder header collapses it.
6. Edges between collapsed folders are aggregated and labelled with a count.
7. Edges touching an expanded folder resolve to individual files.
8. Layout is deterministic: the same expansion state always produces the same
   positions.

### Selection

1. Clicking a file selects it, opens the detail panel, and highlights its edges.
2. Outgoing edges are amber. Incoming edges are green. Unrelated edges and
   nodes are dimmed, not removed.
3. Clicking the canvas background or pressing Escape clears selection.
4. Selecting a file from the detail panel expands its folder if needed, selects
   it, and keeps the panel open.
5. Hovering a node or edge is allowed to change only that element's appearance.
   Nothing moves or animates on its own.

### Detail panel

For the selected file:

- Kind badge and file name.
- Full path in monospace.
- Fan-out and fan-in counts.
- "Imports" list: direct outgoing targets.
- "Imported by" list: direct incoming sources.
- Each list item is a button that selects that file.
- Empty lists state "None" rather than disappearing.

### Repository input

- Accepts a GitHub repository URL.
- The Open button is disabled until the input looks like a GitHub URL.
- Submitting shows an inline notice: repository parsing is not part of this
  phase, and the sample repository remains loaded.
- No fake progress, spinner, or success state.

## Visual rules

- Dense developer-tool sizing: 12–13px UI text, 11–12px monospace paths, tight
  spacing.
- Colour only for direction and file kind.
  - Accent blue: selection and interactive controls.
  - Incoming: green.
  - Outgoing: amber.
  - Kinds: one distinct hue per kind, muted enough to sit beside the direction
    colours.
  - Everything else: greyscale.
- Surfaces, borders and body text come from CSS variables so both themes stay
  coherent.
- Rectangular controls with small radii. No decorative shadows, gradients,
  glows, or ambient animation.
- Focus states are visible for every interactive element.

## Acceptance check (manual)

1. Reload with each theme choice; the correct palette appears with no flash.
2. Change the OS theme while "follow system" is selected; the app follows.
3. The initial map shows folder boxes only, with correct counts.
4. Expand a folder: its files appear inside it and other folders collapse.
5. Select a file: outgoing edges are amber, incoming are green, unrelated
   elements dim, and the detail panel lists the right files.
6. Click an import in the panel: selection moves and the panel updates.
7. Press Escape and click the background: selection clears.
8. Enter a GitHub URL and press Open: the honest "not in this phase" notice
   appears and the sample stays.
   *(Superseded by Phase 04: submission now performs backend repository
   verification and shows `Checking repository...`, a verified/error notice,
   or an auth/org notice. Verify the Phase 04 behaviour instead.)*
9. Resize the window: the map resizes, the shell does not scroll.

## Checks before calling the phase done

- `npm run lint`
- `npm run build`

This is a JavaScript project, so there is no TypeScript check to run. That is
reported rather than hidden.

---

## Implementation reconciliation (audit 2026-11-12)

This section records what actually exists. It does not change the original
acceptance criteria above.

### Original acceptance criteria — status

Manual checks were **not performed during the audit**. “Implemented” below means
the code path exists and was verified by reading the current files; it does not
mean the browser behaviour was accepted.

| # | Original criterion | Status | Evidence / note |
|---|---|---|---|
| 1 | Reload with each theme choice; correct palette, no flash | **Not tested — implemented** | `Frontend/src/hooks/useTheme.js`, pre-paint script in `Frontend/index.html` |
| 2 | Change OS theme while “follow system” is selected | **Not tested — implemented** | `matchMedia` change listener in `useTheme.js` |
| 3 | Initial map shows folder boxes only, with correct counts | **Not tested — implemented** | `getLayout` / `buildElements`; 22 files, 23 edges, 7 folders |
| 4 | Expand a folder; its files appear, others collapse | **Not tested — implemented** | `App.jsx` `handleToggleFolder`; `buildElements.js` |
| 5 | Select a file; amber outgoing, green incoming, unrelated dimmed, correct detail lists | **Not tested — implemented** | `buildElements.js` tones; `DetailPanel.jsx` |
| 6 | Click an import in the panel; selection moves and panel updates | **Not tested — implemented** | `App.jsx` `handleSelectFile`; `DetailPanel.jsx` |
| 7 | Escape and background click clear selection | **Not tested — implemented** | `App.jsx` keydown effect; `DependencyMap.jsx` `onPaneClick` |
| 8 | GitHub URL + Open shows the honest notice and keeps the sample | **Superseded by Phase 04** | `App.jsx` `handleSubmit` now calls `verifyRepositoryUrl` and shows `Checking repository...` / `Public repository verified: {fullName}` / an error notice. The original "parsing is not in this phase" notice no longer exists. Re-scope this check when running manual acceptance. |
| 9 | Resize; map resizes, shell does not scroll | **Not tested — implemented** | `index.css` flex shell; React Flow fit view |

### Implemented and verified by inspection

- Fixed shell: top bar, left rail, map, detail panel, status bar.
- Three-state theme persisted under `cartograph-theme`, with a pre-paint script.
- System-theme listener.
- Bundled sample repository with 22 files across 7 folders and 23 edges.
- One-folder-at-a-time expansion.
- Aggregated folder edges with counts.
- Deterministic Dagre left-to-right layout.
- File selection with incoming/outgoing/dim edge tones.
- Detail panel with fan-in/fan-out and clickable neighbour lists.
- Escape and canvas-background selection clearing.
- GitHub repository URL validation and the honest parsing notice.
- File-kind and edge-direction colour tokens in `index.css`.
- Visible focus styles.
- Production build passes.

### Implemented but not manually verified

- No theme flash on reload.
- Live OS theme switching.
- Every item in the nine-step manual acceptance check above.
- Clerk sign-in, sign-up, sign-out, and user-button behaviour.
- Webhook delivery through ngrok.
- Responsive resize behaviour.
- Whether the sample edge counts and folder counts read correctly on screen.

### Added beyond Phase 01 scope

- Clerk authentication UI and a signed-in UI gate.
- Express 5 backend with `/SignUp`, `/SignIn`, and `/users/:id` CRUD.
- Supabase `public.users` table with RLS.
- Clerk webhook sync for `user.created`, `user.updated`, and `user.deleted`.
- ngrok tunnel startup from the backend.
- An unused browser Supabase client (`Frontend/src/lib/supabaseClient.js`).

These are real additions, not Phase 01 requirements. They are undocumented in
the original phase scope.

### Deviations from the original scope

- The app shell is hidden when signed out. Phase 01 assumed no authentication.
- Clerk auth introduces network requests; Phase 01 said “no network request.”
- The unused `StrictMode` import was fixed during the 2026-11-12 security
  remediation.
- `Frontend/Opencode.md` describes Next.js 16, TypeScript, Tailwind v4, and pnpm;
  the implemented stack is Vite, React 19, JSX, Tailwind v3, and npm.
- `Frontend/src/App.css` is unused scaffold CSS.
- `Frontend/.env.example` now includes the Clerk publishable key required by
  `main.jsx` and the backend API URL.

### Checks

| Check | Result |
|---|---|
| `cd Frontend && npm run lint` | **Pass** |
| `cd Frontend && npm run build` | **Pass** — 634.72 kB JS chunk warning |
| `cd Frontend && npm run check:secrets` | **Pass** |
| `cd Backend && npm test` | **Pass** — 12 tests |
| Manual acceptance | **Not run** |

### Closure decision

**Phase 01 is not closed.** Closing it requires running the nine manual checks
above and recording the results. The lint failure is fixed. The Clerk/backend
scope decision is recorded in Phase 02 and in
`Docs/audits/security-remediation.md`.

