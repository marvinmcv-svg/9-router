import { store } from "@/lib/store";
import type { ProviderConfig } from "./provider";

/**
 * The agent roster.
 *
 * JARVIS is the coordinator; every other entry here is a specialist it can
 * delegate to. A subagent runs the same kernel loop with its own model, its
 * own system prompt, and a narrowed syscall set — which is what makes
 * delegation worth the round trip: a worker on a cheap fast model can read a
 * hundred files without filling the coordinator's context with any of it.
 *
 * `canWrite` defaults to false, and that is a security property rather than
 * caution. Subagents report findings; the coordinator proposes the resulting
 * action. Every write therefore funnels through one approval card the user
 * actually sees, instead of being scattered across parallel workers.
 */

export interface AgentDefinition {
  id: string;
  name: string;
  /** Written for the coordinator: what this agent is good at and what to hand it. */
  description: string;
  systemPrompt: string;
  /**
   * Syscall name prefixes this agent may call, e.g. `["fs.", "web."]`.
   * Empty means every syscall the coordinator itself can reach.
   */
  allow: string[];
  /** When false, write and dangerous syscalls are refused with an explanation. */
  canWrite: boolean;
  /** Optional per-agent model. Omit to inherit the coordinator's provider. */
  model?: Partial<ProviderConfig>;
  /** Ceiling on nested loop iterations, to bound a runaway worker. */
  maxIterations: number;
}

const BUILT_IN: AgentDefinition[] = [
  {
    id: "researcher",
    name: "Researcher",
    description:
      "Reads widely and reports back with sources. Give it one well-scoped question plus where to look; it searches the web, mail, drive and the codebase and returns findings with citations. Spawn several in parallel for independent questions.",
    systemPrompt: `You are a research subagent. Answer exactly the question you were given.

Search and read as much as you need, then report concise findings. Cite a URL,
file path, or message id for every claim — a finding your coordinator cannot
verify is worse than no finding.

You cannot change anything. If the task implies an action, describe precisely
what should be done and let the coordinator carry it out.

Report findings, not process. Your coordinator did not watch you work and does
not need a narrative of what you searched.`,
    allow: ["fs.", "web.", "gmail.search", "gmail.read", "drive.", "calendar.list", "github.", "memory.recall"],
    canWrite: false,
    maxIterations: 20,
  },
  {
    id: "engineer",
    name: "Engineer",
    description:
      "Works in the codebase. Give it a specific change plus how to verify it; it reads the relevant code, makes the edit, and runs the tests. Hand it one self-contained change at a time.",
    systemPrompt: `You are an engineering subagent working in a real codebase.

Read before you write. Understand the surrounding code and match its
conventions — naming, comment density, error handling, idiom. Code that reads
like it was written by a different author is a defect even when it works.

Verify your own work. Run the project's tests or type checker after changing
anything, and report what the command actually printed. Never claim a change
works because it looks right.

Report the outcome first: what you changed, whether it passes, and anything
you found that the coordinator should know.`,
    allow: ["fs.", "shell.", "github.read_file", "github.check_runs", "memory.recall"],
    canWrite: true,
    maxIterations: 30,
  },
  {
    id: "hermes",
    name: "Hermes",
    description:
      "A separately-hosted model you configure in the Agents panel. Point it at any OpenAI- or Anthropic-compatible endpoint — a local Ollama or vLLM server, OpenRouter, or a hosted API — and give it whatever role its system prompt describes.",
    systemPrompt: `You are Hermes, working as a subagent under JARVIS.

Answer exactly what you were asked and report back concisely. State plainly
when something is outside what you can determine rather than guessing.`,
    allow: ["web.", "fs.read", "fs.list", "fs.search", "memory.recall"],
    canWrite: false,
    // Configured, not assumed: without an endpoint set in the Agents panel
    // this inherits the coordinator's provider and behaves as another worker.
    model: undefined,
    maxIterations: 20,
  },
];

const ROSTER_KEY = "agents/roster";

export async function getRoster(): Promise<AgentDefinition[]> {
  const saved = await store.get<AgentDefinition[]>(ROSTER_KEY);
  if (!saved?.length) return BUILT_IN;

  // Built-ins stay present even after customisation, so upgrading JARVIS never
  // silently removes an agent a user's prompts depend on.
  const byId = new Map(BUILT_IN.map((a) => [a.id, a]));
  for (const agent of saved) byId.set(agent.id, agent);
  return [...byId.values()];
}

export async function upsertAgent(agent: Partial<AgentDefinition> & { id: string }): Promise<AgentDefinition[]> {
  const roster = await getRoster();
  const index = roster.findIndex((a) => a.id === agent.id);
  const base = index >= 0 ? roster[index] : BUILT_IN.find((a) => a.id === agent.id);

  const merged: AgentDefinition = {
    id: agent.id,
    name: agent.name ?? base?.name ?? agent.id,
    description: agent.description ?? base?.description ?? "",
    systemPrompt: agent.systemPrompt ?? base?.systemPrompt ?? "",
    allow: agent.allow ?? base?.allow ?? [],
    canWrite: agent.canWrite ?? base?.canWrite ?? false,
    model: agent.model ?? base?.model,
    maxIterations: agent.maxIterations ?? base?.maxIterations ?? 20,
  };

  const next = index >= 0 ? roster.with(index, merged) : [...roster, merged];
  await store.set(ROSTER_KEY, next);
  return next;
}

export async function getAgent(id: string): Promise<AgentDefinition | undefined> {
  return (await getRoster()).find((a) => a.id === id);
}

/** Whether an agent is permitted to call a given syscall. */
export function agentAllows(agent: AgentDefinition, syscallName: string): boolean {
  if (!agent.allow.length) return true;
  return agent.allow.some((prefix) => syscallName.startsWith(prefix));
}
