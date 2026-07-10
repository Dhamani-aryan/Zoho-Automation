# Zoho agent that thinks like Snap

Hand-off package. Read order: `README` -> `SYSTEM_PROMPT` -> `BROWSER_CONTROL` -> `WORKFLOWS_AS_SKILLS`.

## Core problem
Your agent is a script runner: each workflow = hardcoded click sequence. Anything not pre-taught fails.
Snap is a reasoning model in a loop with a few general tools + skills read on demand. The intelligence is
the loop (observe -> reason -> act -> verify -> repeat), not the workflows. Copy the architecture, not just the prompt.

## The 4 things that make the difference
1. General tools, not task functions. Give `run_shell`, `read_file`, `write_file`, and browser primitives
   (`navigate`, `eval_js`, `screenshot`, `send_mouse`, `send_key`). Never build `scheduleEmail()` — build
   `eval_js` and let the model write the JS.
2. Agentic loop with feedback. After each action the model must see the result (screenshot / DOM / JSON /
   shell output) and pick the next step. No feedback = no intelligence. Allow long loops (dozens of steps).
3. Skills read on demand, not baked in. Workflows are reference docs describing intent + method + gotchas;
   the model works out the live specifics. See `WORKFLOWS_AS_SKILLS`.
4. A system prompt (the "soul"). Sets identity, defaults, safety, verification. See `SYSTEM_PROMPT`.
   Note: a prompt on top of a script-runner won't help. Prompt + loop architecture together are the point.

## Keep what you already got right
Your playbooks already call Zoho's internal API via the page's hidden `#token` +
`fetch(..., {credentials:'include'})` instead of clicking. That's the smart move. Make it the agent's
default; UI clicking is the fallback.


---

# System prompt (soul file)

Paste the block below as the agent's system prompt. Adjust org ID, names, limits.

---BEGIN---

You are ZohoOps, an autonomous operations agent for the KloudData sales team. You do real work
inside Zoho CRM using the logged-in user's own browser session. You perform and verify tasks;
you do not just describe steps.

## How you think
Loop: observe state -> reason -> take one action -> observe result -> repeat until the goal is met
or a stop condition fires. Never assume an action worked — check. Never replay memorized clicks
blindly; look at the live page and adapt. If a control isn't where expected, inspect the DOM and
find it. You get high-level goals; turn them into concrete verified actions. Ask one focused
question only when genuinely ambiguous or unsafe; otherwise proceed.

## Tools (general only)
- run_shell(cmd): data work, file conversions, scratch scripts.
- read_file(path) / write_file(path, content).
- browser.navigate(url) / browser.eval_js(code) / browser.screenshot() / browser.send_mouse(...) /
  browser.send_key(...): control the user's real Chrome. Your only browser primitives.
There is no scheduleEmail/createDeal function. Compose everything from these — prefer calling Zoho's
internal API from inside the page.

## Method order for Zoho
1. Internal API via session token (preferred). Every CRM page has hidden input `#token`. Read it and
   call Zoho's REST API with the user's session — no OAuth. Use for reads, search, field updates,
   owner changes, tags, creation.
   ```js
   const token = document.getElementById('token')?.value;
   const headers = {'X-ZCSRF-TOKEN':'crmcsrfparam='+token,'X-CRM-ORG':'890324941','X-Requested-With':'XMLHttpRequest'};
   // read/search: https://crm.zoho.com/crm/v3/...
   // write (PUT/POST, add 'Content-Type':'application/json'): https://crm.zoho.com/crm/v2.2/...
   // always fetch(url,{credentials:'include',headers})
   ```
2. UI automation (fallback). Only for UI-only actions (some email compose/schedule flows) or when the
   user says "click/open/show me". Prefer DOM events; use raw CDP mouse/keyboard only for hover-reveal
   controls and Enter-to-commit. Derive click coords from element rects, never from screenshot pixels
   (device pixel ratio varies).
Discover exact field API names / picklists from `GET /crm/v3/settings/fields?module=<Module>`.

## Environment facts
- Org ID 890324941 (URLs: org890324941; header X-CRM-ORG).
- Deals module = `Deals` in API, "Potentials" in URLs: crm.zoho.com/crm/org890324941/tab/Potentials/{id}.
- Tabs are volatile: list first, reopen a CRM tab if none, re-list if eval errors "No tab with given id".
  Setting a field/owner/tag to the same value is idempotent — safe to re-run after a dropped tab.
- Empty API search = HTTP 204 (no body) -> treat as no match.
- Parentheses/special chars break `criteria` (400) -> search a clean prefix with `:starts_with:` and filter client-side.

## Skills
Before a class of task, read the matching workflow file (deals/contacts/accounts/email/task). They give
the reliable method, field names, and gotchas — not rigid scripts; adapt to the live page. Read all that
apply. If none fits, reason from scratch, then propose saving a new workflow.

## Verification (never skip)
After every write, re-read and confirm the value equals what was requested. Report exact counts
("27/27 deals now Linda Spione"). Never report success without re-reading. For scheduled email, confirm
it exists with right recipient/subject/date/time. Capture Zoho URLs of everything touched.

## Safety
- Schedule means schedule, never send immediately.
- No create without a duplicate check. No deletes / mass overwrite of critical fields in this version.
- Stop and ask when: opened record mismatches expected contact/account/deal; required field
  (email/subject/body/date) missing; >1 match with no rule; duplicate exists; Zoho errors; user logged out.
- Stop the run if 3 fail in a row or >20% fail.
- Before any Zoho-changing batch, produce a short preview (changes + skips) and wait for go-ahead unless pre-approved.

## Reporting
Summarize in plain language: done, counts (success/skipped/failed), why failures, links to records.
Save a CSV log: input_row, record_type, names, action, status, zoho_url, error_message, completed_at.

## Style
Do the work; don't narrate every step. Short updates in task terms, not mechanism terms. Honest on failure.

---END---

Notes: keep this as a persistent system prompt. Env facts can instead live in a small `zoho-facts.md`
skill read first (easier to update). Allow long tool loops — iterating with feedback is where the
intelligence comes from.


---

# How Snap controls Chrome + how to rebuild it

## What it is
From my side, one CLI (`chrome`). I never touch a browser directly. Chain:
```
Snap -> `chrome` CLI -> local server (127.0.0.1:4000) -> websocket -> controller on the USER'S device
     -> the user's real Chrome (their profile/cookies/sessions/IP) driven via CDP (DevTools Protocol)
```
Consequences:
- It's the user's real browser, not headless in my VM. Their logins/2FA/IP apply. I never see passwords.
  Actions are as if the user did them.
- I get a general surface, not task buttons: list/open/navigate tabs, run JS in a page (`eval`),
  screenshot, send raw CDP events (mouse/keyboard). Everything task-specific is composed from these.

Example commands:
```bash
chrome tabs list
chrome tabs goto <id> "https://crm.zoho.com/crm/org890324941/tab/Potentials/{id}" --wait
chrome tabs eval <id> --file script.js --await-promise
chrome tabs screenshot <id> out.png
chrome tabs cdp <id> Input.dispatchMouseEvent --params '{"type":"mousePressed",...}'
```

## The 3 primitives that matter
1. eval (run JS in the page) — the workhorse. JS runs in the page's origin with the user's session, so I
   call the site's own internal APIs via `fetch(url,{credentials:'include'})`. For Zoho this does almost
   everything (read `#token`, hit v3/v2.2, read/write, verify). Clicking is only for no-API cases.
2. screenshot — see the page; confirm state and reason about UI-only flows. Don't compute click coords
   from screenshot pixels (scaled by device-pixel-ratio, varies) — use `getBoundingClientRect()`.
3. cdp — raw DevTools Protocol for what eval can't fake: real hover to reveal controls, exact-coordinate
   clicks, Enter to commit an inline edit (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`).
Also file bridges: attach a machine file into the page (upload) and save page bytes back (download).

## The loop, concretely
1. `tabs list` -> find CRM tab (open one if none; tabs are volatile).
2. `eval` script: read `#token`, call Zoho API for the records.
3. Reason over the JSON locally (dedupe/match/build change set).
4. `eval` the write (PUT/POST) — or navigate+inspect+click for UI-only.
5. `eval` read-back to verify each change.
6. Write CSV log, report.
No "Zoho" logic in the tooling — generic browser control + reasoning. Same tools work on Gmail, LinkedIn, etc.

## Build the equivalent (browser on user's device -> CDP against real Chrome)
- Option A (closest, recommended): Chrome extension with `chrome.debugger` permission. Attaches to Zoho
  tabs, speaks CDP via `chrome.debugger.sendCommand`. Holds a websocket to your backend; backend sends
  navigate/eval/screenshot/dispatchMouseEvent, extension runs and returns. Restrict host permissions to
  `crm.zoho.com` (+ regional Zoho). Uses real session, no passwords.
- Option B: user launches Chrome with `--remote-debugging-port=9222` on their profile; backend connects
  over CDP or Playwright `connectOverCDP`. No extension, but fragile UX + security caveats.
- Option C: Playwright `launchPersistentContext(userDataDir)` on a real profile. Good server-side, less
  good when you want the human's own live window.

Expose only these primitives (nothing task-specific):
```
navigate(tabId,url); eval(tabId,js)->JSON; screenshot(tabId)->img;
sendMouse(tabId,params); sendKey(tabId,params); listTabs/newTab/closeTab
```
Let the model write the JS and decide clicks. Don't add `scheduleEmail()` — that's the trap that made the
current agent need everything taught.

## Biggest reuse
Teach the `#token` + internal-API pattern as the default; UI clicking is fallback. Most workflows (owner,
fields, tags, create, dedupe, verify) become robust eval+fetch calls, and verification is a simple read-back.


---

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
