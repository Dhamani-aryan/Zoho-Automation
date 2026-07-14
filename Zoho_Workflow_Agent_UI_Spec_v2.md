# Zoho Workflow Agent — UI/UX Overhaul Spec (v2, repo-grounded)

This is an implementation spec for an EXISTING app. Do not scaffold a new
project or a parallel design system — restyle and restructure what is there.

## Repo context (read before writing any code)

- App: `zoho-agent/` — Next.js App Router + Tailwind CSS + Supabase.
- Pages live in `app/`: `agent`, `dashboard`, `skills`, `records`, `imports`,
  `runs`, `run/[id]`, `run/new`, `settings`, `login`, `admin/agent-activity`,
  `admin/field-meta`.
- Shared components in `components/`: `app-shell.tsx` (sidebar nav),
  `page-header.tsx`, `metric-card.tsx`, `status-badge.tsx`, `agent-chat.tsx`
  (the big one — streaming chat + tool events), and others. Reuse and restyle
  these; do not fork them.
- Theming: `tailwind.config.ts` defines semantic tokens already used
  everywhere: `surface`, `ink`, `muted`, `line`, `accent`, `warn`, `danger`.
  Implement dark mode by REDEFINING these token values (plus `globals.css`
  body colors) so every page flips at once. Then sweep remaining hardcoded
  light classes (`bg-white`, `bg-slate-50`, `bg-emerald-50`, `text-slate-*`)
  and replace them with token equivalents. Do not scatter `zinc-*` literals
  through JSX — extend the token palette instead.
- Auth: pages are protected by `middleware.ts` (matcher list) — any new route
  must be added there. Data reads use the user-scoped Supabase server client;
  writes go through existing API routes only.

## Scope control — implement in three separate phases (separate PRs/commits)

Phase 1: theme + shell + shared components (tokens, sidebar, PageHeader,
tables, buttons, status badges). All pages inherit the look. App must build
and remain fully functional after this phase alone.

Phase 2: Agent chat execution timeline (highest-risk file: `agent-chat.tsx`).

Phase 3: Skills library table + detail view + Run Skill form; dashboard
compaction; runs table polish.

Do not attempt all three in one change.

---

# Design goals

Modern internal developer tool, not a marketing site. Inspiration: Linear,
Vercel dashboard, Raycast, GitHub Actions. Minimalistic, dark-mode first,
desktop-first, dense.

Avoid: glassmorphism, gradients, large colorful cards, fancy animations,
heavy shadows (remove the existing `shadow-soft` usage where it fights the
flat dark look).

# Layout

Keep the existing permanent left sidebar (`app-shell.tsx`). Order:
Agent, Dashboard, Runs, Skills, Records, Imports, Settings, then admin items
(role-gated, as today). Keep content wide; do not center pages.

# Color palette (new token values in tailwind.config.ts)

- Background `#09090B` (body / canvas)
- `surface` → `#111113` (panels, cards, table headers)
- `line` → `#232326` (borders)
- `ink` → `#FAFAFA` (primary text)
- `muted` → `#A1A1AA` (secondary text); add `subtle: #71717A` if needed
- `accent` → blue (e.g. `#3B82F6`) — replaces the current green
- Status: green = success, blue = running, orange = pending, red = error,
  gray = idle. Centralize these in `status-badge.tsx`; every page uses that
  component, never ad-hoc status colors.

No gradients.

# Typography

Inter or Geist via `next/font` in `app/layout.tsx`. Hierarchy: page title,
section heading, body, small metadata. No oversized headings.

# Components

- Cards: thin `border-line`, small radius (`rounded-lg`), `bg-surface`, no
  shadow.
- Tables preferred over card grids: Runs, Skills, Records, Imports.
- Buttons: exactly three variants — primary (accent), secondary (surface +
  border), destructive (danger). Make a small shared `Button` component if
  one does not exist; no fancy hover effects.
- Plain Tailwind only. Do NOT add shadcn/ui, Radix, or any new UI dependency
  — this app has none today and adding them mid-overhaul is out of scope.

# Agent chat (Phase 2)

The chat is an execution console. Preserve ALL existing behavior (streaming,
teach-mode toggle, session list, stop button, approval flows) — this is a
re-render of the same data, not a rewrite of the data flow.

- Tool calls render as a collapsible execution timeline: one row per tool
  call with a status icon (✓ / ✗ / spinner), short human label (tool name +
  key argument, e.g. "browser_input · type → Email subject"), and duration
  when available.
- Never show raw JSON by default. Raw args/results go behind a per-item
  "View details" expander (a `<details>` element is fine).
- Verification evidence (read-backs, `verified`, `signature_present`,
  schedule confirmation) gets a distinct final timeline row so the user sees
  proof at a glance.

# Dashboard (Phase 3)

Compact stat row (small inline stats, not large KPI cards): Active runs,
Completed today, Failed runs, Sync count. Below: Recent runs, Recent
activity. NOTE: "Skills used" is not tracked in the database today — omit it
rather than inventing a metric.

# Runs (Phase 3)

Sortable table: Status, Name, Started, Duration, Progress, Owner. Row click
opens the existing `run/[id]` page, restyled with: summary, progress,
timeline, item list, logs. Keep all existing controls
(approve/pause/resume/cancel).

# Skills library (Phase 3)

Data source: `skill_guides` table (fields: id, name, intent, preconditions,
method_api, method_ui, gotchas, verification, stop_conditions, params jsonb
[{name, description, example}], version, created_at, updated_at). A basic
`/skills` page already exists — upgrade it.

Main page: table with columns Name, Version, Method (derived: "API" if
method_api non-empty, "Browser" if method_ui non-empty, "API + Browser" if
both), Auto-trigger (yes for the four core guide names hardcoded in
`lib/agent/guide-routing.ts`; show their keywords in the detail view), Last
updated. Filters: text search (name/intent), method. NOTE: there is no
"status" column in the schema — omit Status.

Detail view (expandable row or `/skills/[id]` page): intent, parameters
table, preconditions, browser steps (method_ui), API steps (method_api),
gotchas, verification, stop conditions, trigger keywords, version number and
timestamps. NOTE: only the current version is stored — there is no version
history table; show "v{n}, updated {date}" and omit history.

Actions:
- Edit: inline form that PATCHes the existing
  `app/api/skill-guides/[id]/route.ts` endpoint (admin/operator only — hide
  the button for other roles).
- Run skill: build a query string from the guide's params
  (`/agent?prefill=...`) and have the agent page pre-fill the chat input
  with a templated message listing each param slot for the user to complete.
  Requires a small, isolated change in `agent-chat.tsx` to read the prefill
  param; do not auto-send.
- NOTE: omit "Duplicate" — there is no create API and duplicating guides
  conflicts with the agent's update-in-place memory model.

# Records / Imports / Settings (Phase 1 restyle only)

Records: keep current table + search, restyled. Imports: keep current
upload → preview flow, restyled; validation warnings in a table. Settings:
group into LLM / Browser extension / Account sections with clear headings
(admin links stay in the sidebar).

# Implementation philosophy

Every screen answers: What is happening? What succeeded or failed? What can
I do next? If a feature does not improve clarity, leave it out.

# VERIFY (every phase)

- `npm run typecheck` and `npm run lint` pass; `npm run build` succeeds.
- Every existing page renders with no white-background remnants (grep for
  `bg-white`, `bg-slate-`, `bg-emerald-` after Phase 1 — zero hits in
  `app/` and `components/`).
- Agent chat still streams, teach mode toggles, tool statuses update live,
  and a full email-schedule turn works end to end.
- `/skills` lists all guides; Edit round-trips through the PATCH endpoint;
  Run Skill lands on `/agent` with the prefilled message in the input.
- New routes (e.g. `/skills/[id]`) are in the `middleware.ts` matcher.
- Login page still usable (it may keep a simple centered layout).

# DO NOT

- Do not touch anything in `lib/agent/`, `lib/llm/`, `extension/`, or any
  `app/api/` route logic except adding the read/prefill plumbing explicitly
  named above.
- Do not add new dependencies (no shadcn/ui, no Radix, no component libs).
- Do not change Supabase schema, RLS, or queries beyond selecting existing
  columns.
- Do not rename existing components, routes, or props; restyle in place.
- Do not implement light mode, theme toggles, or mobile layouts in this
  overhaul.
