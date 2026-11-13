# Cartograph — Frontend Phase Rules

## Stack

Vite 8, React 19, JSX (not TypeScript), Tailwind CSS v3 via PostCSS, npm, React Flow (`@xyflow/react`) and dagre for the dependency map UI. Clerk provides authentication. The stack decision is recorded in `Docs/specs/phase-01.md`; do not migrate to Next.js or TypeScript without approval.

If you are not certain about an installed API, read the documentation inside the package rather than going from memory.

Only use the technologies required by the current frontend phase. Do not install additional packages without asking first.

## How we work

Spec driven. Nothing gets built without a spec.

- `Docs/Project_doc.md` — what this app is and the reasoning behind its decisions. Read the relevant part. Don't ask me to paste it.
- `Docs/specs/phase-NN.md` — the specification for the current phase, written just before it starts.
- This file — rules that apply throughout the project.

**Starting a phase.** Read this file and the current phase's spec. Build what the spec asks for and stop.

**Dropped into a fresh context?** Look at the files in `Docs/specs/` and the git log. Explain what you've established before continuing.

**The acceptance check is mine to run.** Build the interface so the specified browser behaviour is possible. Don't automate manual acceptance checks or install browser-testing tools.

**Before calling a phase done:** run the available lint and production build. Report any failures honestly.

**When a phase comes out wrong, reset rather than patch repeatedly.** If the spec is ambiguous, explain the ambiguity before building.

## How to talk to me

Keep responses short and direct.

**Ask with a recommendation.** Ask one specific question at a time and recommend an option with a reason. Never silently choose between materially different approaches.

**When you need something only I can provide**, explain exactly what is needed and where it belongs, then stop.

**No walls of text.** When a phase is done, say what it does and what I should check in the browser.

**Plain English.** Explain technical decisions clearly without unnecessary breakdowns.

**Report failures honestly.** Never hide a problem behind a workaround.

## Frontend boundaries

- Build only the interface and behaviour required by the current frontend specification.
- Use local fixture data or explicitly approved mock data wherever real backend data is not yet available.
- Keep components focused and reusable where reuse is justified.
- Keep UI state and presentation logic separate from data fixtures.
- Use plain JavaScript and JSX. Match the existing module style. Do not introduce TypeScript without approval.
- Keep the interface consistent with the product's developer-tool design: compact typography, tight spacing, monospace file paths, and purposeful colour.
- Nothing animates unless the user initiates the interaction.
- Do not build backend endpoints, database schemas, authentication flows, repository parsing, AI calls, or infrastructure for future phases from the frontend. Backend work belongs in `Backend/` and its own specification.
- Do not add placeholder functionality that pretends a future feature already works.
- Do not create scaffolding for future phases unless the current spec explicitly requires it.

## Things not to do

Breaking these rules is worse than not finishing.

- **Don't build ahead of the current phase.** Implement only what the current spec requires.
- **Don't install a package without asking.** Name it, explain why it is needed, and wait for approval.
- **Don't invent functionality.** If an interaction is not implemented, don't make it appear functional.
- **Don't grade the codebase.** No scores, ratings, severity badges, or issue counts. Cartograph explains codebases; it does not review their quality.
- **Don't leave the build broken.** Report failures rather than hiding them.
- **Don't weaken checks to make them pass.** A check that cannot run must be reported honestly.
- **Don't over-engineer.** Prefer one clear implementation over unnecessary configuration and abstractions.
- **Don't redesign approved layouts without asking.** Follow the current phase specification.
- **Don't claim backend functionality exists.** Mock data must remain clearly separated from real repository data.

## Definition of done

The current frontend specification is implemented, the interface behaves as specified, the available lint and production build pass, and the manual browser acceptance check is ready for me to perform.