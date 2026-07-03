# Zoho CRM — Deals Editing Playbook

Self-contained guide for editing **Deal** records (Zoho calls them "Potentials") in the
KloudData Zoho CRM org: changing owner, tags, stage, amount, close date, next step,
description, lookups, and any other field. Hand this to a fresh chat and it can do the work
end to end. Read this together with the shared fundamentals below — they are repeated in each
of the three module playbooks so any one is enough on its own.

---

## 0. TL;DR decision

- **Any bulk change, or any field edit you can express as data → use the API method (§4).**
  It is fast, reliable, verifiable, and is how every owner/phone/tag change in this project
  was actually done.
- **Only use the UI (§5) when the user explicitly says "click / open / show me", or for a
  one-off visual check.** The UI is slower and position-dependent.
- **Always verify after writing (§7). Never report done without re-reading the records.**

---

## 1. Connection & fundamentals (shared)

- You drive the **user's real Chrome** through the `chrome` CLI (the Chrome skill). Read
  `/opt/ank1015/agent-skills/catalog/chrome/SKILL.md` first.
- **Org ID**: `890324941`. It appears in record URLs as `org890324941` and is sent as the
  `X-CRM-ORG` header on API calls.
- **Tabs are volatile.** The tab id changes between sessions and tabs sometimes close between
  turns. Every time, before doing work:
  ```bash
  chrome tabs list                 # find the Zoho CRM tab and its id
  ```
  If there is no CRM tab, open one (any CRM page works; a list view loads fast):
  ```bash
  chrome tabs goto <ID> "https://crm.zoho.com/crm/org890324941/tab/Potentials/custom-view/6834250000000087545/sheet" --wait --wait-until networkIdle --load-timeout 30000
  ```
  Then re-run `chrome tabs list` to confirm the title/URL. If a `chrome tabs eval` fails with
  `No tab with given id`, re-list and use the new id.

### 1.1 The API session token
Every CRM page has a hidden input `#token`. Read it inside the page; it authorizes same-origin
API calls using the user's existing session (no OAuth needed):
```js
const token = document.getElementById('token')?.value;   // required for every API call
```
Standard headers:
```js
const headers = {
  'X-ZCSRF-TOKEN': 'crmcsrfparam=' + token,
  'X-CRM-ORG': '890324941',
  'X-Requested-With': 'XMLHttpRequest'
};
// add this for writes (PUT/POST with a JSON body):
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
```
All API calls run **inside the page** via `chrome tabs eval <id> --file script.js --await-promise`
using `fetch(url, {credentials:'include', headers})`.

- **Read/search base**: `https://crm.zoho.com/crm/v3/...`
- **Write base (PUT/POST)**: `https://crm.zoho.com/crm/v2.2/...`

### 1.2 Deal URL and module names
- Deal record page: `https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}`
- API module name for deals is **`Deals`** (not "Potentials"), e.g. `/crm/v3/Deals/{id}`.

### 1.3 Known user IDs (owners)
- **Linda Spione** = `6834250000003103001`
To find another user's id: read `Owner` from a record they own (`Owner.id`), or
`GET /crm/v3/users?type=AllUsers&per_page=200` and match by name/email.

### 1.4 Long-running eval timeouts and tab drops
Many sequential API calls (dozens of records) can exceed the default eval timeout. Add
`--eval-timeout 120000 --timeout 140000` for big loops, and batch verification. If the tab
closed mid-run, reopen a CRM tab and re-run — all the write operations here are **idempotent**
(setting owner/field/tag to the same value again is harmless).

---

## 2. Finding deal IDs

Search API (URL-encode the criteria):
```
GET /crm/v3/Deals/search?criteria=(Deal_Name:equals:NAME)&fields=Deal_Name,Account_Name,Stage,Owner,id&per_page=200
```
- By account: `criteria=(Account_Name:equals:ACCOUNT NAME)` — most useful, since deals are
  named `"{Account} | SAP Cloud ERP"`.
- From an account's related deals: `GET /crm/v3/Accounts/{accountId}/Deals?fields=Deal_Name,id&per_page=200`.
- **Empty result returns HTTP 204** (no body) — handle it (treat as "no match").
- **Parentheses / special-char gotcha**: a value like `Otsuka Pharmaceutical Companies (U.S.)`
  breaks criteria with `400 INVALID_QUERY`. Work around it: search `:starts_with:` a clean
  prefix (e.g. `(Deal_Name:starts_with:Otsuka)`) and filter client-side, or search the account
  by a safe token.
- **Multiple matches**: combine — `((First_Name:equals:F)and(Last_Name:equals:L))` style for
  contacts; for deals combine `Deal_Name` + `Account_Name`.
- **Pagination**: response `info.more_records` (boolean) → increment `page`.
- **Counting**: there is no simple COUNT (COQL `COUNT(id)` returns `unsupported column`).
  Paginate the search and count rows.

---

## 3. Reading a deal (for verification or context)
```
GET /crm/v3/Deals/{id}?fields=Deal_Name,Owner,Stage,Amount,Closing_Date,Next_Step,Tag
```
Returns `data[0]`. `Owner` is `{id,name,email}`; `Tag` is `[{name},...]`; lookups like
`Account_Name` are `{id,name}`.

---

## 4. Editing deals via API (primary method)

### 4.1 Change owner (single or bulk)
`PUT /crm/v2.2/Deals`, body `{data:[{id, Owner:{id: USER_ID}}, ...]}`, **max 100 per call**.
```js
// change-owner-deals.js
(async () => {
  const OWNER = '6834250000003103001';                 // Linda Spione
  const ids = ["<dealId1>","<dealId2>"];                // fill in
  const token = document.getElementById('token')?.value;
  const headers = {'X-ZCSRF-TOKEN':'crmcsrfparam='+token,'X-CRM-ORG':'890324941','X-Requested-With':'XMLHttpRequest','Content-Type':'application/json'};
  let ok=0, fail=[];
  for (let i=0;i<ids.length;i+=100){
    const chunk = ids.slice(i,i+100).map(id=>({id, Owner:{id:OWNER}}));
    const r = await fetch('https://crm.zoho.com/crm/v2.2/Deals',{method:'PUT',credentials:'include',headers,body:JSON.stringify({data:chunk})});
    const j = await r.json().catch(()=>({}));
    (j.data||[]).forEach(d=> d.code==='SUCCESS' ? ok++ : fail.push(d));
  }
  return {sent:ids.length, ok, fail:fail.length, fails:fail.slice(0,10)};
})()
```
Note: the API only sets the owner — it does **not** send the "reassignment" email and does
**not** transfer related records (those are extra options that only exist in the UI dialog,
§5.1). That is usually what you want.

### 4.2 Edit any field (single or bulk)
Same shape, swap in the field API names:
```js
const chunk = ids.map(id => ({
  id,
  Stage: 'Follow-Up',            // picklist: exact option text
  Amount: 120000,               // number
  Closing_Date: '2026-10-30',   // date YYYY-MM-DD
  Next_Step: '2nd Email',       // text
  Description: '...',           // multiline text
  Account_Name: { id: '<accountId>' },   // lookup: pass {id}
  Contact_Name: { id: '<contactId>' }    // primary contact lookup
}));
// PUT /crm/v2.2/Deals with {data: chunk}
```

**Common Deal field API names**
| Field (UI) | API name | Type / how to set |
|---|---|---|
| Deal Owner | `Owner` | `{id: userId}` |
| Deal Name | `Deal_Name` | text |
| Stage | `Stage` | picklist (exact option, e.g. `Follow-Up`, `Opportunity`, `Nurture`) |
| Amount | `Amount` | number |
| Closing Date | `Closing_Date` | `YYYY-MM-DD` |
| Next Step | `Next_Step` | text |
| Type | `Type` | picklist (e.g. `New Business`) |
| Lead Source | `Lead_Source` | picklist |
| Probability | `Probability` | number (percent) |
| Description | `Description` | text |
| Account (lookup) | `Account_Name` | `{id: accountId}` |
| Contact (lookup) | `Contact_Name` | `{id: contactId}` |
| Tags | `Tag` | read-only here; use the tag actions in §4.3 |

To discover exact API names/picklist values for custom fields:
`GET /crm/v3/settings/fields?module=Deals` → each field's `api_name`, `data_type`, and
`pick_list_values`.

### 4.3 Tags (add / remove)
Tags are not set through the normal field PUT — use tag actions.
```js
// add a tag to one deal
await fetch(`https://crm.zoho.com/crm/v2.2/Deals/${id}/actions/add_tags`,
  {method:'POST', credentials:'include', headers:jsonHeaders, body: JSON.stringify({tags:[{name:'KD Blitz'}]})});
// remove
await fetch(`https://crm.zoho.com/crm/v2.2/Deals/${id}/actions/remove_tags`,
  {method:'POST', credentials:'include', headers:jsonHeaders, body: JSON.stringify({tags:[{name:'KD Blitz'}]})});
```
Bulk (module-level, many records in one call):
```
POST /crm/v2.2/Deals/actions/add_tags?ids=id1,id2,id3&tag_names=KD%20Blitz
```
Verify: `GET /crm/v3/Deals/{id}?fields=Deal_Name,Tag` → `data[0].Tag` contains `{name:'KD Blitz'}`.

---

## 5. Editing deals via the UI (single record, when asked to "click")

Navigate: `chrome tabs goto <id> "https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}" --wait --wait-until networkIdle --load-timeout 30000`, then `sleep 3` and screenshot to confirm load.

### 5.1 Change owner (UI)
**Important:** the record's More Options button ("...", `button.dv_moreBtn`, aria-label
"More Options") menu does **NOT** contain "Change Owner" — it lists Clone, Share, Delete,
Print Preview, Find and Merge Duplicates, Mail Merge, Run Macro, Customize Business Card,
Organize Deal Details, Add Related List, Review History, Enroll to Cadence, Add Kiosk, etc.
**Prefer the API method (§4.1); it is the verified, reliable way to change owner.**

If you must do it in the UI, use the **list / sheet view** mass action:
1. Open the Deals list/sheet view.
2. Tick the checkbox on the target row(s) — the **grid row** checkboxes, not the filter-panel
   checkboxes (those toggle filters). Screenshot to confirm the row is selected.
3. A selection toolbar appears — choose **Change Owner**.
4. In the dialog: click the **"Select User"** dropdown → type in the **"Search Users"** box →
   click the user name (e.g. `Linda Spione`) → leave **"Send Email notification"** unchecked and
   **"Transfer Related Items"** as-is → click the **"Change Owner"** confirm button.
5. Wait ~3s, screenshot, and verify (§7).

The Change Owner dialog fields (Select User dropdown, Search Users box, user list, optional
Send-Email checkbox, Transfer Related Items dropdown, Change Owner button) are the same once it
opens, regardless of entry point.

### 5.2 Inline-edit a field on the Overview
The deal Overview shows a "Deal Information" block (Deal Owner, Deal Name, Account Name, Type…).
For editable fields, the reliable inline path (used for **Next Step**) is:
- Find the value cell to the right of the field label, **double-click** it via CDP to open the
  inline editor, type with the native setter, then press **Enter** via CDP to commit.
- See the KD Blitz playbook `nextdash.js` / `setnext2.js` for the exact Next Step scripts.
- Note: clicking the **owner name** just opens a user info card — that is NOT how you change
  owner (use §5.1).

### 5.3 Full edit form
Click **Edit** (top-right) → the edit form loads at `/tab/Potentials/{id}/edit?layoutId=...`.
Locate the input near the field's label, set its value with the native setter, then click the
**Save** button (`<button>` with text `Save`). Native setter helper:
```js
const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
```

---

## 6. Clicking precisely (CDP) & coordinate scaling (shared)

- **Prefer DOM actions**: `el.dispatchEvent(new MouseEvent('click',{bubbles:true}))` works for
  most buttons/links, and `element.scrollIntoView({block:'center'})` to bring it into view.
- **CDP mouse/keyboard** is needed for: hover-reveal controls, exact-coordinate clicks, and
  committing inputs with Enter.
  - `chrome tabs cdp <id> Input.dispatchMouseEvent --params '{"type":"mouseMoved","x":X,"y":Y}'`
    then `mousePressed` / `mouseReleased` (add `"button":"left","clickCount":1`).
  - `chrome tabs cdp <id> Input.dispatchKeyEvent --params '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'` then `keyUp`.
- **Coordinate systems**: CDP and `getBoundingClientRect()` both use **CSS pixels** — always
  derive click coords from the element's rect and pass those to CDP. **Screenshots are NOT 1:1
  with CSS pixels**: screenshot size = CSS px × `window.devicePixelRatio`, and that ratio
  **varies** with the window (observed as both **1.0 and 1.5** in this project). Do not hardcode
  a scale. If you must map a point read off a screenshot, first compute
  `scale = screenshotWidth / window.innerWidth` and divide by it. Prefer deriving from the DOM
  rect and skipping screenshots for click math entirely.
- **Hover does not fire from synthetic events**: for controls that only appear on hover, send a
  real CDP `mouseMoved` to the element's CSS coords first, then press/release.

---

## 7. Verification (never skip)
After any write, re-read and confirm:
```js
// verify owners for a list of deal ids
for (const id of ids){
  const j = await (await fetch(`https://crm.zoho.com/crm/v3/Deals/${id}?fields=Deal_Name,Owner`,{credentials:'include',headers})).json();
  // check j.data[0].Owner.name === expected
}
```
- Owner change → `Owner.name` equals the target user on every record.
- Field edit → the field equals the intended value; count SUCCESS vs failures from the PUT.
- Tag → `Tag[]` contains the tag name.
- Report exact counts (e.g. "27/27 deals now Linda Spione"), and call out anything skipped
  (e.g. an account with no deal).

---

## 8. Files & locations
- Working dir: `/workspace/Zoho/Deal | Pdf`
- Scratch scripts + screenshots: `.codex/tmp/*.js`, `.codex/tmp/*.png`
- User-facing deliverables (CSV lists of links, etc.): the cwd, with clear names.
- Deal URL base: `https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}`
