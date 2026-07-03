# Zoho CRM — Accounts Editing Playbook

Self-contained guide for editing **Account** records in the KloudData Zoho CRM org: changing
owner, phone/fax, website, industry, revenue, tags, address, parent account, and any other
field — one at a time or in bulk. It also covers navigating an account's related lists
(Contacts, Deals) to reach child records. Hand this to a fresh chat and it can work end to end.
The shared fundamentals (§1, §6, §7) are repeated in each of the three module playbooks so any
one is enough on its own.

---

## 0. TL;DR decision

- **Any bulk change, or any field edit expressible as data → use the API method (§4).** This is
  how the 44-account owner reassignment in this project was done.
- **Only use the UI (§5) when the user says "click / open / show me".**
- **Always verify after writing (§7).**

---

## 1. Connection & fundamentals (shared)

- Drive the **user's real Chrome** via the `chrome` CLI (Chrome skill). Read
  `/opt/ank1015/agent-skills/catalog/chrome/SKILL.md` first.
- **Org ID**: `890324941`.
- **Tabs are volatile** — id changes and tabs can close between turns. Every time:
  ```bash
  chrome tabs list
  ```
  If none, open one:
  ```bash
  chrome tabs goto <ID> "https://crm.zoho.com/crm/org890324941/tab/Accounts/custom-view/6834250000000087525/list" --wait --wait-until networkIdle --load-timeout 30000
  ```
  (Any CRM page yields the token; a Contacts/Deals list works too.) Re-list to confirm. If eval
  fails with `No tab with given id`, re-list and use the new id.

### 1.1 API session token
```js
const token = document.getElementById('token')?.value;
const headers = {'X-ZCSRF-TOKEN':'crmcsrfparam='+token,'X-CRM-ORG':'890324941','X-Requested-With':'XMLHttpRequest'};
const jsonHeaders = {...headers,'Content-Type':'application/json'};   // for writes
```
Run all calls in-page via `chrome tabs eval <id> --file script.js --await-promise`, with
`fetch(url,{credentials:'include',headers})`.
- Read/search base: `https://crm.zoho.com/crm/v3/...`
- Write base (PUT/POST): `https://crm.zoho.com/crm/v2.2/...`

### 1.2 Account URLs and module name
- Account record page: `https://crm.zoho.com/crm/org890324941/tab/Accounts/{accountId}`
- Edit form: `https://crm.zoho.com/crm/org890324941/tab/Accounts/{accountId}/edit?layoutId=...`
- API module name: **`Accounts`**.

### 1.3 Known user IDs
- **Linda Spione** = `6834250000003103001`. Others via `Owner.id` on an owned record or
  `GET /crm/v3/users?type=AllUsers&per_page=200`.

### 1.4 Big loops
Fetching contacts/deals for many accounts, or updating dozens, can exceed the default eval
timeout — add `--eval-timeout 120000 --timeout 140000`. All writes are idempotent; if the tab
drops mid-run, reopen a CRM tab and re-run safely.

---

## 2. Finding account IDs

```
GET /crm/v3/Accounts/search?criteria=(Account_Name:equals:ACCOUNT NAME)&fields=Account_Name,Owner,id&per_page=200
```
- **204** = no match. **Parentheses/special chars break criteria (400 INVALID_QUERY)** — e.g.
  `Otsuka Pharmaceutical Companies (U.S.)`. Fall back to `:starts_with:` a clean prefix and
  filter client-side:
  ```
  criteria=(Account_Name:starts_with:Otsuka)
  ```
- **Fuzzy/first-word fallback** when exact fails: search `starts_with` the first word, then pick
  the record whose normalized name best matches your target.
- **Pagination**: `info.more_records`.

---

## 3. Reading an account & its children

Read fields:
```
GET /crm/v3/Accounts/{id}?fields=Account_Name,Owner,Phone,Website,Industry,Annual_Revenue,Billing_City,Billing_State,Tag
```
Child records (paginate with `info.more_records`, per_page up to 200):
```
GET /crm/v3/Accounts/{id}/Contacts?fields=Full_Name,Title,Email,Phone,Mobile,id
GET /crm/v3/Accounts/{id}/Deals?fields=Deal_Name,Stage,id
```
These endpoints are the fastest way to enumerate everyone/everything under an account (used for
"find all IT contacts in these accounts" and "assign these accounts + their contacts + deals").

---

## 4. Editing accounts via API (primary method)

### 4.1 Change owner (single or bulk)
`PUT /crm/v2.2/Accounts`, body `{data:[{id, Owner:{id: USER_ID}}]}`, **max 100 per call**.
```js
// change-owner-accounts.js
(async () => {
  const OWNER = '6834250000003103001';                 // Linda Spione
  const ids = ["<accountId1>","<accountId2>"];          // fill in
  const token = document.getElementById('token')?.value;
  const headers = {'X-ZCSRF-TOKEN':'crmcsrfparam='+token,'X-CRM-ORG':'890324941','X-Requested-With':'XMLHttpRequest','Content-Type':'application/json'};
  let ok=0, fail=[];
  for (let i=0;i<ids.length;i+=100){
    const chunk = ids.slice(i,i+100).map(id=>({id, Owner:{id:OWNER}}));
    const r = await fetch('https://crm.zoho.com/crm/v2.2/Accounts',{method:'PUT',credentials:'include',headers,body:JSON.stringify({data:chunk})});
    const j = await r.json().catch(()=>({}));
    (j.data||[]).forEach(d=> d.code==='SUCCESS' ? ok++ : fail.push(d));
  }
  return {sent:ids.length, ok, fail:fail.length, fails:fail.slice(0,10)};
})()
```
Note: changing an account's owner via API does **not** cascade to its contacts/deals. To move a
whole book of business, update Accounts, Contacts, and Deals each (see the combined pattern in
§4.4).

### 4.2 Edit any field (single or bulk)
```js
const chunk = ids.map(id => ({
  id,
  Phone: '+1 555 123 4567',
  Website: 'https://example.com',
  Industry: 'Chemical Manufacturing',   // picklist: exact option
  Annual_Revenue: 45000000,             // number
  Billing_City: 'Norfolk',
  Billing_State: 'VA',
  Description: '...',
  Parent_Account: { id: '<parentAccountId>' }  // lookup
}));
// PUT /crm/v2.2/Accounts with {data: chunk}
```

**Common Account field API names**
| Field (UI) | API name | Type |
|---|---|---|
| Account Owner | `Owner` | `{id:userId}` |
| Account Name | `Account_Name` | text |
| Phone / Fax | `Phone` / `Fax` | text |
| Website | `Website` | text |
| Industry | `Industry` | picklist |
| Annual Revenue | `Annual_Revenue` | number |
| Employees | `Employees` | number |
| Account Type | `Account_Type` | picklist |
| Billing address | `Billing_Street`,`Billing_City`,`Billing_State`,`Billing_Code`,`Billing_Country` | text |
| Shipping address | `Shipping_Street`,`Shipping_City`,`Shipping_State`,`Shipping_Code`,`Shipping_Country` | text |
| Parent Account | `Parent_Account` | `{id: accountId}` |
| Description | `Description` | text |
| Tags | `Tag` | via tag actions (§4.3) |

Discover exact names/picklists: `GET /crm/v3/settings/fields?module=Accounts`.

### 4.3 Tags (add / remove)
```js
await fetch(`https://crm.zoho.com/crm/v2.2/Accounts/${id}/actions/add_tags`,
  {method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({tags:[{name:'Unbound 100'}]})});
await fetch(`https://crm.zoho.com/crm/v2.2/Accounts/${id}/actions/remove_tags`,
  {method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({tags:[{name:'Unbound 100'}]})});
```
Bulk: `POST /crm/v2.2/Accounts/actions/add_tags?ids=id1,id2&tag_names=Unbound%20100`.
Verify: `GET /crm/v3/Accounts/{id}?fields=Account_Name,Tag`.

### 4.4 Assign a whole book (account + its contacts + its deals)
Common request: "assign these accounts, their contacts, and their deals to Linda." Steps:
1. Resolve the account ids (§2).
2. For each account, pull child ids: `/Accounts/{id}/Contacts` and `/Accounts/{id}/Deals`.
3. PUT `Owner` in ≤100 chunks to **Accounts**, then **Contacts**, then **Deals**.
4. Verify a sample of each module (or all) via re-read. Report per-module counts (e.g.
   "44 accounts, 205 contacts, 44 deals → all Linda Spione"). Flag accounts with no deal.

---

## 5. Editing accounts via the UI (single record, when asked to "click")

Navigate: `chrome tabs goto <id> "https://crm.zoho.com/crm/org890324941/tab/Accounts/{accountId}" --wait --wait-until networkIdle --load-timeout 30000`, `sleep 3`, screenshot.

### 5.1 Change owner (UI)
**The record's More Options menu ("...", `button.dv_moreBtn`) does NOT contain "Change Owner".**
**Prefer the API method (§4.1) — it is the reliable path.** If you must use the UI, do it from the
**Accounts list view** mass action: tick the target row's grid checkbox (not the filter-panel
checkboxes) → the selection toolbar shows **Change Owner** → in the dialog click **"Select
User"** → type in **"Search Users"** → click the user name (e.g. `Linda Spione`) → leave "Send
Email notification" unchecked and "Transfer Related Items" as-is → click the **"Change Owner"**
button. Wait ~3s, screenshot, verify (§7).

### 5.2 Full edit form
Click **Edit** (top-right) → `/tab/Accounts/{id}/edit?...`. Find the input near the field label,
set with the native setter, click **Save** (`<button>` text `Save`):
```js
const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
```

### 5.3 Navigating related lists (Contacts, Deals, etc.) — gotcha
On the account page, the **Related List** panel entries are list items `li.dv_leftLi` with text
like `Contacts 5`, `Deals 1`, `Notes 5`. Click **that list item**, not the left **sidebar**
module nav (e.g. the sidebar "Contacts"/"Accounts" links navigate away to the global module).
```js
[...document.querySelectorAll('li.dv_leftLi')].find(e=>e.textContent.replace(/\s+/g,' ').trim().startsWith('Contacts')).dispatchEvent(new MouseEvent('click',{bubbles:true}))
```
Inside the Contacts related list, hovering a row (real CDP `mouseMoved`) reveals a **pencil
(Edit)** and **X (remove from account)** just left of the contact name. There are also panel
buttons **Assign / New / Edit** at the top-right of the related list.

### 5.4 Inline edit on the Overview
The account Overview shows fields (Account Owner, Industry, Annual Revenue, Billing City…).
Editable fields support double-click inline edit (double-click the value cell via CDP, type with
native setter, Enter to commit). Clicking the **owner name** only opens a user card — use §5.1 to
actually change owner.

---

## 6. Clicking precisely (CDP) & coordinate scaling (shared)

- **Prefer DOM actions**: `el.dispatchEvent(new MouseEvent('click',{bubbles:true}))` +
  `el.scrollIntoView({block:'center'})`.
- **CDP** for hover-reveal controls, exact-coordinate clicks, Enter-to-commit:
  - Mouse: `Input.dispatchMouseEvent` `mouseMoved` → `mousePressed`/`mouseReleased`
    (`"button":"left","clickCount":1`).
  - Key: `Input.dispatchKeyEvent` `keyDown`/`keyUp` Enter (`windowsVirtualKeyCode:13`).
- **Coordinates**: CDP and `getBoundingClientRect()` use **CSS pixels** — derive coords from the
  rect. **Screenshots are NOT 1:1 with CSS px**: size = CSS px × `window.devicePixelRatio`,
  which **varies** (seen as both 1.0 and 1.5 here). Never hardcode a scale; if mapping from a
  screenshot, compute `scale = screenshotWidth / window.innerWidth`. Prefer the DOM rect.
- **Hover** fires only via a real CDP `mouseMoved` (needed for related-list pencil/X icons).

---

## 7. Verification (never skip)
Re-read and confirm:
```js
for (const id of ids){
  const j = await (await fetch(`https://crm.zoho.com/crm/v3/Accounts/${id}?fields=Account_Name,Owner`,{credentials:'include',headers})).json();
  // confirm Owner.name / the changed field
}
```
- Owner → `Owner.name` equals the target on every record.
- Field edit → equals intended value; count SUCCESS vs failures.
- Tag → `Tag[]` contains the tag.
- For book-of-business moves, verify Accounts + Contacts + Deals separately and report per-module
  counts; note that account-owner changes do **not** auto-cascade to children.

---

## 8. Files & locations
- Working dir: `/workspace/Zoho/Deal | Pdf`
- Scratch: `.codex/tmp/*.js`, `.codex/tmp/*.png`
- Deliverables (CSV lists): cwd, clear names.
- Account URL base: `https://crm.zoho.com/crm/org890324941/tab/Accounts/{accountId}`
