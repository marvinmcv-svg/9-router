import assert from "node:assert/strict";
import test from "node:test";

import { run } from "./agent";
import { decide, DEFAULT_POLICY, setOverride } from "./permissions";
import { availableSyscalls, getSyscall } from "./registry";
import { recall, remember } from "./memory";
import { loadSession } from "./session";
import type { Provider } from "./provider";
import type { KernelEvent, Syscall } from "./types";

// The store reads JARVIS_DATA_DIR at import time, so `npm test` points it at a
// scratch directory — these tests write real state and must not touch the
// developer's own memory.
if (!process.env.JARVIS_DATA_DIR) {
  throw new Error("Run via `npm test`, which sets JARVIS_DATA_DIR to a scratch directory.");
}

/**
 * A scripted stand-in for the model. Each entry is one assistant turn; the
 * loop consumes them in order, so a script can drive the loop through an
 * approval pause and out the other side.
 */
function scriptedClient(
  turns: { text?: string; toolUse?: { name: string; input: unknown }[] }[],
): Provider {
  let turn = 0;
  return {
    kind: "anthropic",
    model: "scripted",
    async stream(_request, onDelta) {
      const current = turns[turn++] ?? { text: "done" };
      if (current.text) onDelta({ type: "text", text: current.text });

      return {
        content: [
          ...(current.text ? [{ type: "text" as const, text: current.text }] : []),
          ...(current.toolUse ?? []).map((t, i) => ({
            type: "tool_use" as const,
            id: `toolu_${turn}_${i}`,
            name: t.name,
            input: t.input,
          })),
        ],
        stopReason: current.toolUse?.length ? "tool_use" : "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheRead: 0 },
      };
    },
  };
}

async function collect(gen: AsyncGenerator<KernelEvent>): Promise<KernelEvent[]> {
  const events: KernelEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

test("read syscalls run without approval; writes pause the turn", async () => {
  const client = scriptedClient([
    { toolUse: [{ name: "memory.recall", input: { query: "anything" } }] },
    { toolUse: [{ name: "memory.remember", input: { key: "test.pref", value: "concise" } }] },
    { text: "Stored." },
  ]);

  const first = await collect(
    run({ sessionId: "t1", input: { type: "user", text: "remember something" }, client }),
  );

  // The read ran on its own.
  assert.ok(
    first.some((e) => e.type === "syscall_end" && e.name === "memory.recall"),
    "memory.recall should execute without approval",
  );

  // The write stopped and asked.
  const approval = first.find((e) => e.type === "approval_required");
  assert.ok(approval, "memory.remember should require approval");
  assert.equal(approval.approvals.length, 1);
  assert.equal(approval.approvals[0].syscall, "memory.remember");
  assert.match(approval.approvals[0].preview, /concise/, "preview should show what will be stored");

  assert.deepEqual(
    first.at(-1),
    { type: "done", reason: "awaiting_approval" },
    "the turn should end awaiting approval, not end_turn",
  );

  // Nothing was written while the decision was outstanding.
  assert.equal((await recall("test.pref")).length, 0, "denied-or-pending write must not apply");

  // Approving resumes the same turn on a fresh call.
  const second = await collect(
    run({
      sessionId: "t1",
      input: { type: "decisions", decisions: [{ id: approval.approvals[0].id, decision: "allow" }] },
      client,
    }),
  );

  assert.ok(
    second.some((e) => e.type === "syscall_end" && e.name === "memory.remember" && e.ok),
    "approving should execute the parked call",
  );
  assert.equal(second.at(-1)?.type, "done");

  const stored = await recall("test.pref");
  assert.equal(stored.length, 1, "the approved write should now be applied");
  assert.equal(stored[0].value, "concise");
});

test("denial reaches the model with the user's reason and applies nothing", async () => {
  const client = scriptedClient([
    { toolUse: [{ name: "memory.remember", input: { key: "should.not.exist", value: "nope" } }] },
    { text: "Understood, I won't." },
  ]);

  const first = await collect(
    run({ sessionId: "t2", input: { type: "user", text: "store this" }, client }),
  );
  const approval = first.find((e) => e.type === "approval_required");
  assert.ok(approval);

  await collect(
    run({
      sessionId: "t2",
      input: {
        type: "decisions",
        decisions: [
          { id: approval.approvals[0].id, decision: "deny", note: "That's wrong about me." },
        ],
      },
      client,
    }),
  );

  assert.equal((await recall("should.not.exist")).length, 0, "denied write must not apply");

  // The reason has to reach the model, or it can't adapt.
  const session = await loadSession("t2");
  const transcript = JSON.stringify(session.messages);
  assert.match(transcript, /That's wrong about me/, "denial note should be in the tool_result");
});

test("an unanswered approval is treated as denial, never as consent", async () => {
  const client = scriptedClient([
    { toolUse: [{ name: "memory.remember", input: { key: "silent.consent", value: "no" } }] },
    { text: "ok" },
  ]);

  await collect(run({ sessionId: "t3", input: { type: "user", text: "go" }, client }));

  // Resume with an empty decision set — the user answered nothing.
  await collect(run({ sessionId: "t3", input: { type: "decisions", decisions: [] }, client }));

  assert.equal((await recall("silent.consent")).length, 0, "silence must not authorise a write");
});

test("a new message while approvals are outstanding denies them and stays valid", async () => {
  const client = scriptedClient([
    { toolUse: [{ name: "memory.remember", input: { key: "abandoned", value: "x" } }] },
    { text: "moving on" },
    { text: "answering the new thing" },
  ]);

  await collect(run({ sessionId: "t4", input: { type: "user", text: "first" }, client }));
  const events = await collect(
    run({ sessionId: "t4", input: { type: "user", text: "actually, never mind" }, client }),
  );

  assert.ok(!events.some((e) => e.type === "error"), "interrupting must not error");
  assert.equal((await recall("abandoned")).length, 0, "abandoned write must not apply");

  // Every tool_use block still needs a matching tool_result or the next API
  // call is rejected outright.
  const session = await loadSession("t4");
  const toolUses = session.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : [],
  );
  const toolResults = session.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
  );
  assert.equal(toolUses.length, toolResults.length, "every tool_use needs a tool_result");
});

test("dangerous syscalls resist being auto-allowed by a tier default", async () => {
  const dangerous: Syscall = {
    name: "x",
    risk: "dangerous",
    description: "",
    input: {},
    run: async () => "",
  };

  // Even with the tier default flipped to allow, a dangerous call still asks.
  const loose = { ...DEFAULT_POLICY, defaults: { read: "allow", write: "allow", dangerous: "allow" } as const };
  assert.equal(decide(dangerous, loose), "ask", "tier default must not auto-allow dangerous calls");

  // It takes an explicit per-syscall override.
  assert.equal(decide(dangerous, { ...loose, overrides: { x: "allow" } }), "allow");
});

test("supabase.query rejects statements that write", async () => {
  const query = getSyscall("supabase.query");
  assert.ok(query);

  const ctx = { sessionId: "t", progress: () => {}, signal: new AbortController().signal };
  for (const sql of [
    "DELETE FROM users",
    "SELECT 1; DROP TABLE users",
    "update accounts set balance = 0",
    "WITH x AS (SELECT 1) INSERT INTO t VALUES (1)",
  ]) {
    await assert.rejects(
      () => query.run({ sql }, ctx),
      /only SELECT|not allowed|write keyword/i,
      `should reject: ${sql}`,
    );
  }
});

test("registry hides syscalls whose connector has no credentials", () => {
  const available = availableSyscalls().map((s) => s.name);
  assert.ok(available.includes("memory.remember"), "core syscalls are always available");

  if (!process.env.GOOGLE_CLIENT_ID) {
    assert.ok(!available.includes("gmail.send"), "gmail should be hidden without credentials");
  }
});

test("memory recall ranks a keyed fact above an incidental mention", async () => {
  await remember("preference.email-tone", "Prefers short, direct emails with no greeting.");
  await remember("meeting.notes", "We talked about the roadmap and briefly about email.", "episode");

  const results = await recall("email tone");
  assert.ok(results.length > 0, "should recall something");
  assert.equal(results[0].key, "preference.email-tone", "the keyed fact should rank first");
});

test("facts are idempotent by key; episodes accumulate", async () => {
  await remember("project.atlas", "Atlas ships in Q3.");
  await remember("project.atlas", "Atlas slipped to Q4.");
  const facts = (await recall("atlas")).filter((r) => r.key === "project.atlas");
  assert.equal(facts.length, 1, "rewriting a fact key must update, not duplicate");
  assert.equal(facts[0].value, "Atlas slipped to Q4.");

  await remember("standup", "Discussed atlas timeline.", "episode");
  await remember("standup", "Discussed atlas staffing.", "episode");
  const episodes = (await recall("standup")).filter((r) => r.key === "standup");
  assert.equal(episodes.length, 2, "episodes are an append-only log");
});

test("policy overrides persist and change the decision", async () => {
  const remember = getSyscall("memory.remember");
  assert.ok(remember);

  const policy = await setOverride("memory.remember", "allow");
  assert.equal(decide(remember, policy), "allow");

  await setOverride("memory.remember", null);
});
