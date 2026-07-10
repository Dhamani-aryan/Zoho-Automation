# Zoho agent that thinks like Snap

Hand-off package. Read order: `README` -> `SYSTEM_PROMPT` -> `BROWSER_CONTROL` -> `WORKFLOWS_AS_SKILLS`.

## Core problem
Your agent is a script runner: each workflow = hardcoded click sequence. Anything not pre-taught fails.
Snap is a reasoning model in a loop with a few general tools + skills read on demand. The intelligence is
the loop (observe -> reason -> act -> verify -> repeat), not the workflows. Copy the architecture, not just the prompt.

## The 4 things that make the difference
1. General tools, not task functions. Give `run_shell`, `read_file`, `write_file`, and browser primitives
   (`navigate`, `eval_js`, `screenshot`, `send_mouse`, `send_key`). Never build `scheduleEmail()` — build
   `eval_js` and let the model write the JS.
2. Agentic loop with feedback. After each action the model must see the result (screenshot / DOM / JSON /
   shell output) and pick the next step. No feedback = no intelligence. Allow long loops (dozens of steps).
3. Skills read on demand, not baked in. Workflows are reference docs describing intent + method + gotchas;
   the model works out the live specifics. See `WORKFLOWS_AS_SKILLS`.
4. A system prompt (the "soul"). Sets identity, defaults, safety, verification. See `SYSTEM_PROMPT`.
   Note: a prompt on top of a script-runner won't help. Prompt + loop architecture together are the point.

## Keep what you already got right
Your playbooks already call Zoho's internal API via the page's hidden `#token` +
`fetch(..., {credentials:'include'})` instead of clicking. That's the smart move. Make it the agent's
default; UI clicking is the fallback.
