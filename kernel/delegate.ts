import { agentAllows, getAgent, type AgentDefinition } from "./agents";
import { buildProvider } from "./provider";
import { availableSyscalls, getSyscall } from "./registry";
import type { SyscallContext } from "./types";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The subagent runtime.
 *
 * A delegated task runs a complete nested kernel loop and returns a report.
 * Unlike the top-level loop it never pauses for approval: a subagent's
 * permissions are decided up front by its roster entry, so every call is
 * allow-or-refuse and the whole run completes inside one tool call. That is
 * deliberate — approvals belong to the coordinator, where the user is looking.
 */

export interface DelegationResult {
  agent: string;
  report: string;
  syscallsUsed: string[];
  iterations: number;
  truncated: boolean;
}

export async function delegate(
  agentId: string,
  task: string,
  ctx: SyscallContext,
): Promise<DelegationResult> {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`No agent named "${agentId}" is on the roster.`);
  }

  const provider = await buildProvider(agent.model);
  const tools = toolsFor(agent);

  if (!tools.length) {
    throw new Error(
      `Agent "${agent.name}" has no callable syscalls — its allow-list matches nothing that is currently configured.`,
    );
  }

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const used: string[] = [];
  let report = "";
  let iterations = 0;

  for (; iterations < agent.maxIterations; iterations++) {
    if (ctx.signal.aborted) break;

    const response = await provider.stream(
      {
        system: [
          { type: "text", text: agent.systemPrompt, cache_control: { type: "ephemeral" } },
          { type: "text", text: `Current time: ${new Date().toISOString()}.` },
        ],
        messages,
        tools,
        maxTokens: 16_000,
        signal: ctx.signal,
      },
      // Subagent tokens don't stream to the UI — the coordinator's report is
      // what the user reads — but progress lines keep the transcript alive.
      () => {},
    );

    messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) report = text;

    const calls = response.content.filter(
      (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
    );
    if (!calls.length) break;

    ctx.progress(`${agent.name}: ${calls.map((c) => c.name).join(", ")}`);

    // Independent calls run concurrently — a researcher reading eight files
    // should take as long as the slowest read, not the sum of all of them.
    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
        used.push(call.name);
        const refusal = refuse(agent, call.name);
        if (refusal) {
          return { type: "tool_result", tool_use_id: call.id, content: refusal, is_error: true };
        }

        const syscall = getSyscall(call.name)!;
        try {
          const output = await syscall.run(call.input, ctx);
          const rendered = typeof output === "string" ? output : JSON.stringify(output, null, 2);
          return { type: "tool_result", tool_use_id: call.id, content: rendered || "(no output)" };
        } catch (err) {
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: "user", content: results });
  }

  return {
    agent: agent.name,
    report: report.trim() || "(the subagent finished without producing a report)",
    syscallsUsed: [...new Set(used)],
    iterations,
    truncated: iterations >= agent.maxIterations,
  };
}

/** Why a call is refused, or null if it's permitted. */
function refuse(agent: AgentDefinition, syscallName: string): string | null {
  const syscall = getSyscall(syscallName);
  if (!syscall) return `No syscall named ${syscallName} is registered.`;

  if (!agentAllows(agent, syscallName)) {
    return `${agent.name} is not permitted to call ${syscallName}. Work with the syscalls you have, or report back that this task needs a different agent.`;
  }

  if (!agent.canWrite && syscall.risk !== "read") {
    return `${agent.name} cannot perform actions that change state. Do not retry. Describe exactly what should be done in your report, and the coordinator will carry it out with the user's approval.`;
  }

  return null;
}

function toolsFor(agent: AgentDefinition): Anthropic.Tool[] {
  // Delegation is deliberately absent from every subagent's toolset: one level
  // of delegation keeps the trace legible and makes runaway recursion
  // impossible by construction rather than by depth counter.
  return availableSyscalls()
    .filter((s) => !s.name.startsWith("agent."))
    .filter((s) => agentAllows(agent, s.name))
    .filter((s) => agent.canWrite || s.risk === "read")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: s.input as Anthropic.Tool.InputSchema,
    }));
}
