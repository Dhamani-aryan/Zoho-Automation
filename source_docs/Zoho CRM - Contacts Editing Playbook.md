# Zoho CRM — Contacts Editing Playbook

Self-contained guide for editing **Contact** records in the KloudData Zoho CRM org: changing
owner, phone/mobile, email, title, tags, account link, address, and any other field — one at a
time or in bulk from a file/list. Hand this to a fresh chat and it can do the work end to end.
The shared fundamentals (§1, §6, §7) are repeated in each of the three module playbooks so any
one is enough on its own.

---

## 0. TL;DR decision

- **Any bulk change, or any field edit expressible as data → use the API method (§4).** This
  is how the 125-contact phone update and the owner reassignments in this project were done.
- **Only use the UI (§5) when the user says "click / open / edit this one / show me".**
- **Always verify after writing (§7).**

---

## 1. Connection & fundamentals (shared)

- Drive the **user's real Chrome** via the `chrome` CLI (Chrome skill). Read
  `/opt/ank1015/agent-skills/catalog/chrome/SKILL.md` first.
- **Org ID**: `890324941`.
- **Tabs are volatile** — the id changes and tabs can close between turns. Every time:
  ```bash
  chrome tabs list                 # find the CRM tab + id
  ```
  If none, open one (a list view loads fast):
  ```bash
  chrome tabs goto <ID> "https://crm.zoho.com/crm/org890324941/tab/Contacts/custom-view/6834250000000087529/list" --wait --wait-until networkIdle --load-timeout 30000
  ```
  Re-list to confirm. If eval fails with `No tab with given id`, re-list and use the new id.

### 1.1 API session token
Every CRM page has a hidden `#token` input; read it in-page to authorize same-origin API calls:
```js
const token = document.getElementById('token')?.value;
const headers = {'X-ZCSRF-TOKEN':'crmcsrfparam='+token,'X-CRM-ORG':'890324941','X-Requested-With':'XMLHttpRequest'};
const jsonHeaders = {...headers,'Content-Type':'application/json'};   // for writes
```
Run all API calls inside the page via `chrome tabs eval <id> --file script.js --await-promise`,
using `fetch(url,{credentials:'include',headers})`.
- Read/search base: `https://crm.zoho.com/crm/v3/...`
- Write base (PUT/POST): `https://crm.zoho.com/crm/v2.2/...`

### 1.2 Contact URLs and module name
- Contact record page: `https://crm.zoho.com/crm/org890324941/tab/Contacts/{contactId}`
- Edit form: `https://crm.zoho.com/crm/org890324941/tab/Contacts/{contactId}/edit?layoutId=...`
- API module name: **`Contacts`**.

### 1.3 Known user IDs
- **Linda Spione** = `6834250000003103001`. Find others via `Owner.id` on a record they own or
  `GET /crm/v3/users?type=AllUsers&per_page=200`.

### 1.4 Big loops
For dozens/hundreds of records add `--eval-timeout 120000 --timeout 140000`. All writes are
idempotent, so if the tab drops mid-run, reopen a CRM tab and re-run safely.

---

## 2. Finding contact IDs

```
GET /crm/v3/Contacts/search?criteria=((First_Name:equals:F)and(Last_Name:equals:L))&fields=Full_Name,First_Name,Last_Name,Account_Name,Title,Email,Phone,Mobile,id&per_page=20
```
- **Fallback** if the exact first+last returns nothing: search `(Last_Name:equals:L)` and filter
  by first name client-side.
- **All contacts of an account**: `GET /crm/v3/Accounts/{accountId}/Contacts?fields=Full_Name,Title,Email,Phone,Mobile,id&per_page=200` (paginate with `info.more_records`).
- **204** = no match. **Parentheses/special chars in a value break criteria (400)** — use
  `:starts_with:` a clean prefix and filter client-side.
- Middle names: e.g. "Pavan Kumar Kanike" → `First_Name = "Pavan Kumar"`, `Last_Name = "Kanike"`.
- Names in CRM may carry credential suffixes (e.g. "Jerome Perkins — MACC, MBA"); match on
  last name + starts-with first name.
- **Counting** owned-by-someone: no simple COUNT (COQL `COUNT(id)` → `unsupported column`);
  paginate `search?criteria=(Owner:equals:USER_ID)` and count.

---

## 2.1 Filtering contacts by role/title (e.g. "the IT contacts")

Common request: "list all the IT contacts in these accounts." Pattern:
1. Resolve account ids (see the Accounts playbook §2), then pull **all** contacts per account:
   `GET /crm/v3/Accounts/{id}/Contacts?fields=Full_Name,Title,Email,Phone,Mobile,id&per_page=200`.
2. Filter by `Title` with a case-insensitive keyword regex. For IT/technology roles, this set
   worked well (this is an SAP-modernization campaign, so SAP/ERP/systems count as IT):
   ```js
   const rx=/\bIT\b|\bI\.T\.|information technology|chief information|\bCIO\b|sap|\bERP\b|enterprise application|business system|data warehouse|\banalytics\b/i;
   const isIT = c => rx.test(c.Title||'');
   ```
   Adjust keywords per request (Finance: `finance|controller|CFO|FP&A|accounting|treasury`;
   Supply chain: `supply chain|procurement|sourcing|purchasing|logistics`).
3. Watch for noise: e.g. "Adjunct Faculty (CIO Program)" matches `CIO` but is an academic title,
   not a company IT role — flag borderline hits rather than silently including/excluding.
4. Deliver as a CSV in the cwd (Account, Contact, Title, Email, Phone, Account Link, Contact
   Link) and report which accounts had **no** IT contact.

---

## 3. Reading a contact
```
GET /crm/v3/Contacts/{id}?fields=Full_Name,Owner,Email,Phone,Mobile,Title,Account_Name,Tag
```
`data[0]` — `Owner`={id,name,email}, `Account_Name`={id,name}, `Tag`=[{name}].

---

## 4. Editing contacts via API (primary method)

### 4.1 Update phone / mobile / any field (single or bulk)
`PUT /crm/v2.2/Contacts`, body `{data:[{id, ...fields}]}`, **max 100 per call**.
```js
// update-contacts.js  — e.g. set Phone/Mobile from a source list
(async () => {
  const data = [
    { id:'<contactId>', Phone:'+1 203-592-5494', Mobile:'+1 203-592-5494' },
    // ... one object per contact, include only the fields you want to change
  ];
  const token = document.getElementById('token')?.value;
  const headers = {'X-ZCSRF-TOKEN':'crmcsrfparam='+token,'X-CRM-ORG':'890324941','X-Requested-With':'XMLHttpRequest','Content-Type':'application/json'};
  let ok=0, fail=[];
  for (let i=0;i<data.length;i+=100){
    const chunk = data.slice(i,i+100);
    const r = await fetch('https://crm.zoho.com/crm/v2.2/Contacts',{method:'PUT',credentials:'include',headers,body:JSON.stringify({data:chunk})});
    const j = await r.json().catch(()=>({}));
    (j.data||[]).forEach(d=> d.code==='SUCCESS' ? ok++ : fail.push(d));
  }
  return {sent:data.length, ok, fail:fail.length, fails:fail.slice(0,10)};
})()
```
**Mapping phone data from a file (learned pattern):** a source file often has separate `Phone`
and `Mobile` columns. Map **file Phone → `Phone` field** and **file Mobile → `Mobile` field**;
include only the ones present. Skip a contact only if it has **no** number at all, and skip rows
with no CRM contact id. Report counts of updated vs skipped.

### 4.2 Change owner (single or bulk)
```js
const chunk = ids.slice(i,i+100).map(id => ({ id, Owner:{ id:'6834250000003103001' } }));
// PUT /crm/v2.2/Contacts with {data: chunk}
```

**Common Contact field API names**
| Field (UI) | API name | Type |
|---|---|---|
| Contact Owner | `Owner` | `{id:userId}` |
| First / Last Name | `First_Name` / `Last_Name` | text |
| Full Name | `Full_Name` | read-only (derived) |
| Email | `Email` | text |
| Phone | `Phone` | text |
| Mobile | `Mobile` | text |
| Home / Other Phone | `Home_Phone` / `Other_Phone` | text |
| Fax | `Fax` | text |
| Title | `Title` | text |
| Department | `Department` | text |
| Account (lookup) | `Account_Name` | `{id: accountId}` |
| Mailing address | `Mailing_Street`,`Mailing_City`,`Mailing_State`,`Mailing_Zip`,`Mailing_Country` | text |
| Description | `Description` | text |
| Tags | `Tag` | via tag actions (§4.3) |

Discover exact names/picklists: `GET /crm/v3/settings/fields?module=Contacts`.

### 4.3 Tags (add / remove)
```js
await fetch(`https://crm.zoho.com/crm/v2.2/Contacts/${id}/actions/add_tags`,
  {method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({tags:[{name:'Unbound 100'}]})});
await fetch(`https://crm.zoho.com/crm/v2.2/Contacts/${id}/actions/remove_tags`,
  {method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({tags:[{name:'Unbound 100'}]})});
```
Bulk: `POST /crm/v2.2/Contacts/actions/add_tags?ids=id1,id2&tag_names=Unbound%20100`.
Verify: `GET /crm/v3/Contacts/{id}?fields=Full_Name,Tag`.

---

## 5. Editing contacts via the UI (single record, when asked to "click")

### 5.1 Open the edit form
Two ways:
- **From the contact page**: navigate to the contact, click **Edit** (top-right).
- **From an account's Contacts related list** (very common): on the account page, open the
  **Contacts** related list (§5.3), **hover a row** to reveal two inline icons just left of the
  contact name — a **pencil (Edit)** and an **X (remove from account)** — and click the pencil.
  Hover must be a real CDP `mouseMoved` (synthetic events don't trigger it). The pencil opens
  `/tab/Contacts/{id}/edit?...`.

### 5.2 Fill a field and save (verified for Phone)
On the edit form, find the input next to the field label, set it, then Save:
```js
// set the Phone field
(function(){
  const lbl=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()==='Phone');
  let inp=lbl; for(let i=0;i<6;i++){inp=inp.parentElement; const c=inp&&inp.querySelector('input'); if(c){inp=c;break;}}
  const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inp),'value');
  d.set.call(inp,'+1 203-592-5494');
  inp.dispatchEvent(new Event('input',{bubbles:true}));
  inp.dispatchEvent(new Event('change',{bubbles:true}));
  return inp.value;
})()
```
Then click Save: `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save' && b.offsetParent).dispatchEvent(new MouseEvent('click',{bubbles:true}))`.
Saving returns you to the previous page; screenshot to confirm, then verify via API (§7).

Field order on the standard Contact edit form (top→down): Contact Owner, First Name, Account
Name, Email, **Phone**, Other Phone, **Mobile**, Layout, Assistant, … Scroll the form
(`el.scrollIntoView({block:'center'})`) to bring a field into view before screenshotting.

### 5.3 Change owner (UI)
**The record's More Options menu ("...", `button.dv_moreBtn`) does NOT contain "Change Owner".**
**Prefer the API method (§4.2) — it is the reliable path.** If you must use the UI, do it from the
**Contacts list view** mass action: tick the target row's grid checkbox → the selection toolbar
shows **Change Owner** → in the dialog click **"Select User"** → type in **"Search Users"** →
click the user name → leave "Send Email notification" unchecked → click **"Change Owner"**.
Verify (§7).

### 5.4 Opening the Contacts related list on an account (gotcha)
The related-list entry is a list item `li.dv_leftLi` whose text is like `Contacts 5` — click
**that**, not the left **sidebar** "Contacts" module nav (which navigates away to the global
Contacts module). Match by text and class:
```js
[...document.querySelectorAll('li.dv_leftLi')].find(e=>e.textContent.replace(/\s+/g,' ').trim().startsWith('Contacts')).dispatchEvent(new MouseEvent('click',{bubbles:true}))
```

---

## 6. Clicking precisely (CDP) & coordinate scaling (shared)

- **Prefer DOM actions**: `el.dispatchEvent(new MouseEvent('click',{bubbles:true}))` +
  `el.scrollIntoView({block:'center'})` for most buttons/links.
- **CDP** for hover-reveal controls, exact-coordinate clicks, and Enter-to-commit:
  - Mouse: `Input.dispatchMouseEvent` with `mouseMoved`, then `mousePressed`/`mouseReleased`
    (`"button":"left","clickCount":1`).
  - Key: `Input.dispatchKeyEvent` `keyDown`/`keyUp` with Enter (`windowsVirtualKeyCode:13`).
- **Coordinates**: CDP and `getBoundingClientRect()` use **CSS pixels** — derive coords from the
  rect and pass to CDP. **Screenshots are NOT 1:1 with CSS px**: size = CSS px ×
  `window.devicePixelRatio`, which **varies** (seen as both 1.0 and 1.5 here). Never hardcode a
  scale; if mapping from a screenshot, compute `scale = screenshotWidth / window.innerWidth`.
  Prefer the DOM rect.
- **Hover** only fires via a real CDP `mouseMoved` to the element's CSS coords (needed for the
  related-list pencil/X icons).

---

## 7. Verification (never skip)
Re-read the records and confirm:
```js
for (const id of ids){
  const j = await (await fetch(`https://crm.zoho.com/crm/v3/Contacts/${id}?fields=Full_Name,Phone,Mobile,Owner`,{credentials:'include',headers})).json();
  // confirm the changed field / Owner.name
}
```
- Phone/Mobile → equals the file value (spot-check a random sample incl. mobile-only cases).
- Owner → `Owner.name` equals the target on every record.
- Tag → `Tag[]` contains the tag.
- Report exact counts and list anything skipped (no number in source, or no CRM id).

---

## 8. Files & locations
- Working dir: `/workspace/Zoho/Deal | Pdf`
- Scratch: `.codex/tmp/*.js`, `.codex/tmp/*.png`
- Deliverables (CSV lists): cwd, clear names.
- Contact URL base: `https://crm.zoho.com/crm/org890324941/tab/Contacts/{contactId}`
