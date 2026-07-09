# V2 Agent User Guide

## Start

1. Sign in to the web app. The app opens on `/agent`.
2. Open Chrome with a logged-in `https://crm.zoho.com` tab.
3. Open the Zoho Workflow Agent extension options page.
4. Paste your extension token from Settings, set the Backend URL, turn on the checkbox, and click Handshake.
5. Keep at least one Zoho CRM tab open while asking for live reads or approved writes.

## Ask

Use `/agent` for normal work. Ask for the record and the change or lookup you want, for example:

- "Get the live Next Step for the Duraco deal."
- "Pull accounts tagged Q3 Prospects into the mirror."
- "Set Next Step to 3rd Email on the Duraco deal."

The agent may search the local mirror first, then read Zoho live through your extension when current data matters.

## Read Source Labels

- "As of last sync" means the answer came from the Supabase mirror.
- "Live in Zoho" means the extension read the current record from your open Zoho session.
- Sync results list inserted, updated, unchanged, and warnings.

## Approve Writes

Zoho writes always show an approval card before anything changes. Read the record name, field, before value, and after value.

- Click Approve only if the card exactly matches your intent.
- Click Reject if the record or value is wrong.
- A card expires after 15 minutes. Ask again if it expires.

The extension verifies writes by reading the record back. Do not treat a write as done until the chat reports the verified tool result.

## Stops

The agent stops instead of guessing when it sees a mismatch, missing Zoho login, expired approval, failed verification, unsupported action, or tool budget limit. Read the visible message, fix the condition if needed, then ask again.

Common fixes:

- Extension offline: open the extension options page, enable it, click Handshake, and keep a Zoho tab open.
- Zoho logged out: sign back in on `crm.zoho.com`.
- Approval expired: send the request again and approve the new card.
- Wrong record warning: reject the card and clarify the record.

## Batch Presets

The old batch pipeline still exists for presets. Use `/runs` to inspect saved runs. `/run/new` still works by direct route, but it is no longer the primary entry point.
