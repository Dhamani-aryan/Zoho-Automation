# Claude Email Draft Template for Zoho Agent Scheduling

Use this file when asking Claude to write batch email drafts. After Claude fills it in, attach the completed Markdown file to the /agent chat with a request like:

Schedule these emails from the attached draft file. Look up each contact/deal/account in Supabase and live Zoho, resolve the direct Zoho links, preserve my signature, apply the listed task changes, ask me for any missing schedule date/time, and schedule-never-send.

## Batch Rules

- Schedule date: TBD
- Schedule time: TBD
- Timezone:
- Send behavior: schedule-never-send
- Preserve existing Zoho signature: yes
- Email format: plain business email, preserve line breaks exactly, keep the existing Zoho signature
- Font rule:
- Body boundary: everything after `Body:` until `New tasks:`, `Closed tasks:`, or the next `--- Contact` heading is the email body
- Direct links: agent must resolve TO_RESOLVE links from the database or live Zoho before scheduling
- Task rule: add the listed new tasks, close only the listed closed tasks, and never delete tasks
- Identity rule: if more than one CRM record matches, stop for that contact and report the ambiguity

## Lookup And Link Fields Claude Should Fill

Claude should include as many of these as it knows. The agent will use them to resolve the exact CRM records.

- Contact name
- Contact email
- Account/company
- Deal name
- Zoho contact link, if already known
- Zoho deal link, if already known
- Zoho account link, if already known
- Direct email scheduling target: deal | contact | account

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
Direct email scheduling target:
CC:
Subject:
Body:
Hi {{first_name}},

Write the email body here.

Best,

New tasks:
- Task:
  Due date:
  Owner:
  Related Zoho link: TO_RESOLVE

Closed tasks:
- Task:
  Related Zoho link: TO_RESOLVE

--- Contact 2 ---
Contact name:
Contact email:
Account/company:
Deal name:
Persona:
Zoho contact link: TO_RESOLVE
Zoho deal link: TO_RESOLVE
Zoho account link: TO_RESOLVE
Direct email scheduling target:
CC:
Subject:
Body:
Hi {{first_name}},

Write the email body here.

Best,

New tasks:
- Task:
  Due date:
  Owner:
  Related Zoho link: TO_RESOLVE

Closed tasks:
- Task:
  Related Zoho link: TO_RESOLVE

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
Direct email scheduling target: deal
CC:
Subject: Cloud ERP follow-up for Example Health
Body:
Hi Jane,

Following up on the Cloud ERP discussion for Example Health. The main point I wanted to send over is how the rollout can stay staged without forcing your finance team to change everything at once.

Would next week be a good time to review the implementation path?

Best,

New tasks:
- Task: Follow up if Jane does not reply
  Due date: 2026-07-18
  Owner: Aryan
  Related Zoho link: TO_RESOLVE

Closed tasks:
- Task: Send first Cloud ERP follow-up
  Related Zoho link: TO_RESOLVE
