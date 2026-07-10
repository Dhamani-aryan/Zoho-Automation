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
