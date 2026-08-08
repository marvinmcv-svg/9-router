import type { Syscall } from "@/kernel/types";
import { getRoster } from "@/kernel/agents";

/**
 * Delegation syscalls.
 *
 * `agent.delegate` is what turns JARVIS from one loop into a team. The
 * coordinator hands a self-contained task to a specialist, which runs its own
 * loop with its own model and returns a report — so the reading, searching and
 * trial-and-error happen in the subagent's context window rather than
 * crowding out the coordinator's.
 */

export const agentSyscalls: Syscall[] = [
  {
    name: "agent.list",
    risk: "read",
    description:
      "List the subagents available for delegation, with what each is good at and which syscalls it can reach. Call this when you're unsure who to hand a task to.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const roster = await getRoster();
      return roster.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        canWrite: a.canWrite,
        syscalls: a.allow.length ? a.allow : ["(everything you can reach)"],
        model: a.model?.model ?? "(inherits yours)",
      }));
    },
  },

  {
    name: "agent.delegate",
    // The subagent's own permissions gate what it can do; spawning one is
    // itself a read-level act, which is what lets the coordinator fan out
    // without an approval card per worker.
    risk: "read",
    description:
      "Hand a self-contained task to a subagent and get its report back. Delegate when a task splits into independent pieces, or when one piece would require reading far more than you need to keep in mind — a worker's searching and reading happens in its context, not yours.\n\nCall this several times in one turn to run subagents in parallel; they execute concurrently. Brief each one completely the first time: subagents cannot see your conversation, so the task must carry every path, constraint and output format it needs. Subagents cannot change anything — they report, and you carry out the resulting action yourself.\n\nDo not delegate work you could finish in a few syscalls; the round trip costs more than it saves.",
    input: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Agent id from agent.list, e.g. 'researcher', 'engineer', 'hermes'.",
        },
        task: {
          type: "string",
          description:
            "The complete brief: what to do, where to look, what constraints apply, and what the report should contain.",
        },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    async run(input: { agent: string; task: string }, ctx) {
      // Imported lazily: the delegate runtime reads the syscall registry, and
      // the registry is built from this module. Deferring to call time breaks
      // the cycle without either side needing to know about it.
      const { delegate } = await import("@/kernel/delegate");

      ctx.progress(`Delegating to ${input.agent}…`);
      const result = await delegate(input.agent, input.task, ctx);

      return [
        `## Report from ${result.agent}`,
        "",
        result.report,
        "",
        `_${result.iterations} steps · used ${result.syscallsUsed.join(", ") || "no syscalls"}_`,
        result.truncated
          ? "\n**This subagent hit its step limit.** Its report may be incomplete — consider a narrower task."
          : "",
      ].join("\n");
    },
  },
];
