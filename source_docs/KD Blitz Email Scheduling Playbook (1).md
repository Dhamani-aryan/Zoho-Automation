# KD Blitz — Zoho CRM Email Scheduling Playbook

This is a complete, self-contained guide for scheduling cold-outreach emails in Zoho
CRM for the KloudData "KD Blitz" campaigns. Hand this file to a fresh chat and it can
run a full batch end to end. It documents the workflow, every DOM selector and button,
the exact helper scripts, and the gotchas learned across three batches.

---

## 1. What you're doing (the big picture)

For each **deal** (a "Potential" record in Zoho), you:

1. Create a task called **"1st Email"**, give it a due date, save it, and mark it complete.
2. Set the deal's **Next Step** field to **"2nd Email"**.
3. For each **contact** on that deal, compose an outreach email (recipient, subject,
   body with signature), CC the right address, and **schedule** it (never send).

A deal can have one or more contacts. The task + Next Step steps happen **once per deal**.
The compose + schedule steps happen **once per contact**.

Emails are always **scheduled**, never sent immediately.

---

## 2. Inputs you need before starting

1. **A drafts file** — markdown with one section per contact. Each section has:
   - Contact name, company, persona (IT / Finance / Leadership), title
   - Email address
   - Deal URL (the Zoho Potential link)
   - Schedule date + time
   - Subject line options (use **option 1** — the first one)
   - The email body (ends at "Best," — the signature is added separately)

2. **A deal links file** (CSV) mapping accounts/deals to their Zoho URLs. The drafts
   file usually embeds the Deal URL per contact too, so the CSV is a backup/cross-check.

3. **Confirm these defaults with the user before running** (they have changed between batches):
   - **CC address(es)** — recent batches used **only `ankur@klouddata.com`**. Earlier
     guidance was two CCs (`prashant.sharma@klouddata.com` + `ankur@klouddata.com`). Ask.
   - **Schedule date** — verify against the live CRM clock (see §4). Don't trust "today"
     assumptions; check the actual date shown in CRM.
   - **Schedule time** — same time for the whole batch in recent runs (e.g., 8:00 PM).
   - **Sender** — Aryan Dhamani `<aryan@klouddata.com>` (the logged-in compose identity).
   - **Task due date** — usually same as the schedule date.

---

## 3. Hard rules (these matter, get them exactly right)

- **Sender**: Aryan Dhamani `<aryan@klouddata.com>`.
- **Subject**: always the **first** subject option from the drafts file.
- **Body spacing** (strict):
  - **No blank line at the top** — the body starts immediately with "Hi {Name}".
  - A **two-line gap** between "Best," and the signature block.
- **Body font**: Verdana, 13.33px (matches the Zoho signature font so it looks native).
- **Signature**: keep the existing Zoho signature (`#ecw_signature`) — insert the body
  *above* it, don't delete it.
- **Per deal, once**: create "1st Email" task → mark complete → set Next Step = "2nd Email".
- **Do NOT change the deal stage.** The playbook history mentions a "Follow-Up" stage, but
  the actual workflow only sets Next Step. Leave stage untouched unless the user says otherwise.
- **Schedule, never send.**
- **Post-midnight rollover** (only relevant if scheduling times cross midnight): times like
  12:00 AM / 12:30 AM / 1:00 AM roll to the **next calendar day**. Not relevant for an 8 PM batch.
- Skip any contact flagged STOP / no email / no deal.

---

## 4. Environment & connection

- You drive the **user's real Chrome** via the `chrome` CLI (the Chrome skill). Read
  `/opt/ank1015/agent-skills/catalog/chrome/SKILL.md` first.
- The tab id changes between sessions. **Always re-list tabs and re-verify** the title/URL
  after navigating. Store the current id in `.codex/tmp/tabid`.

```bash
chrome tabs list                       # find the Zoho CRM tab, grab its id
echo <ID> > .codex/tmp/tabid           # save it
tid=$(cat .codex/tmp/tabid)
```

- Core command shapes used throughout:

```bash
# Navigate and wait
chrome tabs goto $tid "<deal_url>" --wait

# Run a JS file in the page, get JSON back
chrome tabs eval $tid --file .codex/tmp/<script>.js --await-promise

# Low-level mouse/keyboard via CDP (for clicking exact coords or pressing Enter)
chrome tabs cdp $tid Input.dispatchMouseEvent --params '{"type":"mousePressed",...}'
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'

# Screenshot to verify visually (ALWAYS verify before scheduling)
chrome tabs screenshot $tid .codex/tmp/check.png --overwrite
```

**Verify the live date/time**: open CRM, read the clock/date in the UI (or check a date
input's default). Recent run confirmed the real date was Jun 22, 2026, 3:25 PM IST — even
though earlier batches had assumed Jun 19. Don't guess; confirm.

**Deal URL base**: `https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}`

---

## 5. Key DOM selectors (the map)

### Deal page / activities
| Thing | Selector / how to find |
|---|---|
| "Open Activities" related-list link | text match `Open Activities` (visible element) |
| "Add New" button (in activities) | `<button>` with text `Add New` |
| "Task" option in the Add New menu | `<li>`/`<div>` with text `Task` (class contains `robotoRegular` / `fillAspLi`) |
| Task subject input | `#task_subject` |
| Task due date input | `#Crm_Tasks_DUEDATE` (format `Jun 22, 2026`) |
| Save task button | `#saveCall` |
| Mark-complete icon | `span.markAsCompletedIcon` |
| Closed Activities count (sidebar) | text matching `^Closed Activities \d*$` |
| Next Step label | leaf element with text `Next Step` |

### Compose email window
| Thing | Selector |
|---|---|
| Compose Email button | `<button>` text `Compose Email` |
| To input | `#ceToAddr_1` |
| To chips container | `[id^="ceToAddrDetails"]`; chips are `li.selectedEmail`, remove via `.closeIconB` |
| Subject input | `#ceSubject_1` |
| Cc link (reveals Cc field) | small element with text `Cc` (width < 60px) |
| Cc input | `#ceCCAddr_1` |
| Cc chips container | `[id^="ceCCAddrDetails"]` |
| Body editor iframe | `#z_editor` → inside: `#editorDiv` |
| Signature block (inside editor) | `#ecw_signature` |
| Schedule button | element text `Schedule` (width < 160px; take the last match) |
| Time input (schedule popup) | `#schTimeMail` |
| Time dropdown options | `li/div/span/a` with text like `08:00 PM` (zero-padded) |
| Visible schedule date input | `#startDate` |
| (alt date input) | `#bstDate` |
| Calendar day cells | `<td>` with numeric text and `onclick` containing `crmCalendar` |
| Confirm schedule button | element text `Schedule & Close` |

**Time format gotcha**: the dropdown uses zero-padded labels (`09:30 PM`, `08:00 PM`).
The picker scripts match both padded and unpadded to be safe.

---

## 6. The reusable scripts

Drop all of these into `.codex/tmp/`. They're tiny page-eval snippets. The only ones you
edit per run are `filltask.js` (the date) and the per-contact `cN.js` (recipient/subject/body).

### state.js — read tab title/url (load check)
```js
({title: document.title, url: location.href})
```

### openact.js — click "Open Activities"
```js
(() => {
  const items = [...document.querySelectorAll('a,span,div,li')].filter(e => (e.textContent||'').trim() === 'Open Activities');
  const target = items.find(e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0; });
  if (target) { target.scrollIntoView({block:'center'}); target.click(); return {clicked:true}; }
  return {clicked:false, found: items.length};
})()
```

### addnew3.js — click "Add New"
```js
(() => {
  const btn = [...document.querySelectorAll('button')].find(e => (e.textContent||'').trim()==='Add New');
  if(!btn) return {err:'no btn'};
  btn.scrollIntoView({block:'center'});
  const r = btn.getBoundingClientRect();
  const cx = r.x + r.width/2, cy = r.y + r.height/2;
  for (const type of ['mousedown','mouseup','click'])
    btn.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy}));
  return {clicked:true};
})()
```

### clicktask.js — pick "Task" from the Add New menu
```js
(() => {
  const li = [...document.querySelectorAll('li')].find(e => (e.textContent||'').trim()==='Task' && e.className.includes('robotoRegular'));
  const el = li || [...document.querySelectorAll('div')].find(e => (e.textContent||'').trim()==='Task' && e.className.includes('fillAspLi'));
  if(!el) return {err:'no task'};
  const r = el.getBoundingClientRect();
  for (const type of ['mousedown','mouseup','click'])
    el.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window, clientX:r.x+r.width/2, clientY:r.y+r.height/2}));
  return {clicked:true};
})()
```

### filltask.js — set task subject + due date  ← EDIT THE DATE PER RUN
```js
(() => {
  const setNative = (el, val) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, val);
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true}));
  };
  const subj = document.getElementById('task_subject');
  subj.focus(); setNative(subj, '1st Email'); subj.blur();
  const due = document.getElementById('Crm_Tasks_DUEDATE');
  due.focus(); setNative(due, 'Jun 22, 2026'); due.blur();   // <-- change date here
  return {subject: subj.value, due: due.value};
})()
```

### save.js — click Save on the task
```js
(() => {
  const btn = document.getElementById('saveCall');
  if(!btn) return {err:'no save'};
  const r = btn.getBoundingClientRect();
  for (const type of ['mousedown','mouseup','click'])
    btn.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window, clientX:r.x+r.width/2, clientY:r.y+r.height/2}));
  return {clicked:true};
})()
```

### complete.js — mark task complete
```js
(() => {
  const icon=document.querySelector('span.markAsCompletedIcon');
  if(!icon) return {err:'no icon'};
  icon.click();
  return {clicked:true};
})()
```
**Gotcha**: this sometimes returns `{err:'no icon'}` if the page hasn't fully rendered the
new task. Retry after a short wait. Confirm via verify2.js that "Closed Activities" shows a count.

### verify2.js — confirm Closed Activities count + Next Step value
```js
(() => {
  const out={};
  const ca=[...document.querySelectorAll('a,li,div,span')].filter(e=>{
    const t=(e.textContent||'').replace(/\s+/g,' ').trim();
    return /^Closed Activities\s*\d*$/.test(t) && e.getBoundingClientRect().width>0;
  }).map(e=>(e.textContent||'').replace(/\s+/g,' ').trim());
  out.closedActivities = ca.length? ca.sort((a,b)=>a.length-b.length).pop() : null;
  const lbl=[...document.querySelectorAll('*')].find(e=>(e.textContent||'').trim()==='Next Step' && e.children.length===0);
  if(lbl){
    const lr=lbl.getBoundingClientRect();
    const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0 && e.getBoundingClientRect().width>0);
    const cand=leaves.filter(e=>{const r=e.getBoundingClientRect(); return Math.abs(r.y-lr.y)<16 && r.x>lr.x+lr.width-5 && (e.textContent||'').trim() && (e.textContent||'').trim()!=='Next Step';}).sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x);
    out.nextStep = cand.length? cand[0].textContent.trim() : '(value not found)';
  } else out.nextStep='(label not found)';
  return out;
})()
```
A good result looks like: `{"closedActivities":"Closed Activities 1","nextStep":"2nd Email"}`.
If `closedActivities` is just `"Closed Activities"` (no number), the complete step didn't take — re-run complete.js.

### nextdash.js — locate the Next Step value cell, return click coords
```js
(() => {
  const lbl=[...document.querySelectorAll('*')].find(e=>(e.textContent||'').trim()==='Next Step' && e.children.length===0);
  if(!lbl) return {err:'no label'};
  lbl.scrollIntoView({block:'center'});
  const lr=lbl.getBoundingClientRect();
  const lcy=lr.y+lr.height/2;
  const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0 && e.getBoundingClientRect().width>0 && e!==lbl);
  const sameRowRight=leaves.filter(e=>{const r=e.getBoundingClientRect(); return Math.abs((r.y+r.height/2)-lcy)<20 && r.x>lr.x+lr.width;});
  let v=sameRowRight.find(e=>{const t=(e.textContent||'').trim(); return t==='—'||t==='-'||t==='–';});
  if(!v) v=sameRowRight.sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x)[0];
  if(!v) return {err:'no value el'};
  const r=v.getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:(v.textContent||'').trim()};
})()
```
You then **double-click** those coords via CDP to open the inline editor (the deal Overview
dashboard supports inline edit on the Next Step value).

### setnext2.js — type "2nd Email" into the inline editor
```js
(() => {
  const inps=[...document.querySelectorAll('input[type=text],input:not([type]),textarea')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;});
  let inp=document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)? document.activeElement : null;
  if(!inp){ inp = inps.find(e=>Math.abs(e.getBoundingClientRect().y-342)<40 && e.getBoundingClientRect().x>800); }
  if(!inp) return {err:'no input', count:inps.length};
  const p=Object.getPrototypeOf(inp);const d=Object.getOwnPropertyDescriptor(p,'value');
  d.set.call(inp,'2nd Email');
  inp.dispatchEvent(new Event('input',{bubbles:true}));
  inp.dispatchEvent(new Event('change',{bubbles:true}));
  return {val:inp.value, id:inp.id};
})()
```
**Note**: the `y≈342` / `x>800` fallback coords are viewport-specific. They worked at the
recent viewport size. If the input isn't found, rely on `document.activeElement` (the editor
should be focused right after the double-click) or re-derive coords from nextdash.js.

### focusnext.js — focus the Next Step input, then press Enter to commit
```js
(() => { const inp=[...document.querySelectorAll('input')].find(e=>e.value==='2nd Email' && e.getBoundingClientRect().width>0); if(inp){inp.focus(); return {ok:true};} return {err:'no input'}; })()
```
After this, dispatch an Enter keypress via CDP to save.

### click_compose.js — open the compose window
```js
(() => {
  const btns = [...document.querySelectorAll("button")].filter(b => (b.textContent||"").trim() === "Compose Email");
  const target = btns.find(b => { const r=b.getBoundingClientRect(); return r.width>0 && r.height>0; });
  if (target) { target.scrollIntoView({block:"center"}); target.click(); return {clicked:true}; }
  return {clicked:false};
})()
```

### cN.js — per-contact compose script (TEMPLATE — one per contact)
This is the workhorse. It clears any default To chips, sets recipient + subject, and inserts
the body (Verdana 13.33px) **above** the signature with the required spacing (no leading blank,
two blank lines before signature). Replace `EMAIL`, `SUBJECT`, and `BODY` per contact.
```js
(() => {
  const EMAIL='recipient@example.com';
  const SUBJECT='first subject option';
  const BODY=[
    "Hi {FirstName}","",
    "Paragraph one...","",
    "Paragraph two...","",
    "Paragraph three...","",
    "Closing paragraph...","",
    "Best,"
  ];
  const setNative=(el,val)=>{const p=Object.getPrototypeOf(el);const d=Object.getOwnPropertyDescriptor(p,'value');d.set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('keyup',{bubbles:true}));};
  const toUl=document.querySelector('[id^="ceToAddrDetails"]');
  [...toUl.querySelectorAll('li.selectedEmail .closeIconB')].forEach(x=>x.click());   // clear default recipients
  const to=document.getElementById('ceToAddr_1'); to.focus(); setNative(to,EMAIL);
  const subj=document.getElementById('ceSubject_1'); setNative(subj,SUBJECT); subj.dispatchEvent(new Event('change',{bubbles:true}));
  const f=document.getElementById('z_editor'); const doc=f.contentDocument||f.contentWindow.document;
  const ed=doc.getElementById('editorDiv'); const sig=doc.getElementById('ecw_signature');
  const style='font-family: Verdana, Geneva, sans-serif; font-size: 13.33px;';
  const container=doc.createElement('div');
  for(const line of BODY){ const dv=doc.createElement('div'); dv.setAttribute('style',style); if(line==='') dv.innerHTML='<br>'; else dv.textContent=line; container.appendChild(dv); }
  ed.insertBefore(container,sig);
  while(ed.firstChild && ed.firstChild!==container) ed.removeChild(ed.firstChild);   // strip anything above our body
  for(let i=0;i<2;i++){ const dv=doc.createElement('div'); dv.setAttribute('style',style); dv.innerHTML='<br>'; container.appendChild(dv); }  // two blank lines before signature
  ed.dispatchEvent(new Event('input',{bubbles:true}));
  return {subject:subj.value, toVal:to.value};
})()
```

### focusto.js — focus the To field (so a trailing Enter commits the chip)
```js
(() => { const to=document.getElementById('ceToAddr_1'); to.focus(); return {val:to.value}; })()
```
After running, press Enter via CDP to lock the typed address into a chip.

### clickcc.js — reveal the Cc field
```js
(() => { const cc=[...document.querySelectorAll('a,span,div,button')].find(e=>(e.textContent||'').trim()==='Cc' && e.getBoundingClientRect().width>0 && e.getBoundingClientRect().width<60); if(cc){cc.click(); return {clicked:true};} return {clicked:false}; })()
```

### setcc.js — type the CC address  ← EDIT IF CC LIST CHANGES
```js
(() => { const cc=document.getElementById('ceCCAddr_1'); if(!cc) return {err:'no cc input'}; cc.focus(); const p=Object.getPrototypeOf(cc);const d=Object.getOwnPropertyDescriptor(p,'value');d.set.call(cc,'ankur@klouddata.com');cc.dispatchEvent(new Event('input',{bubbles:true})); return {val:cc.value}; })()
```
After running, press Enter via CDP to commit the chip. For **two CCs**, run this for the
first, press Enter, then set the value to the second and press Enter again.

### checkrecip.js — read back the To + Cc chips (verification)
```js
(() => ({to:[...document.querySelector('[id^="ceToAddrDetails"]').querySelectorAll('li.selectedEmail')].map(c=>c.getAttribute('email')), cc: document.querySelector('[id^="ceCCAddrDetails"]')? [...document.querySelector('[id^="ceCCAddrDetails"]').querySelectorAll('li.selectedEmail')].map(c=>c.getAttribute('email')):[]}))()
```

### clicksched.js — open the Schedule popup
```js
(() => {
  const els=[...document.querySelectorAll('span,button,div,a')].filter(e=>(e.textContent||'').trim()==='Schedule' && e.getBoundingClientRect().width>0 && e.getBoundingClientRect().width<160);
  const t=els[els.length-1];
  if(!t) return {err:'no schedule'};
  const r=t.getBoundingClientRect();
  for(const ev of ['mousedown','mouseup','click']) t.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
  return {clicked:true};
})()
```

### opentime.js — focus/open the time input
```js
(() => {
  const t=document.getElementById('schTimeMail');
  t.scrollIntoView({block:'center'});
  const r=t.getBoundingClientRect();
  t.focus();
  for(const ev of ['mousedown','mouseup','click']) t.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
  return {rect:{x:Math.round(r.x),y:Math.round(r.y)}};
})()
```

### pick_800pm.js — choose the 8:00 PM slot (clone + edit text for other times)
```js
(() => {
  const targets=['8:00 PM','08:00 PM'];
  const opt=[...document.querySelectorAll('li,div,span,a')].find(e=>{const t=(e.textContent||'').trim(); return targets.includes(t) && e.getBoundingClientRect().width>0;});
  if(!opt) return {err:'no opt', targets};
  const r=opt.getBoundingClientRect();
  for(const ev of ['mousedown','mouseup','click']) opt.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
  return {picked: opt.textContent.trim(), val: document.getElementById('schTimeMail').value};
})()
```
For a different time, copy this file and change `targets` (e.g. `['9:30 PM','09:30 PM']`).

### schedclose.js — confirm "Schedule & Close"
```js
(() => {
  const b=[...document.querySelectorAll('button,a,span,div')].find(e=>(e.textContent||'').trim()==='Schedule & Close' && e.getBoundingClientRect().width>0);
  if(!b) return {err:'no btn'};
  const r=b.getBoundingClientRect();
  for(const ev of ['mousedown','mouseup','click']) b.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
  return {clicked:true};
})()
```

### Date scripts (only if the schedule date differs from the popup's default)
The schedule popup usually defaults to today/the next valid day. If you must set a specific
date, click `#startDate` to open the calendar, read day-cell coords, then click the day via CDP.

**clickstartdate.js**
```js
(() => { const d=document.getElementById('startDate'); d.click(); return {ok:true}; })()
```
**rectday.js** — map of day-number → click coords
```js
(() => {
  const cells=[...document.querySelectorAll('td')].filter(e=>{
    const t=(e.textContent||'').trim(); const r=e.getBoundingClientRect();
    return /^\d{1,2}$/.test(t) && r.width>0 && r.height>0 && /crmCalendar/.test(e.getAttribute('onclick')||'');
  });
  const map={};
  for(const c of cells){ const r=c.getBoundingClientRect(); const d=(c.textContent||'').trim(); if(!map[d]) map[d]={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; }
  return map;
})()
```
Then: `chrome tabs cdp $tid Input.dispatchMouseEvent` press+release at the chosen day's coords.

---

## 7. The full run, step by step

### Per-deal setup (once per deal)
```bash
tid=$(cat .codex/tmp/tabid)

# 1. Navigate and wait for load
chrome tabs goto $tid "<DEAL_URL>" --wait
for i in $(seq 1 10); do
  t=$(chrome tabs eval $tid --file .codex/tmp/state.js --await-promise 2>/dev/null | jq -r '.title')
  [ "$t" != "Zoho CRM" ] && [ -n "$t" ] && { echo "loaded: $t"; break; }
  sleep 2
done

# 2. Create + complete the "1st Email" task
chrome tabs eval $tid --file .codex/tmp/openact.js  --await-promise; sleep 1
chrome tabs eval $tid --file .codex/tmp/addnew3.js  --await-promise; sleep 1
chrome tabs eval $tid --file .codex/tmp/clicktask.js --await-promise; sleep 2
chrome tabs eval $tid --file .codex/tmp/filltask.js --await-promise; sleep 1   # sets subject + due date
chrome tabs eval $tid --file .codex/tmp/save.js     --await-promise; sleep 4
chrome tabs eval $tid --file .codex/tmp/complete.js --await-promise; sleep 2
# retry complete if needed
ca=$(chrome tabs eval $tid --file .codex/tmp/verify2.js --await-promise 2>/dev/null | jq -r '.closedActivities')
[ "$ca" = "Closed Activities" ] && { chrome tabs eval $tid --file .codex/tmp/complete.js --await-promise; sleep 2; }

# 3. Set Next Step = "2nd Email" (double-click the value, type, Enter)
coords=$(chrome tabs eval $tid --file .codex/tmp/nextdash.js --await-promise 2>/dev/null)
x=$(echo "$coords" | jq -r '.x'); y=$(echo "$coords" | jq -r '.y')
for n in 1 2; do
  chrome tabs cdp $tid Input.dispatchMouseEvent --params "{\"type\":\"mousePressed\",\"x\":$x,\"y\":$y,\"button\":\"left\",\"clickCount\":$n}"
  chrome tabs cdp $tid Input.dispatchMouseEvent --params "{\"type\":\"mouseReleased\",\"x\":$x,\"y\":$y,\"button\":\"left\",\"clickCount\":$n}"
done
sleep 1
chrome tabs eval $tid --file .codex/tmp/setnext2.js  --await-promise
chrome tabs eval $tid --file .codex/tmp/focusnext.js --await-promise
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'
sleep 2

# 4. Verify
chrome tabs eval $tid --file .codex/tmp/verify2.js --await-promise   # expect Closed Activities 1 + 2nd Email
```

### Per-contact compose + schedule (repeat for each contact on the deal)
```bash
# 5. Open compose
chrome tabs eval $tid --file .codex/tmp/click_compose.js --await-promise; sleep 3

# 6. Write cN.js for this contact (recipient, first subject, body) then run it
chrome tabs eval $tid --file .codex/tmp/cN.js --await-promise; sleep 1

# 7. Commit the To chip
chrome tabs eval $tid --file .codex/tmp/focusto.js --await-promise
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'
sleep 1

# 8. Add CC (reveal field, type, Enter)
chrome tabs eval $tid --file .codex/tmp/clickcc.js --await-promise; sleep 1
chrome tabs eval $tid --file .codex/tmp/setcc.js   --await-promise
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'
chrome tabs cdp $tid Input.dispatchKeyEvent --params '{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'
sleep 1

# 9. VERIFY before scheduling — read chips + screenshot, look at it
chrome tabs eval $tid --file .codex/tmp/checkrecip.js --await-promise   # expect right to + cc
chrome tabs screenshot $tid .codex/tmp/check.png --overwrite
#   -> open check.png; confirm To, Cc, subject, "Hi {Name}" at top, no leading blank line

# 10. Schedule: open popup, set time, confirm
chrome tabs eval $tid --file .codex/tmp/clicksched.js  --await-promise; sleep 2
chrome tabs eval $tid --file .codex/tmp/opentime.js    --await-promise; sleep 1
chrome tabs eval $tid --file .codex/tmp/pick_800pm.js  --await-promise; sleep 1
#   (if a specific DATE is needed, do the clickstartdate.js + rectday.js + CDP-click here first)
chrome tabs eval $tid --file .codex/tmp/schedclose.js  --await-promise; sleep 3

# 11. Confirm — screenshot should show "Your mail has been scheduled successfully."
chrome tabs screenshot $tid .codex/tmp/sched.png --overwrite
```

---

## 8. Verification checklist (do not skip)

Per deal:
- [ ] verify2.js returns `Closed Activities 1` and `nextStep: "2nd Email"`.

Per contact, BEFORE clicking Schedule:
- [ ] checkrecip.js shows the correct single recipient and the correct CC(s).
- [ ] Screenshot shows: right subject (first option), body starts at "Hi {Name}" with
      **no blank line above it**, two blank lines before the signature, signature intact.

Per contact, AFTER scheduling:
- [ ] Screenshot shows the green "Your mail has been scheduled successfully." toast, and the
      Scheduled tab lists the email at the right time.

---

## 9. Common failures & fixes

- **`complete.js` → `{err:'no icon'}`**: page not fully loaded. Wait, re-run. Confirm with verify2.js.
- **Next Step didn't save**: the inline input is viewport-position dependent. Make sure the
  double-click landed on the value cell (use fresh coords from nextdash.js), rely on
  `document.activeElement` in setnext2.js, and always press Enter to commit.
- **Wrong recipient / leftover default chip**: cN.js clears `li.selectedEmail` chips first;
  if a default lingers, re-run cN.js or remove via `.closeIconB`.
- **CC missing**: you must click the small `Cc` link first (clickcc.js) before `#ceCCAddr_1`
  exists/visible; then type and press Enter to form the chip.
- **Time not applied**: dropdown labels are zero-padded (`08:00 PM`). The pick script matches
  both forms. Confirm `schTimeMail.value` in the returned JSON.
- **Stale tab id**: if commands fail, `chrome tabs list`, grab the live Zoho tab id, rewrite
  `.codex/tmp/tabid`, and re-verify title/URL.
- **Date assumptions**: always confirm the real current date in CRM; past batches mis-assumed it.

---

## 10. Files & locations

- Working dir: `/workspace/Zoho/Deal | Pdf`
- Scripts: `/workspace/Zoho/Deal | Pdf/.codex/tmp/*.js` (and screenshots there too)
- Drafts (example): `KD Blitz Batch 3 All Contacts Email Drafts.md`
- Deal links (example): `batch3_deal_links.csv`
- Tab id cache: `.codex/tmp/tabid`
- Deal URL base: `https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}`

---

## 11. Writing the email copy (only if no drafts file exists yet)

The scheduling flow above assumes a **drafts file** already exists. In several batches the
drafts were authored first from a raw contact CSV. If you're handed only contacts + deal
links, you must write the copy before you can schedule. Here's the method.

### 11.1 Persona → which email
Each account gets up to two emails, keyed off the contact's **Persona** column:
- **IT / Technical** → **Email A** (operational/technical angle).
- **Finance** → **Email B** (cash/margin angle).
- **Leadership** (GM, VP Ops, President, owner) → use the **Email A** (operational) copy.

So an account with both an IT and a Finance contact gets two distinct emails; an account
with a single leadership contact gets one (Email A style). One email per contact.

### 11.2 Subject lines
- Short, lowercase, 2-4 words, no punctuation. Theme it to the email:
  - Email A (operational): e.g. `the shop-floor systems`, `engineer to order`, `many services, one core`, `grid-scale builds`, `food safety, real-time`.
  - Email B (finance): e.g. `margin by project`, `the manual close`, `where the cash sits`, `many sites, one close`, `cash in long programs`.
- Provide **three** options per contact in the drafts file; **always schedule with option 1**.

### 11.3 Body structure (both A and B): five short paragraphs + "Best,"
1. **Warm open** — name the company and what they do; observe a real situation
   ("I've been following {Company} and your {work}...").
2. **Pain** — the legacy-ERP problem in their context (data a step behind real time;
   workarounds; who carries the load).
3. **Cost / who feels it** — for A: load lands on a lean IT team; for B: working capital
   tied in inventory/WIP, manual close.
4. **The shift** — what a cloud-native ERP (SAP S/4HANA Cloud) changes:
   - A: real-time MRP, configuration, traceability, analytics on live data.
   - B: live margin/visibility, freed working capital, close moving toward same-day.
     (Finance copy may cite a peer proof point, e.g. "freed roughly $1 to 1.5M in working
     capital within a year" — only when appropriate.)
5. **Soft closer** — low-pressure, "a conversation might be more useful than a pitch,"
   plus the ask:
   - A: "We help {industry} manufacturers modernize legacy operations, and I'd welcome a
     brief call or a meeting in your office in June if that's easier."
   - B: "There's no pressing deadline here, just economics worth getting ahead of... I'd
     welcome a brief call, or a meeting in your office in June if that's easier."

Tone: plain, peer-to-peer, specific to their industry, never hype. No bullet lists in the
body. Greeting is "Hi {FirstName}" with **no comma**, matching the existing drafts. Tailor
paragraphs 1-2 to the company's actual products/sector (pull from the CSV's Title/Industry
/Website columns or a quick look).

### 11.4 Signature
The body **ends at "Best,"**. The Zoho compose window already injects the sender's signature
(`#ecw_signature`); the cN.js script inserts the body above it and adds the two blank lines.
Do not type a signature into the body.

### 11.5 Drafts file format to produce
Mirror the existing drafts files exactly so scheduling can read them. Header block, then one
`## Contact N: {Name} / {Company}` section each with: Contact name, Company, Persona, Title,
Email, Deal URL, Schedule date, Schedule time, three Subject options, and the Email body
ending at "Best,". The deal links CSV (`account, deal_url`) supplies the Deal URL per account.

---

## 12. Quick-start prompt for a new chat

> Schedule the KD Blitz emails from `<drafts file>`. Follow
> `KD Blitz Email Scheduling Playbook.md` exactly. CC `ankur@klouddata.com` only,
> sender Aryan Dhamani, first subject option, schedule (don't send) all at `<time>` on
> `<date>` (confirm the date against the CRM clock first). For each deal: create + complete
> a "1st Email" task due `<date>`, set Next Step to "2nd Email", then compose + schedule one
> email per contact. Verify recipient, CC, subject, and body spacing with a screenshot before
> each schedule, and confirm the success toast after.
