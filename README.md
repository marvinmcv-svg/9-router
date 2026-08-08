# JARVIS

An agentic operating system for one person's working life. Not a chatbot with
plugins — a shell that sits between you and your mail, calendar, files, code
and infrastructure, and does the work.

It has a real workspace and a real shell: it lists, reads, edits and writes
files, and runs builds, tests and git. It delegates to subagents that run their
own loops on their own models. Reads happen instantly; anything that changes
the world stops and asks you first.

**Bring your own model.** Anthropic, any Anthropic-compatible gateway (GLM/Z.ai,
LiteLLM), or anything OpenAI-compatible (Ollama, vLLM, OpenRouter, llama.cpp).
Paste a key in the Model panel and it switches at runtime — no redeploy.

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
                    ├─ kernel/provider.ts      Anthropic / compatible / OpenAI
                    ├─ kernel/permissions.ts   allow / ask / deny per call
                    ├─ kernel/memory.ts        persistent facts + episodes
                    ├─ kernel/delegate.ts      nested loop for subagents
                    ├─ kernel/registry.ts      syscall table → tool schemas
                    └─ syscalls/*              fs, shell, agents, Gmail,
                                               Calendar, Drive, GitHub,
                                               Vercel, Railway, Supabase, web
```

### Provider independence

The kernel speaks Anthropic's content-block shape as its canonical form — it's
the most expressive of the wire formats (typed tool calls, thinking blocks,
cache control) — and each adapter translates at the boundary. Adding a provider
means implementing one `stream` method; the loop, permission engine and UI
don't change.

Capability flags are per-vendor defaults rather than assumptions: most
compatible gateways reject `thinking` and `output_config`, so those are omitted
unless the provider is known to support them. That's why pointing at GLM works
without touching any other setting.

### Subagents

`agent.delegate` hands a self-contained task to a specialist that runs its own
loop, with its own model and a narrowed syscall set, and returns a report. The
worker's searching and reading happens in *its* context window — which is the
whole point: the coordinator gets the finding, not the hundred files.

Several `agent.delegate` calls in one turn run concurrently, as do any other
independent syscalls.

**Subagents are read-only by default, and that's a security property rather
than caution.** They report; the coordinator carries out the resulting action.
Every write therefore funnels through one approval card you actually see,
instead of being scattered across parallel workers. Flip `canWrite` per agent
in the Agents panel when you want a worker that edits directly (the built-in
`engineer` is one).

Delegation is deliberately absent from every subagent's toolset, so recursion
is impossible by construction rather than by depth counter.

### The workspace

`fs.*` and `shell.exec` operate on a real directory set by `JARVIS_WORKSPACE`.
Model-supplied paths are untrusted input: each is resolved to its canonical
form and checked for containment, with `realpath` applied so a symlink pointing
at `/etc` is refused rather than followed. That check lives in one function
every filesystem syscall routes through.

`shell.exec` is `dangerous`, which means it can never be auto-allowed by
loosening a tier default — it takes an explicit per-syscall override.

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
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000, go to the **Model** panel, paste your key, and hit
**Save & test** — it sends a real request and shows you the reply, because a
configuration that looks right and doesn't work is the expensive kind.

For GLM / Z.ai specifically:

| Field | Value |
|---|---|
| Provider | Anthropic-compatible |
| Base URL | `https://api.z.ai/api/anthropic` |
| Model | `glm-4.6` |
| API key | your `id.secret` key |

For a local model (Ollama, vLLM, LM Studio): choose **OpenAI-compatible**, base
URL `http://localhost:11434/v1`, and whatever model name you're serving.

Set `JARVIS_WORKSPACE` to the directory you want it working in. Without it,
JARVIS operates on its own source tree — fine for trying it out, probably not
what you want day to day.

That's the whole floor: with a model and a workspace you get filesystem, shell,
memory, web, and subagents. Every other syscall stays hidden until its
connector has credentials, because a tool the model can see is a tool it will
eventually call.

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

**[DEPLOY.md](./DEPLOY.md) is the full guide.** The short version: import the
repo at [vercel.com/new](https://vercel.com/new), set `JARVIS_PASSWORD`,
`JARVIS_AUTH_SECRET`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then sign
in and paste your model key into the Model panel.

Two things are worth knowing before you do:

**Serverless has no shell.** Vercel's filesystem is read-only and ephemeral, so
`fs.write`, `fs.edit` and `shell.exec` are hidden on that host and the system
prompt says so. Deployed you get mail, calendar, drive, GitHub, memory,
subagents and routines; for editing files and running commands, run JARVIS on a
real machine.

**Supabase is required, not optional.** Serverless functions don't share a
filesystem between invocations, so the local JSON store loses memory, sessions
and OAuth tokens silently. `supabase/schema.sql` sets up the one table it needs.

Access is a password plus an HMAC-signed session cookie, enforced in middleware
so nothing reaches the kernel without it. **With no password configured the app
serves 503 rather than opening** — a misconfigured deployment is locked, not
exposed. It's still single-user: whoever knows the password has your mailbox.

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

## Adding an agent

Agents are data too. The Agents panel edits them at runtime; `kernel/agents.ts`
holds the built-in roster:

```ts
{
  id: "hermes",
  name: "Hermes",
  description: "…",          // ← the coordinator picks who to delegate to from this
  systemPrompt: "…",
  allow: ["fs.read", "web."], // ← prefix-scoped syscall allow-list
  canWrite: false,
  model: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "hermes-3" },
  maxIterations: 20,
}
```

Write the `description` for the coordinator to read — it's how JARVIS decides
who gets a task. Omit `model` to inherit whatever the Model panel is set to.

## Testing

```bash
npm test        # 24 tests
```

The suite includes a mock server speaking OpenAI's streaming wire format, so
the kernel loop, tool dispatch, permission engine, delegation and real
filesystem syscalls are all exercised end to end against a non-Anthropic
provider. Parallel execution is verified by timing rather than asserted.

## What this doesn't do yet

- **Runs where the server runs.** The shell and filesystem are the *host's*, so
  deployed to Vercel it operates on the deployment, not your laptop. Run it
  locally to have it work on your machine.
- **No push.** Routines write their output to state; nothing notifies you.
- **No voice.**
- **Infrastructure is read-only.** Vercel, Railway and Supabase syscalls
  observe and report. Triggering a production deploy from a chat message
  deserves a more deliberate decision than an approval card mid-conversation.
