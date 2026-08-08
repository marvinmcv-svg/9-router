import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  KernelEvent,
  PendingApproval,
  SyscallContext,
} from "./types";
import { decide, getPolicy } from "./permissions";
import { getSyscall, previewCall, toolDefinitions } from "./registry";
import { recall, renderMemory } from "./memory";
import { situationPrompt, staticPrompt } from "./prompt";
import { loadSession, saveSession, type Session } from "./session";
import { buildProvider, type Delta, type Provider } from "./provider";
import { createQueue } from "./stream";

const MAX_ITERATIONS = 40;
/** Per-turn output budget. */
const MAX_TOKENS = 32_000;

export interface RunInput {
  sessionId: string;
  /** A new user message, or the user's answers to pending approvals. */
  input: { type: "user"; text: string } | { type: "decisions"; decisions: ApprovalDecision[] };
  timezone?: string;
  signal?: AbortSignal;
  /**
   * Override the model. Exists so the approval state machine can be driven by
   * a scripted provider in tests — it spans multiple HTTP requests and is not
   * something to verify by hand.
   */
  client?: Provider;
}

/**
 * The kernel loop.
 *
 * Yields events as they happen so the UI can render thinking, tool calls and
 * text in real time. Stops in one of three states: the model finished its
 * turn, it needs an approval decision, or it hit the iteration ceiling.
 */
export async function* run(opts: RunInput): AsyncGenerator<KernelEvent> {
  const { sessionId, timezone = "UTC" } = opts;
  const signal = opts.signal ?? new AbortController().signal;

  const session = await loadSession(sessionId);
  const policy = await getPolicy();
  let provider: Provider;
  try {
    provider = opts.client ?? (await buildProvider());
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  try {
    if (opts.input.type === "user") {
      if (session.pending) {
        // A new message while approvals are outstanding would leave the prior
        // assistant turn with unanswered tool_use blocks, which the API
        // rejects. Treat the interruption as a denial of everything pending.
        yield* resolvePending(
          session,
          session.pending.approvals.map((a) => ({
            id: a.id,
            decision: "deny" as const,
            note: "User moved on to something else before deciding.",
          })),
          signal,
        );
      }
      session.messages.push({ role: "user", content: opts.input.text });
      if (session.title === "New session") {
        session.title = opts.input.text.slice(0, 60);
      }
    } else {
      if (!session.pending) {
        yield { type: "error", message: "No approvals are pending for this session." };
        return;
      }
      yield* resolvePending(session, opts.input.decisions, signal);
    }

    await saveSession(session);

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (signal.aborted) {
        yield { type: "done", reason: "end_turn" };
        return;
      }

      const memory = renderMemory(await recall(lastUserText(session), 12));

      // Providers push deltas through a callback; the queue turns that into
      // something this generator can yield from, so tokens reach the browser
      // while the request is still open.
      const deltas = createQueue<Delta>();
      const pending = provider
        .stream(
          {
          system: [
            // Stable half carries the cache breakpoint; the volatile half
            // (clock, recalled memory) sits after it and re-renders each turn.
            { type: "text", text: staticPrompt(), cache_control: { type: "ephemeral" } },
            { type: "text", text: situationPrompt({ now: new Date(), timezone, memory, policy }) },
          ],
            messages: session.messages,
            tools: toolDefinitions(),
            maxTokens: MAX_TOKENS,
            signal,
          },
          (delta) => deltas.push(delta),
        )
        // Close on both paths, or a failed request leaves the loop below
        // waiting forever on a queue nothing will ever push to again.
        .finally(() => deltas.close());

      for await (const delta of deltas) {
        yield { type: delta.type, text: delta.text };
      }

      const message = await pending;
      session.messages.push({ role: "assistant", content: message.content });

      yield {
        type: "usage",
        inputTokens: message.usage.inputTokens,
        outputTokens: message.usage.outputTokens,
        cacheRead: message.usage.cacheRead,
      };

      if (message.stopReason === "refusal") {
        yield {
          type: "error",
          message: "That request was declined by the model's safety systems.",
        };
        await saveSession(session);
        yield { type: "done", reason: "end_turn" };
        return;
      }

      const toolUses = message.content.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
      );

      if (!toolUses.length) {
        await saveSession(session);
        yield { type: "done", reason: "end_turn" };
        return;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      const approvals: PendingApproval[] = [];
      const runnable: Anthropic.ToolUseBlockParam[] = [];

      // Classify every call first, then run the permitted ones together. A
      // turn that delegates to three subagents should take as long as the
      // slowest, not the sum — and fan-out is the main reason to delegate.
      for (const call of toolUses) {
        const syscall = getSyscall(call.name);
        if (!syscall) {
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `No syscall named ${call.name} is registered.`,
            is_error: true,
          });
          continue;
        }

        const verdict = decide(syscall, policy);

        if (verdict === "deny") {
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `Blocked by policy: ${syscall.name} is set to deny. Tell the user this capability is switched off.`,
            is_error: true,
          });
          continue;
        }

        if (verdict === "ask") {
          approvals.push({
            id: call.id,
            syscall: syscall.name,
            input: call.input,
            risk: syscall.risk,
            preview: previewCall(syscall, call.input),
            requestedAt: new Date().toISOString(),
          });
          continue;
        }

        runnable.push(call);
      }

      for (const call of runnable) {
        yield { type: "syscall_start", id: call.id, name: call.name, input: call.input };
      }

      const outcomes = await Promise.all(runnable.map((call) => execute(call, signal)));

      for (const [index, outcome] of outcomes.entries()) {
        results.push(outcome.result);
        yield {
          type: "syscall_end",
          id: runnable[index].id,
          name: runnable[index].name,
          ok: outcome.ok,
          summary: outcome.summary,
        };
      }

      if (approvals.length) {
        // Park the turn. The already-computed results travel with it so the
        // resumed request can emit one complete tool_result set.
        session.pending = { approvals, completed: results };
        await saveSession(session);
        yield { type: "approval_required", approvals };
        yield { type: "done", reason: "awaiting_approval" };
        return;
      }

      session.messages.push({ role: "user", content: results });
      await saveSession(session);
    }

    yield { type: "done", reason: "max_iterations" };
  } catch (err) {
    if (signal.aborted) {
      await saveSession(session);
      yield { type: "done", reason: "end_turn" };
      return;
    }
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    await saveSession(session).catch(() => {});
  }
}

/**
 * Apply the user's decisions to a parked turn, run whatever was approved, and
 * append the complete tool_result set so the loop can continue.
 */
async function* resolvePending(
  session: Session,
  decisions: ApprovalDecision[],
  signal: AbortSignal,
): AsyncGenerator<KernelEvent> {
  const pending = session.pending;
  if (!pending) return;

  const byId = new Map(decisions.map((d) => [d.id, d]));
  const results = [...pending.completed];

  for (const approval of pending.approvals) {
    // Anything the user didn't explicitly answer is treated as denied. Silence
    // must never be consent for a write.
    const decision = byId.get(approval.id);

    if (!decision || decision.decision === "deny") {
      const reason = decision?.note?.trim();
      results.push({
        type: "tool_result",
        tool_use_id: approval.id,
        content: reason
          ? `The user denied this action. Their reason: ${reason}`
          : "The user denied this action. Do not retry it — find another approach or ask what they'd prefer.",
        is_error: true,
      });
      yield {
        type: "syscall_end",
        id: approval.id,
        name: approval.syscall,
        ok: false,
        summary: "Denied by user",
      };
      continue;
    }

    yield {
      type: "syscall_start",
      id: approval.id,
      name: approval.syscall,
      input: approval.input,
    };
    const outcome = await execute(
      { id: approval.id, name: approval.syscall, input: approval.input },
      signal,
    );
    results.push(outcome.result);
    yield {
      type: "syscall_end",
      id: approval.id,
      name: approval.syscall,
      ok: outcome.ok,
      summary: outcome.summary,
    };
  }

  delete session.pending;
  session.messages.push({ role: "user", content: results });
}

interface Outcome {
  ok: boolean;
  summary: string;
  result: Anthropic.ToolResultBlockParam;
}

async function execute(
  call: { id: string; name: string; input: unknown },
  signal: AbortSignal,
): Promise<Outcome> {
  const syscall = getSyscall(call.name);
  if (!syscall) {
    return {
      ok: false,
      summary: "Unknown syscall",
      result: {
        type: "tool_result",
        tool_use_id: call.id,
        content: `No syscall named ${call.name} is registered.`,
        is_error: true,
      },
    };
  }

  const ctx: SyscallContext = {
    sessionId: call.id,
    progress: () => {},
    signal,
  };

  try {
    const output = await syscall.run(call.input, ctx);
    const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    return {
      ok: true,
      summary: summarize(text),
      result: { type: "tool_result", tool_use_id: call.id, content: text || "(no output)" },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: message,
      // Errors go back as tool_result rather than throwing, so the model can
      // read what went wrong and adapt instead of the whole turn dying.
      result: {
        type: "tool_result",
        tool_use_id: call.id,
        content: `Error: ${message}`,
        is_error: true,
      },
    };
  }
}

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed;
}

function lastUserText(session: Session): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    const text = message.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text;
  }
  return "";
}

/** Generate a session id. Exported so routines can start their own sessions. */
export function newSessionId(): string {
  return randomUUID();
}
