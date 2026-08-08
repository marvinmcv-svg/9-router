# Running JARVIS on your machine

This is the mode where JARVIS is actually an operating system — it gets a real
filesystem and a real shell, which a serverless deployment cannot give it.

## Three commands

```bash
git clone -b claude/ai-assistant-os-jarvis-y46sy1 https://github.com/marvinmcv-svg/9-router jarvis
cd jarvis && npm install
npm run setup      # asks for your model key and workspace, writes .env.local
npm run dev
```

Then open **http://localhost:3000**. No password needed on localhost in dev.

If you'd rather configure by hand, copy `.env.example` to `.env.local` and set
`JARVIS_PROVIDER`, `JARVIS_API_KEY`, `JARVIS_MODEL` and `JARVIS_WORKSPACE` — or
skip the file entirely and paste your key into the **Model** panel once it's
running.

## Point it at the right workspace

`JARVIS_WORKSPACE` is the directory `fs.*` and `shell.exec` operate on. Set it
to the project you actually want worked on:

```bash
JARVIS_WORKSPACE=/Users/you/code/some-project npm run dev
```

Every model-supplied path is resolved and checked against this root, symlinks
included, so JARVIS cannot read or write outside it. Left unset it defaults to
JARVIS's own source tree — fine for a first look, probably not what you want.

## First five minutes

Start with reads; they run without interrupting you.

1. **"What's in this workspace? Give me the layout."** — exercises `fs.list`.
2. **"Read the kernel's agent loop and explain how approvals work."** —
   `fs.read`, and a check that it's actually reading rather than guessing.
3. **"Run the test suite and tell me what's failing."** — `shell.exec`. This is
   `dangerous`, so you'll get an approval card showing the exact command
   before anything runs. Approve it and watch the output come back.
4. **"Delegate a review of kernel/memory.ts to the engineer agent."** —
   spawns a subagent with its own loop; you get the report, not the reading.
5. **"Remember that I prefer short commit messages."** — a `write`, so it asks.
   Approve it, then check the **Memory** panel.

Then try denying something. Type a reason into the box before clicking Deny —
it goes back to the model, and you'll see it adapt rather than retry.

## What the approval card is for

JARVIS proposes the *actual action*, not a description of it. Ask it to send an
email and it drafts the email and calls `gmail.send` — the card shows you the
full body before anything leaves your account. That's the design: the card is
the asking, so there's no step where it says "shall I?" and you say yes to
something you haven't read.

If you get tired of approving a particular syscall, set it to **auto** in the
**Perms** panel. `shell.exec` is `dangerous`, which means loosening a whole
tier never auto-allows it — it takes an explicit per-syscall override.

## Speed and cost

Everything is one model call per step, so a task that takes ten tool calls
makes ten round trips. Two levers:

- **Delegate.** A subagent doing the reading keeps that out of your main
  context, which is cheaper and faster on anything research-shaped.
- **Use a smaller model for workers.** Agents panel → Configure → give the
  researcher a cheap fast model while the coordinator stays on your best one.

## If something breaks

| Symptom | Cause |
|---|---|
| "No model API key configured" | Model panel → paste key → Save & test |
| Connection refused / 403 on Save & test | Wrong base URL, or your network blocks the host |
| `fs.*` and `shell.exec` missing | `JARVIS_ALLOW_EXEC=false`, or it thinks it's serverless |
| "Path escapes the workspace" | Working outside `JARVIS_WORKSPACE` — set it and restart |
| Memory empty after restart | Expected without Supabase; state lives in `./.jarvis` |
| Stops after 40 steps | Loop ceiling. Say "continue". |

Logs go to the terminal running `npm run dev` — syscall errors surface there in
full, while the model only sees a summary.
