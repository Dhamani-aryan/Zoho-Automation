# Zoho email composer — chip commit, scheduling, and verification

Answers to three questions, with the recipient-chip mechanics **verified live in the
composer today** (Contacts → Send Email, tested on the Cc field, discarded without sending).
The schedule/verify sections are the working method from the KD Blitz playbook — I did **not**
re-run a real schedule this session (won't schedule a real outreach email just to test), so
treat §1.B/§1.C as the documented method and confirm on one record.

Honesty note: there is no separate "secret" HeySnap composer method. The reliable technique
is the one below; your live failure is almost certainly the leftover-text trap in §1.A.4.

---

## 1.A Committing To/Cc recipient chips  (VERIFIED LIVE TODAY)

### What actually commits a chip — test results

The Cc field is `#ceCCAddr_1`; the committed chips live in `[id^="ceCCAddrDetails"]` as
`li.selectedEmail` with an `email` attribute. To field is `#ceToAddr_1` /
`[id^="ceToAddrDetails"]`. I tested five paths:

| # | Action                                                        | Chip committed? |
|---|---------------------------------------------------------------|-----------------|
| 1 | set `value` via native setter + `input` event, nothing else   | **No** (text sits in the input) |
| 2 | (1) then **CDP** `Enter` while focused                         | **Yes** |
| 3 | (1) then **synthetic** `KeyboardEvent('keydown', Enter)` in JS | **Yes** |
| 4 | (1) then `blur()`                                             | **No** — text orphaned in the field |
| 5 | clear field → focus → **CDP** `insertText` → **CDP** `Enter`  | **Yes** |

**Conclusions:**
- A chip commits only on an **Enter keydown while the input is focused.** Setting the value
  is not enough; `blur`/focus-loss does **not** commit — it orphans the text.
- Both a real CDP `Enter` and a synthetic `KeyboardEvent` Enter work. **Prefer CDP** — it is
  what a real user does and won't be swallowed if the widget checks `isTrusted`.
- **The failure you're seeing:** when a commit doesn't take, the typed text stays in the
  input. The next type **appends** to it (`test3@example.comtest4@…`), which is an invalid
  address, so Enter silently rejects it and no chip forms. One missed commit cascades into
  every following recipient failing. Invalid entries render as a **red chip**.

### The reliable recipe (copy-paste)

```bash
tid=$(cat .codex/tmp/tabid)

# (1) TYPE: clear the field first, focus, set value via the NATIVE setter + input event
cat > .codex/tmp/type_to.js <<'JS'
(() => {
  const el = document.getElementById('ceToAddr_1');          // or ceCCAddr_1
  const p = Object.getPrototypeOf(el), d = Object.getOwnPropertyDescriptor(p, 'value');
  d.set.call(el, '');                                         // clear any leftover
  el.dispatchEvent(new Event('input', {bubbles:true}));
  d.set.call(el, 'recipient@example.com');
  el.dispatchEvent(new Event('input', {bubbles:true}));
  el.focus();                                                 // MUST be focused for Enter
  return {value: el.value, focused: document.activeElement === el};
})()
JS
chrome tabs eval $tid --file .codex/tmp/type_to.js --await-promise    # expect value set + focused:true

# (2) COMMIT: real CDP Enter (do NOT rely on blur)
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}'
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}'

# (3) VERIFY: chip present AND leftover empty AND not a red/invalid chip
cat > .codex/tmp/verify_chip.js <<'JS'
(() => {
  const ul = document.querySelector('[id^="ceToAddrDetails"]');
  const chips = [...ul.querySelectorAll('li.selectedEmail')];
  return {
    committed: chips.map(c => c.getAttribute('email')),
    leftover: document.getElementById('ceToAddr_1').value,          // MUST be ''
    invalid: chips.filter(c => /invalid|error|redBg/i.test(c.className)
                             || getComputedStyle(c).backgroundColor.includes('rgb(2')) // reddish
                   .map(c => c.getAttribute('email')),
  };
})()
JS
chrome tabs eval $tid --file .codex/tmp/verify_chip.js --await-promise
#  GOOD: {committed:[...], leftover:"", invalid:[]}
#  If leftover != "" -> commit failed: clear the field and retry (do NOT type again on top).
```

Alternative to step (1)+(2): **CDP typing**, which is closest to a human and avoids the
native-setter entirely — clear first, focus, then:

```bash
chrome tabs eval $tid '(()=>{const e=document.getElementById("ceToAddr_1");const p=Object.getPrototypeOf(e),d=Object.getOwnPropertyDescriptor(p,"value");d.set.call(e,"");e.dispatchEvent(new Event("input",{bubbles:true}));e.focus();return document.activeElement===e;})()' --await-promise
chrome tabs cdp $tid Input.insertText --params '{"text":"recipient@example.com"}'
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}'
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}'
```

### Chip gotchas (learned live)
- **Always clear the field before typing.** Leftover uncommitted text is the #1 cause of
  cascading recipient failures.
- **Never trust `blur` to commit.** It orphans the text.
- **Verify `leftover === ""` after every commit**, not just "a chip appeared." A red/invalid
  chip plus non-empty leftover means the address was mangled by appending.
- For **multiple Cc addresses**: commit the first (Enter, verify), then clear + type + Enter
  the second. One at a time, verify between each.
- The **Cc input only exists after you reveal it** — click the small `Cc` control first
  (`text === 'Cc'`, width < 60px), then `#ceCCAddr_1` is present.
- To field usually pre-fills the record's contact as a committed chip; clear default chips
  via `li.selectedEmail .closeIconB` if you need a different recipient.

---

## 1.B Setting the schedule date/time  (from playbook; confirm on one record)

Flow: open the Schedule popup → set time → (optionally set date) → confirm "Schedule & Close".

```bash
# open Schedule popup (there are several 'Schedule' nodes; take the last narrow one)
chrome tabs eval $tid '(()=>{const els=[...document.querySelectorAll("span,button,div,a")].filter(e=>(e.textContent||"").trim()==="Schedule"&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().width<160);const t=els[els.length-1];if(!t)return{err:"no schedule"};const r=t.getBoundingClientRect();for(const ev of ["mousedown","mouseup","click"])t.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));return{clicked:true};})()' --await-promise
sleep 2

# TIME: focus the time input (#schTimeMail), then pick the option by its label
chrome tabs eval $tid '(()=>{const t=document.getElementById("schTimeMail");t.scrollIntoView({block:"center"});const r=t.getBoundingClientRect();t.focus();for(const ev of ["mousedown","mouseup","click"])t.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));return{ok:true};})()' --await-promise
sleep 1
# options are ZERO-PADDED: match both "8:00 PM" and "08:00 PM"
chrome tabs eval $tid '(()=>{const targets=["8:00 PM","08:00 PM"];const opt=[...document.querySelectorAll("li,div,span,a")].find(e=>{const t=(e.textContent||"").trim();return targets.includes(t)&&e.getBoundingClientRect().width>0;});if(!opt)return{err:"no opt"};const r=opt.getBoundingClientRect();for(const ev of ["mousedown","mouseup","click"])opt.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));return{picked:opt.textContent.trim(),val:document.getElementById("schTimeMail").value};})()' --await-promise

# DATE (only if different from the popup default): open calendar, map day -> coords, CDP-click the day
chrome tabs eval $tid '(()=>{document.getElementById("startDate").click();return{ok:true};})()' --await-promise
chrome tabs eval $tid '(()=>{const cells=[...document.querySelectorAll("td")].filter(e=>{const t=(e.textContent||"").trim();const r=e.getBoundingClientRect();return /^\d{1,2}$/.test(t)&&r.width>0&&/crmCalendar/.test(e.getAttribute("onclick")||"");});const m={};for(const c of cells){const r=c.getBoundingClientRect();const d=(c.textContent||"").trim();if(!m[d])m[d]={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};}return m;})()' --await-promise
# -> pick the target day's {x,y}, then:
# chrome tabs cdp $tid Input.dispatchMouseEvent press+release at that x,y

# CONFIRM
chrome tabs eval $tid '(()=>{const b=[...document.querySelectorAll("button,a,span,div")].find(e=>(e.textContent||"").trim()==="Schedule & Close"&&e.getBoundingClientRect().width>0);if(!b)return{err:"no btn"};const r=b.getBoundingClientRect();for(const ev of ["mousedown","mouseup","click"])b.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));return{clicked:true};})()' --await-promise
```

Gotchas: time labels are **zero-padded**; confirm `#schTimeMail.value` in the returned JSON;
post-midnight times (12:00 AM/12:30 AM/1:00 AM) roll to the **next calendar day**; always
confirm the **live CRM date** first, don't assume "today".

---

## 1.C Verifying in the Scheduled tab

Two levels; do both:

1. **Immediate toast** — after "Schedule & Close", screenshot and confirm the green
   "Your mail has been scheduled successfully." Then screenshot the composer area / the
   record's **Emails related list → Scheduled** tab and confirm a row exists.

```bash
chrome tabs screenshot $tid .codex/tmp/sched.png --overwrite
```

2. **Durable artifact (preferred, cheap)** — verify the scheduled email as a record, not by
   staring at the page. Read the record's Emails/Scheduled related list and assert
   `recipient`, `subject`, and `scheduled_time` match. Pattern:

```bash
chrome tabs eval $tid '(()=>{
  const rows=[...document.querySelectorAll("[data-recordid],tr,li")].filter(r=>/scheduled/i.test(r.textContent));
  return rows.slice(0,10).map(r=>r.textContent.replace(/\s+/g," ").trim());
})()' --await-promise
```

If your session exposes the internal API (`#token`), the most reliable check is a GET of the
scheduled-emails endpoint filtered to this record and asserting the fields — one read, no
page scraping. (This mirrors the read-back-by-ID pattern in the verification doc.)

---

## 2. Is "schedule, never send" enforced hard, or only by prompt?

**Only by discipline + verification — there is no hard code lock in this setup.** The safety
comes from: (a) the workflow always drives the **Schedule** control, never **Send**; (b)
verifying the scheduled artifact after; (c) previewing before a batch. Nothing physically
prevents a Send if the wrong element is clicked. If you want a hard guarantee, add one in
your agent: refuse/skip any action whose target text matches `^Send$` in the composer, and
gate the composer so only the Schedule path is reachable.

**Composer traps that can cause an accidental immediate send:**
- The **`Send`** button sits at the bottom-right, near **`Schedule`**. A coordinate-based
  click that's off, or a stale screenshot, can hit Send. Always resolve the button by its
  visible text at click time, never by memorized coords.
- **Keyboard shortcut:** many composers send on **Ctrl+Enter / Cmd+Enter**. I did **not**
  test whether Zoho's composer sends on Ctrl+Enter (won't trigger a real send to find out) —
  treat it as a live risk and **never** send a bare Ctrl/Cmd+Enter in the composer. Note this
  matters because you press plain **Enter** to commit chips: make sure the Enter goes to the
  recipient input, not a state where a modifier is held.
- **Split/primary button:** if `Send` is a split button with a dropdown containing
  `Schedule`, clicking the main body sends. Open the dropdown and pick Schedule explicitly.
- **`Enter` in the To/Cc field is safe** (it commits a chip). `Enter` in the subject/body is
  also not a send. The danger is specifically Send-adjacent clicks and modifier+Enter.
- A **red (invalid) recipient chip** won't stop a Send — it just sends/schedules to the valid
  ones. Verify no red chips before either action.

Recommendation: make "reach Schedule, never Send" a hard rule in the agent, plus verify the
scheduled artifact exists (and that no "sent" state appears) as the success condition.

---

## 3. Loop limits and tool-call cost

I don't run against a fixed, quotable max-turn / wall-clock number that I can print here; the
operating reality is a **long, feedback-driven loop** — I keep calling tools and reading each
real result until the task is done or I hit a genuine blocker, and I don't stop mid-task while
work I started is still running. There's no small step cap; if there were, batch work like the
15-owner change earlier couldn't finish in one turn. So the honest answer to "what limits":
effectively bounded by task completion and safety gates (preview before batch writes), not by
a low turn ceiling.

**Rough tool-call cost for "schedule one email + two tasks"** (create+complete each task, set
any field, compose+commit recipients+schedule the email, verify throughout), based on the
flow above:

| Stage | Approx tool calls |
|---|---|
| Navigate + confirm load | 2 |
| Task 1: open activities → add → task → fill → save → complete → verify | 7-8 |
| Task 2: same | 7-8 |
| Compose: open → fill body → To commit (type+Enter+verify) → Cc commit (reveal+type+Enter+verify) | 8-10 |
| Pre-schedule verify (chips + screenshot) | 2 |
| Schedule: open popup → time → (date) → confirm | 3-5 |
| Post-schedule verify (toast/artifact) | 1-2 |

**Total ≈ 30-37 tool calls**, more if a chip commit needs a retry or a step needs a
re-observe. Each includes reading the real result back, which is what keeps it reliable. Doing
the same purely via the internal `#token` API (where the operation allows it) would cut this
by more than half, because create+read-back is one call each and there's no chip/scheduling
UI to drive.

---

## Cleanup note
The live chip test left one **draft** in Aryan's mailbox (To: Christopher Lyle; Cc: a few
`testN@example.com`, no subject/body). It was never sent or scheduled. Delete it from Drafts
if you want a clean mailbox.
