# JARVIS

An agentic operating system for one person's working life. Not a chatbot with
plugins — a shell that sits between you and your mail, calendar, files, code
and infrastructure, and does the work.

Runs on `claude-opus-5` with adaptive thinking. Reads happen instantly; anything
that changes the world stops and asks you first.

---

## The idea

Most assistants fail in one of two directions. Either they can't actually do
anything (they draft an email and you send it), or they can do everything and
you can't trust them with it.

JARVIS splits the difference at the level of the **syscall**. Every capability
is a registered function with a declared risk:

| Risk | Meaning | Default |
|---|---|---|
| `read` | Observes state. Can't break anything. | Runs immediately |
| `write` | Changes state, visible to others. | Approval card |
| `dangerous` | Irreversible, destructive, or spends money. | Approval card, and can't be auto-allowed by a tier default |

The permission engine reads that declaration on every call. Because reads are
free, JARVIS gathers context aggressively — it will search your inbox, check
your calendar, and read the file before doing anything. Because writes pause,
it proposes the actual action rather than asking about it in prose: it drafts
the email and calls `gmail.send`, and you see the full body on a card before it
goes out.

Deny a call and your reason goes back to the model, which adapts rather than
retrying.

As you come to trust something, flip it to `auto` in the Syscalls panel. The
policy is data, not code.

---

## Architecture

```
Browser (OS shell)
   │  SSE
   ▼
/api/kernel ──► kernel/agent.ts        the loop: stream, tool_use, resume
                    │
                    ├─ kernel/permissions.ts   allow / ask / deny per call
                    ├─ kernel/memory.ts        persistent facts + episodes
                    ├─ kernel/registry.ts      syscall table → tool schemas
                    └─ syscalls/*              Gmail, Calendar, Drive,
                                               GitHub, Vercel, Railway,
                                               Supabase, web, memory
```

**The interesting part is the pause.** A turn that hits an approval doesn't
block a request thread waiting on a human — it persists its state (conversation,
the calls awaiting decision, and results of calls in the same turn that already
ran) and ends the stream. Your decision arrives on a fresh request, and the loop
resumes mid-turn. That's why routines can run at 6am unattended: anything
needing approval simply parks until you look.

**Memory** is two kinds. Keyed `fact` records are idempotent, so writing
`preference.email-tone` twice updates in place rather than accumulating
contradictions. `episode` records are an append-only log. Retrieval is keyword
plus recency — for one person's memory that's accurate, has no index to rebuild,
and costs nothing per write. Swap in pgvector behind `kernel/memory.ts` if it
ever outgrows that; nothing outside the file depends on the method.

---

## Setup

```bash
cp .env.example .env.local     # add ANTHROPIC_API_KEY at minimum
npm install
npm run dev
```

Open http://localhost:3000. It works with only an Anthropic key — you get
memory and web fetch. Every other syscall stays hidden until its connector has
credentials, because a tool the model can see is a tool it will eventually call.

**Google (Gmail, Calendar, Drive).** Create an OAuth 2.0 *Web application*
client at [console.cloud.google.com](https://console.cloud.google.com), enable
the Gmail, Calendar and Drive APIs, and add the redirect URI
`http://localhost:3000/api/auth/google`. Put the client id and secret in
`.env.local`, restart, then click **Connect** in the Connectors panel.

**GitHub / Vercel / Railway.** Drop a token in `.env.local` and restart.

**Supabase.** Run `supabase/schema.sql` against your project first — it creates
the state table and the read-only query function the `supabase.query` syscall
calls.

---

## Deploying

State must be shared and durable, so **Supabase is required in production** —
the filesystem fallback in `lib/store.ts` is for local development only, and on
serverless hosts it silently loses memory and OAuth tokens between invocations.

```bash
# 1. Run supabase/schema.sql against your project
# 2. Set env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
#    JARVIS_BASE_URL, JARVIS_CRON_SECRET, plus any connector tokens
# 3. Add https://<your-domain>/api/auth/google to the Google OAuth client
vercel deploy
```

`vercel.json` schedules the routines. `JARVIS_CRON_SECRET` guards the trigger
endpoint — routines refuse to run in production without it, because that URL
starts a paid agent run with full access to your accounts.

> **Deploy this for yourself, behind auth.** There is no multi-tenancy and no
> login: the app assumes the person using it owns the connected accounts.
> Anyone who reaches the URL can read your mail. Put it behind Vercel
> Authentication, Cloudflare Access, or equivalent before it leaves localhost.

---

## Routines

Scheduled prompts that run in a fresh session under the same permission policy
as an interactive turn. `morning-brief` assembles your day; `evening-wrap`
reviews it and writes what it learned to memory. Add your own in
`routines/index.ts` — a routine is a prompt and a cron expression.

---

## Adding a capability

One file, one export. The registry, permission engine, approval UI and tool
schema all derive from it:

```ts
// syscalls/linear.ts
export const linearSyscalls: Syscall[] = [{
  name: "linear.create_issue",
  connector: "linear",
  risk: "write",                    // ← puts it behind an approval card
  description:
    "Create a Linear issue. Call this when the user wants work tracked " +
    "rather than done now.",        // ← say *when*, not just what
  input: { /* JSON Schema */ },
  preview: (i) => `Create "${i.title}" in ${i.team}`,   // ← what the card shows
  run: async (input, ctx) => { /* ... */ },
}];
```

Register it in `syscalls/index.ts`, and add the connector to
`syscalls/connectors.ts` so it hides itself when unconfigured.

Two things worth getting right. Write the `description` prescriptively — say
when to call it, not only what it does; the model reaches for tools
conservatively otherwise. And write the `preview` for a human deciding in two
seconds: it should surface whatever would make them say no.

---

## What this doesn't do yet

- **No local execution.** Everything runs in the web app, so JARVIS can't touch
  your filesystem or run shell commands. A local agent that pairs with this
  cloud brain is the obvious next step.
- **No push.** Routines write their output to state; nothing notifies you.
- **No voice.**
- **Infrastructure is read-only.** Vercel, Railway and Supabase syscalls
  observe and report. Triggering a production deploy from a chat message
  deserves a more deliberate decision than an approval card mid-conversation.
