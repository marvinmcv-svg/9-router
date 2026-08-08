import type Anthropic from "@anthropic-ai/sdk";
import type { PendingApproval } from "./types";
import { store } from "@/lib/store";

/**
 * Session state.
 *
 * The agent loop runs across multiple HTTP requests — a turn that stops for
 * approval ends its stream, and the user's decision arrives later on a fresh
 * request. So the loop's state can't live in memory: the conversation, the
 * calls awaiting a decision, and the results of calls that already ran in the
 * same turn all persist here between requests.
 */

export interface Session {
  id: string;
  title: string;
  messages: Anthropic.MessageParam[];
  /**
   * Set when the loop stopped mid-turn for approval. `completed` holds
   * tool_result blocks for calls in that same assistant turn that were
   * auto-allowed and already ran — the API requires one result per tool_use
   * block, so they wait here until the pending ones are decided.
   */
  pending?: {
    approvals: PendingApproval[];
    completed: Anthropic.ToolResultBlockParam[];
  };
  createdAt: string;
  updatedAt: string;
}

const key = (id: string) => `sessions/${id}`;

export async function loadSession(id: string): Promise<Session> {
  const existing = await store.get<Session>(key(id));
  if (existing) return existing;
  const now = new Date().toISOString();
  return { id, title: "New session", messages: [], createdAt: now, updatedAt: now };
}

export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await store.set(key(session.id), session);
}

export async function listSessions(): Promise<Pick<Session, "id" | "title" | "updatedAt">[]> {
  const keys = await store.list("sessions/");
  const sessions = await Promise.all(keys.map((k) => store.get<Session>(k)));
  return sessions
    .filter((s): s is Session => s !== null)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSession(id: string): Promise<void> {
  await store.delete(key(id));
}
