# Claude Email Draft Template for Zoho Agent Scheduling

Use this file when asking Claude to write batch email drafts. After Claude fills it in, attach the completed Markdown file to the /agent chat with a request like:

Schedule these emails from the attached draft file. Look up each contact/deal/account in Supabase and live Zoho, resolve the direct Zoho links, preserve my signature, ask me only for the TBD schedule date, and schedule-never-send.

## Header Rules

- Schedule date: TBD
- Schedule time: 9:00 AM contact local time
- Timezone fallback: America/New_York
- Send behavior: schedule-never-send
- Preserve existing Zoho signature: yes
- Font rule: Verdana, 10pt or Zoho equivalent
- First subject rule: use the first non-empty Subject line in each contact section
- CC: none unless a contact section says otherwise
- Body boundary: everything after `Body:` until the next `--- Contact` heading is the email body
- Direct links: agent must resolve missing Zoho links from the database or live Zoho before scheduling
- Identity rule: if more than one CRM record matches, stop for that contact and report the ambiguity

## Lookup Fields Claude Should Fill

Claude should include as many of these as it knows. The agent will use them to resolve the exact CRM records.

- Contact name
- Contact email
- Account/company
- Deal name
- Zoho contact link, if already known
- Zoho deal link, if already known
- Zoho account link, if already known

## Output Format

--- Contact 1 ---
Contact name:
Contact email:
Account/company:
Deal name:
Persona:
Zoho contact link: TO_RESOLVE
Zoho deal link: TO_RESOLVE
Zoho account link: TO_RESOLVE
CC:
Subject:
Body:
Hi {{first_name}},

Write the email body here.

Best,

--- Contact 2 ---
Contact name:
Contact email:
Account/company:
Deal name:
Persona:
Zoho contact link: TO_RESOLVE
Zoho deal link: TO_RESOLVE
Zoho account link: TO_RESOLVE
CC:
Subject:
Body:
Hi {{first_name}},

Write the email body here.

Best,

## Filled Example

--- Contact 1 ---
Contact name: Jane Doe
Contact email: jane.doe@example.com
Account/company: Example Health
Deal name: Example Health | Cloud ERP
Persona: CFO
Zoho contact link: TO_RESOLVE
Zoho deal link: TO_RESOLVE
Zoho account link: TO_RESOLVE
CC:
Subject: Cloud ERP follow-up for Example Health
Body:
Hi Jane,

Following up on the Cloud ERP discussion for Example Health. The main point I wanted to send over is how the rollout can stay staged without forcing your finance team to change everything at once.

Would next week be a good time to review the implementation path?

Best,
