# Claude Email Draft Template for Zoho Agent

Use this file when asking Claude to write email drafts and task updates. After Claude fills it in, attach the completed Markdown file to the /agent chat with a request like:

Schedule these emails from the attached draft file. Look up each contact/deal/account in Supabase and live Zoho, resolve the direct Zoho links, preserve my signature, apply the listed task changes, ask me for any missing schedule date/time, and schedule-never-send.

## Required Fields

- Direct Zoho contact/deal/account links, or `TO_RESOLVE` if Claude does not know them
- Email format
- CC
- Subject
- Body
- New tasks to add
- Closed tasks to mark done
- Optional schedule date/time, if already known

## Agent Handling Notes

- The agent must resolve `TO_RESOLVE` links from Supabase/live Zoho before doing the work.
- The agent should ask for missing schedule date/time only when scheduling is requested and the draft/request does not specify it.
- The agent must schedule-never-send.
- The agent must preserve the existing Zoho signature.
- The agent must add only the listed new tasks, close only the listed closed tasks, and never delete tasks.
- If more than one CRM record matches, the agent should stop for that contact and report the ambiguity.

## Email Format Options

Use one of these, or write a custom format:

- Follow-up
- Intro
- Renewal
- Meeting recap
- Proposal follow-up
- Custom:

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
Schedule date:
Schedule time:
Email format:
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
Schedule date:
Schedule time:
Email format:
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
Schedule date:
Schedule time:
Email format: Follow-up
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
