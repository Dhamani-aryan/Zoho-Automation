# Workflow Spec: KD Blitz Email Scheduling

Source: `KD Blitz Email Scheduling Playbook (1).md` (proven across 3+ batches with HeySnap)
Spec version: 0.1 (Phase 0 draft — review and correct)
Slug: `kd_blitz_email_scheduling`

---

## 1. Purpose

For a batch of Zoho deals (Potentials), per deal: create + complete a "1st Email" task and set Next Step = "2nd Email"; then per contact on that deal: compose a personalized outreach email and **schedule** it (never send).

**Structural decision (confirmed by Aryan):** this playbook is decomposed into independent, user-selectable **action blocks**:
`create_task` → `complete_task` → `update_deal_field (Next Step)` → `schedule_email` (×N contacts).

The user toggles which blocks to include in any run. "KD Blitz" is simply a saved preset that enables all four in this order. Each block is specced, validated, verified, and reported independently — a run may use any subset (e.g., Schedule Email only).

## 2. Inputs

### Batch input (per run)
| Input | Source | Required |
|---|---|---|
| Drafts file | MD upload — one section per contact: name, company, persona, title, email, deal URL, schedule date/time, 3 subject options, body ending at "Best," | Yes |
| Deal links CSV | `account, deal_url` — cross-check against drafts file | No (backup) |

### Run parameters (change between batches → always confirmed in preview, never assumed)
| Parameter | Recent default | Rule |
|---|---|---|
| CC address(es) | `ankur@klouddata.com` only | Has changed between batches — must be confirmed each run |
| Schedule date | — | Verified against the **live CRM clock**, not assumed "today" |
| Schedule time | 8:00 PM, same for whole batch | Confirm |
| Sender | Aryan Dhamani `<aryan@klouddata.com>` | The logged-in compose identity |
| Task due date | Same as schedule date | Confirm |

## 3. Hard rules

1. Subject = **first** subject option from the drafts file, always.
2. Body starts immediately with "Hi {FirstName}" — **no leading blank line**, no comma after the name.
3. Two blank lines between "Best," and the signature block.
4. Body font: Verdana 13.33px (matches Zoho signature).
5. Keep the existing Zoho signature (`#ecw_signature`) — insert body above it, never delete it.
6. Per deal exactly once: task create → complete → Next Step = "2nd Email".
7. **Never change the deal stage.**
8. **Schedule, never send.**
9. Post-midnight rollover: 12:00 AM–1:00 AM times roll to the next calendar day.
10. Skip contacts flagged STOP / missing email / missing deal URL.

## 4. Validations (before preview)

- Drafts file parses: every contact section has name, email, deal URL, date, time, ≥1 subject, body ending "Best,".
- Email addresses well-formed.
- Deal URLs match `https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}`.
- Drafts deal URLs cross-check against deal links CSV (if provided) — mismatch = warning.
- Schedule date/time valid and in the future per live CRM clock.
- Duplicate check: no already-scheduled email to same recipient for same deal (run history + Zoho check).
- Run parameters (CC, date, time, due date) explicitly confirmed by user.

## 5. Execution steps

### Per deal (once)
1. `open_url` deal URL → wait until page title ≠ "Zoho CRM" (loaded).
2. **Identity check:** confirm deal/account matches expected before any action.
3. Open Activities → Add New → Task.
4. Fill subject `1st Email` + due date → Save.
5. Mark task complete (retry once if icon not rendered yet).
6. Verify: "Closed Activities" shows a count (e.g. `Closed Activities 1`). No count = completion didn't take → retry.
7. Set Next Step: double-click value cell → type `2nd Email` → Enter to commit.
8. Verify: Next Step reads `2nd Email`.

### Per contact (each contact on the deal)
9. Open Compose Email.
10. Clear default To chips; set recipient, subject (option 1); insert body above signature with required spacing/font; Enter to commit To chip.
11. Reveal Cc field; add CC address(es); Enter per chip.
12. **Verify before scheduling:** read back To/Cc chips + screenshot — correct recipient, CC, subject, "Hi {Name}" at top with no blank line above, two blank lines before intact signature.
13. Open Schedule popup → set time (dropdown labels are zero-padded, match both forms) → set date if different from default → "Schedule & Close".
14. **Verify after:** success toast "Your mail has been scheduled successfully." + email listed in Scheduled tab at the right time. Screenshot as evidence.

## 6. Verification summary (what the system records per record)

| Check | Evidence |
|---|---|
| Task created + completed | Closed Activities count |
| Next Step = "2nd Email" | Field read-back |
| Recipient + CC correct | Chip read-back (`email` attributes) |
| Subject + body format correct | Pre-schedule screenshot |
| Email scheduled at right time | Success toast + Scheduled tab, post-schedule screenshot |

## 7. Stop conditions

- Deal page loads wrong record, or contact/account mismatch.
- Missing email, subject, body, deal URL for a contact (skip record; stop run if systematic).
- Duplicate scheduled email found.
- Logged-out session detected.
- Save/complete/schedule verification fails after one retry.
- 3 consecutive failures or >20% failure rate.

## 8. Known failure modes (from real batches → retry logic)

| Failure | Handling |
|---|---|
| Mark-complete icon not found | Page not fully rendered — wait, retry once, re-verify |
| Next Step didn't save | Re-derive value-cell coords, rely on focused element, always Enter to commit |
| Leftover default To chip | Clear `li.selectedEmail` chips before setting recipient; re-check via read-back |
| CC field missing | Cc link must be clicked before the input exists |
| Time not applied | Match zero-padded labels; confirm input value after pick |
| Stale tab | Re-acquire Zoho tab, re-verify title/URL before continuing |
| Wrong date assumption | Always read live CRM date before the run |

## 9. Zoho UI map (feeds the extension's selector config)

Environment: `crm.zoho.com`, org `890324941`. Deal base URL: `https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}`

Key selectors (full list + scripts in the source playbook):
task subject `#task_subject`, due date `#Crm_Tasks_DUEDATE` (format `Jun 22, 2026`), save `#saveCall`, complete `span.markAsCompletedIcon`; compose: To `#ceToAddr_1`, chips `[id^="ceToAddrDetails"] li.selectedEmail`, subject `#ceSubject_1`, Cc `#ceCCAddr_1`, body iframe `#z_editor` → `#editorDiv`, signature `#ecw_signature`; schedule: time `#schTimeMail`, date `#startDate`, confirm = text `Schedule & Close`. Several actions need synthesized mouse events at element coords and real Enter keypresses (chips, inline edit commit) — the extension step vocabulary must support both.

## 10. Output / report

Per record: deal, contact, action, status (success/skipped/failed/needs_review), Zoho URL, verification results, screenshots on failure, error reason. Batch report: totals + downloadable CSV.

## 11. Related capability: draft authoring (separate workflow, later)

Playbook §11 describes authoring the email copy from a raw contact CSV (persona → Email A/B template, subject-line rules, 5-paragraph structure). That is a *content generation* workflow — a good later addition where the LLM drafts and the user approves the drafts file before this scheduling workflow consumes it. Out of scope for the scheduling spec.

---

## Open questions for Aryan

1. ~~Composite vs atomic~~ **Answered:** atomic action blocks, user-selectable per run; "KD Blitz" becomes a saved preset chaining all four.
2. Is org `890324941` / `crm.zoho.com` the only Zoho org all v1 users work in?
3. Task subject "1st Email" and Next Step "2nd Email" — fixed per campaign stage? (e.g., a "2nd email" batch would use task "2nd Email" / Next Step "3rd Email"?) If yes, these become run parameters.
4. Should pre-schedule screenshots be stored for every record, or only failures? (Storage is cheap; recommend every record for audit.)
