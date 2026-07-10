# Workflows as skills

Fixes "I have to teach it everything". Treat each workflow as a reference guide read on demand, not a
script. Same as Snap's skills.

## What a skill teaches (only this)
1. Intent — what it does, when to use / not use.
2. Reliable method — the preferred technique (Zoho: the internal-API pattern) with exact endpoints,
   module/field API names, picklists. Be precise here; it doesn't move.
3. Gotchas — the hard-won traps (204 on empty search, parens break criteria, volatile tabs, DPR scaling,
   "Change Owner" not in the record More menu). Gold.
4. Verification + stop conditions.

NOT a rigid "click #x then #y" as the only path — layouts change and it breaks. Mention selectors as hints
("value cell right of the Next Step label") but confirm against the live DOM each time. Your existing
playbooks in `../Deal | Pdf/workflows/` are already close (Deals especially). Only shift: the agent treats
them as guides, driven by the system prompt telling it to adapt.

## Layout
```
workflows/
  zoho-facts.md          # org id, module map, known user ids, base URLs (read first)
  deals-editing.md
  contacts-editing.md
  accounts-editing.md
  email-scheduling.md
  task-create-complete.md
  _template.md
```
Keep a tiny index mapping intents -> files so the agent routes cheaply, then reads the relevant ones.

## Template (_template.md)
```markdown
# <Workflow name>
## Intent          what it does; when to use / not
## Preconditions   what must be true first
## Method (preferred)  reliable technique; for Zoho the #token API calls, exact endpoints + field/picklist
                       names; copy-paste JS
## Method (UI fallback) only if UI-only; describe by intent + landmarks, not brittle selectors; note where
                        raw CDP mouse/keyboard is needed
## Gotchas         specific traps
## Verification    exact read-back that proves success; what to report
## Stop conditions when to stop and ask
## Output          run log / artifact to save
```

## Teach a new workflow (two modes)
Mode 1 — learn by doing, then write the skill (the Snap way; removes most manual teaching):
1. User gives a new task in plain language.
2. No matching workflow -> reason from first principles with the general tools: probe the API
   (`GET /crm/v3/settings/fields`) / inspect the page, do it on ONE record, verify.
3. Once it works, draft a new workflow file from `_template.md` (method, discovered field names, gotchas hit,
   verification used).
4. Show draft for approve/edit, save to `workflows/`.
5. Next time it loads by name and runs fast.
Enable via: general tools, allow exploration in the loop, prompt it to propose saving a skill after novel work.

Mode 2 — teach explicitly (human defines it):
1. User describes the workflow / points at a manual process.
2. Agent turns it into a `_template.md` file, asking targeted questions for gaps (inputs, duplicate rule,
   stop conditions, success proof).
3. Optional dry run on one record, then save.

Both write the same artifact. In a productized version these are rows in your `workflows` table; the markdown
body maps to execution_steps / validation_rules / verification_rules / stop_conditions.

## Why this beats the current approach
- No pre-written step per situation; agent reads intent+method+gotchas and figures out live specifics.
  Layout changes stop breaking it.
- New workflows are cheap (learn by doing once, reuse).
- Knowledge compounds in one place (workflow files), not in your head or fragile scripts.
- Control stays where it matters: previews, approvals, stop conditions, no destructive actions — enforced by
  the system prompt regardless of workflow.
