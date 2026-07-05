# Zoho Workflow Agent — Project Overview

*A shareable summary of what this project is, why it exists, how it works, and where it stands.*

Prepared by: Aryan Dhamani (aryan@klouddata.com), KloudData
Last updated: 2026-07-04

---

## 1. In one sentence

We are building an internal web tool that lets our sales-ops team run repetitive Zoho CRM work — scheduling outreach emails, creating tasks, updating deals, reassigning owners — by typing a plain-English command, reviewing exactly what will happen, and approving it, with every action carried out safely inside each user's own logged-in Zoho session.

## 2. The problem we're solving

Today, a lot of our Zoho work is manual and repetitive: opening deals one by one, creating "1st Email" tasks, updating the Next Step field, composing and scheduling outreach emails per contact, reassigning batches of accounts to a new owner, tagging records, fixing phone numbers in bulk. It's slow, easy to get wrong, and the knowledge lives in scattered files and people's heads.

We already proved the *approach* works using an AI assistant that reads our files, follows written playbooks, drives Zoho through the browser, and verifies its work. This project turns that ad-hoc, chat-driven process into a proper, repeatable, team-friendly product.

## 3. What it does (the experience)

1. A team member opens the web app and picks or types what they want: *"Schedule these draft emails to these contacts on Monday at 8 PM,"* or *"Change the owner of the Unbound 100 accounts to Linda,"* or *"Set Next Step to 2nd Email for the KD Blitz deals."*
2. They attach a file if needed (a batch list, an email-drafts document).
3. The app understands the request, pulls the matching records and rules from its database, and shows a **preview**: every record it will touch, the exact change, and any rows it will skip or flag.
4. The person reviews and **approves**.
5. The app carries out each action inside that person's own Zoho login, **verifies** each one actually happened, and produces a report: what succeeded, what was skipped, what failed and why — with links back to the Zoho records.

The guiding principle: **the human stays in control.** Nothing happens without a preview and an explicit approval, nothing is deleted, and no email is ever sent immediately (they're scheduled).

## 4. Who uses it

A small internal team (2–4 people) who already work inside Zoho. Three roles:

- **Admin** — manages workflows and master data, sees all activity, can run sensitive changes.
- **Operator** — runs approved workflows on their own Zoho login, sees their own history.
- **Reviewer** — can look at previews and logs but not execute.

## 5. How it works (plain-English architecture)

Think of it as four cooperating parts:

**The web app** — where people type commands, review previews, approve runs, and read reports. Clean, operational, no clutter.

**The database** — the single source of truth. It holds a clean copy of our Zoho records (accounts, contacts, deals), the definitions of every workflow, and a full log of every run. This replaces the scattered spreadsheets we relied on before.

**The "brain"** — an AI layer that does exactly one narrow job: translate a person's typed command plus any attached file into a precise, structured plan. It never touches Zoho and never acts on its own; a separate layer of plain, deterministic rules then checks that plan against reality (does the field exist? is the value allowed? is the email address valid? is this contact opted out?) before anything is shown as "ready."

**The executor** *(next phase)* — a small Chrome extension that runs the approved plan inside the user's own logged-in Zoho tab. It works two ways: through Zoho's own data API for reliable changes (field edits, owner changes, tags), and through the Zoho screen itself for things only the UI can do (composing and scheduling emails). It verifies every action and reports back.

A key design choice: **no Zoho passwords are ever stored.** The tool rides on each user's existing Zoho login, so it can only do what that person is already allowed to do.

## 6. What the agent can do (the building blocks)

Work is broken into small, independent **action blocks** the user can mix and match per run:

- Create a task on a deal / account / contact
- Complete a task
- Update a deal field (Next Step, stage, owner, close date, …)
- Update account or contact fields (phone, title, website, …)
- Change the owner of records (one, or a whole batch)
- Add or remove tags
- Schedule an outreach email (recipient, CC, subject, body, date/time)

Common combinations are saved as **presets** — for example, our "KD Blitz" campaign is one preset that, per deal, creates and completes a "1st Email" task, sets Next Step to "2nd Email," and schedules one email per contact. "Assign book of business" is another: move a set of accounts plus their contacts and deals to a new owner, all verified.

## 7. Safety and trust (built in, not bolted on)

- **Preview + approval required** for anything that changes Zoho.
- **Dry-run mode** validates a batch and shows the plan without changing anything.
- **Duplicate protection** — checks before creating or scheduling.
- **Stop conditions** — the run halts and asks if a record doesn't match, data is missing, or too many rows fail.
- **Verify after every action** — the tool re-reads Zoho to confirm the change landed, and records before/after values.
- **No destructive actions** in the first version — no deletions, no immediate sends, no bulk overwrites without review.
- **Full audit log** — who ran what, on which record, what changed, when, and whether it verified.
- **Per-user AI credentials, encrypted** — each person connects their own OpenAI/ChatGPT access; secrets are encrypted and never shared.

## 8. Technology (for the technically curious)

- **Web app + backend:** Next.js, hosted on Vercel.
- **Database, login, file storage:** Supabase (PostgreSQL) with row-level security so people only see what they should.
- **AI layer:** pluggable — each user connects their own ChatGPT subscription or OpenAI API key; the model only produces the plan, never executes.
- **Zoho execution:** a Chrome extension using the user's live session (Zoho's data API where possible, the Zoho UI where necessary).

## 9. Where the project stands (as of 2026-07-04)

**Done:**

- **Foundation** — the web app, secure login with roles, and the database are live. Our full book of business is loaded and cross-linked: **315 accounts, 833 contacts, 179 deals**, plus every Zoho field definition for validation.
- **The command → preview pipeline** — a user can connect their own AI credential (three ways: ChatGPT device-code login, pasting their Codex credential, or an OpenAI API key), type a command, attach a file, and get a fully validated preview showing exactly what would happen. This is real and working — and deliberately makes **zero** changes to Zoho yet.

**Next:**

- **Live execution** — the Chrome extension that turns an approved preview into real, verified Zoho actions (starting with the safest: updating a deal's Next Step).
- **Email scheduling** — the full campaign flow end-to-end.
- **Team rollout** — onboarding the other users, deploying for shared access, and adding admin dashboards for logs and errors.

In short: the "understand it and plan it safely" half is built and working; the "carry it out in Zoho" half is the main work remaining, followed by hardening and rollout.

## 10. Why this approach wins

The tool is valuable precisely because it is **not** a free-form AI that guesses. It knows our specific Zoho workflows, uses our clean data, follows written rules, shows its work before acting, verifies afterward, and keeps a complete record. It removes the repetitive grind while keeping every decision in human hands — which is exactly what makes it safe to hand to the whole team.
