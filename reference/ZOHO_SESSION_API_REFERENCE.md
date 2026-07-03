# Zoho Session API — Shared Technical Reference

Source: Accounts / Contacts / Deals Editing Playbooks (proven in production batches: 44-account owner reassignment, 125-contact phone update, deal owner/tag changes).
Consumers: the Chrome extension (execution) and the backend (validation planning).

---

## 1. What this is

Zoho CRM pages expose a hidden CSRF token that authorizes **same-origin API calls using the user's existing login session** — no OAuth, no passwords, no admin setup. Any code running inside a Zoho CRM tab (our extension's content script) can read records, search, edit fields, change owners, and manage tags reliably.

**Design consequence:** the extension has two execution modes.

| Mode | Used for | Reliability |
|---|---|---|
| **Session API** (primary) | Search, read, verify, field edits, owner changes, tags, duplicate checks, resolving IDs | High — structured JSON in/out |
| **UI automation** (fallback) | Actions with no session-API equivalent: compose + schedule email, task create/complete via UI, anything the user asks to "click" | Lower — selector/timing dependent |

Rule of thumb from the playbooks: *any change expressible as data → API; UI only when required.*

## 2. Environment

- Org ID: `890324941` (in URLs as `org890324941`, sent as `X-CRM-ORG` header).
- Record URL bases:
  - Deals: `https://crm.zoho.com/crm/org890324941/tab/Potentials/{id}` (API module is **`Deals`**, not Potentials)
  - Contacts: `.../tab/Contacts/{id}`
  - Accounts: `.../tab/Accounts/{id}`
- Read/search base: `https://crm.zoho.com/crm/v3/...`
- Write base: `https://crm.zoho.com/crm/v2.2/...`
- Known user ID: Linda Spione = `6834250000003103001`. Others: `GET /crm/v3/users?type=AllUsers&per_page=200`.

## 3. Auth pattern

```js
const token = document.getElementById('token')?.value;   // hidden input on every CRM page
const headers = {
  'X-ZCSRF-TOKEN': 'crmcsrfparam=' + token,
  'X-CRM-ORG': '890324941',
  'X-Requested-With': 'XMLHttpRequest'
};
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };  // for writes
// all calls: fetch(url, { credentials: 'include', headers })
```

## 4. Core operations

### Search / resolve IDs
```
GET /crm/v3/{Module}/search?criteria=(Field:equals:VALUE)&fields=...&per_page=200
```
- Combine: `((First_Name:equals:F)and(Last_Name:equals:L))`
- Account's children: `GET /crm/v3/Accounts/{id}/Contacts` and `/Deals` (fastest way to enumerate)
- **HTTP 204 = no match** (no body) — must be handled.
- **Special chars (parentheses etc.) in values → 400 INVALID_QUERY.** Fallback: `:starts_with:` a clean prefix + filter client-side.
- Pagination: `info.more_records` → increment `page`. No COUNT support — paginate and count.

### Read / verify
```
GET /crm/v3/{Module}/{id}?fields=...
```
`Owner` = `{id,name,email}`; lookups = `{id,name}`; `Tag` = `[{name},...]`.

### Write (fields, owner)
```
PUT /crm/v2.2/{Module}   body: {data:[{id, Field: value, Owner:{id: userId}, ...}]}
```
- **Max 100 records per call** — chunk larger batches.
- Response per record: `code === 'SUCCESS'` — count ok/fail per item.
- **Idempotent** — safe to re-run after interruption.
- Owner change via API does **not** send reassignment email and does **not** cascade to related records (usually desired). Whole book-of-business moves = update Accounts, then Contacts, then Deals explicitly, verify per module.

### Tags
Not settable via field PUT. Use actions:
```
POST /crm/v2.2/{Module}/{id}/actions/add_tags     body {tags:[{name:'X'}]}
POST /crm/v2.2/{Module}/{id}/actions/remove_tags  body {tags:[{name:'X'}]}
POST /crm/v2.2/{Module}/actions/add_tags?ids=id1,id2&tag_names=X   (bulk)
```

### Field metadata discovery
```
GET /crm/v3/settings/fields?module={Module}
```
Returns every field's `api_name`, `data_type`, `pick_list_values` — the system should sync this into the database so validation knows exact picklist options and custom fields.

## 5. Field API name maps (validated)

**Deals:** `Owner` {id}, `Deal_Name`, `Stage` (picklist, e.g. Follow-Up/Opportunity/Nurture), `Amount` (number), `Closing_Date` (YYYY-MM-DD), `Next_Step`, `Type`, `Lead_Source`, `Probability`, `Description`, `Account_Name` {id}, `Contact_Name` {id}.

**Contacts:** `Owner` {id}, `First_Name`, `Last_Name`, `Full_Name` (read-only), `Email`, `Phone`, `Mobile`, `Home_Phone`, `Other_Phone`, `Fax`, `Title`, `Department`, `Account_Name` {id}, `Mailing_Street/City/State/Zip/Country`, `Description`.

**Accounts:** `Owner` {id}, `Account_Name`, `Phone`, `Fax`, `Website`, `Industry` (picklist), `Annual_Revenue`, `Employees`, `Account_Type`, `Billing_*`, `Shipping_*`, `Parent_Account` {id}, `Description`.

Deal naming convention: `"{Account} | SAP Cloud ERP"` — account-based search is often the best resolver.

## 6. UI automation notes (when API can't do it)

- Prefer DOM events (`dispatchEvent` + `scrollIntoView`); use CDP-level input for hover-reveal controls, exact-coordinate clicks, and Enter-to-commit.
- Coordinates: CDP and `getBoundingClientRect()` use CSS pixels. Screenshots are CSS px × `devicePixelRatio` (observed 1.0 **and** 1.5 — never hardcode a scale).
- Hover-reveal controls (related-list pencil/X icons) need real mouse-move events.
- "Change Owner" is **not** in a record's More Options menu — UI path is the list-view mass action. API is the reliable path.
- Related lists on a record are `li.dv_leftLi` items ("Contacts 5") — not the left sidebar module nav.
- Inline edit (e.g. Next Step): double-click value cell → native setter → Enter.
- Long batches: writes are idempotent; on tab loss, reacquire the CRM tab and resume.

## 7. Rules the system inherits

1. Verify after every write by re-reading the record — never report done without read-back.
2. Report exact counts per module ("44 accounts, 205 contacts, 44 deals → all Linda Spione") and list skips with reasons.
3. Chunk ≤100; add generous timeouts for big loops; treat interruptions as resumable.
4. Flag borderline matches (fuzzy name hits, title-keyword noise like "Adjunct Faculty (CIO Program)") for review instead of silently including/excluding.
