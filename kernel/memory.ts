import { randomUUID } from "node:crypto";
import type { MemoryRecord } from "./types";
import { store } from "@/lib/store";

/**
 * Long-term memory.
 *
 * Two kinds, deliberately. `fact` records are keyed and idempotent — writing
 * `preference.email-tone` twice updates one row rather than accumulating
 * contradictions. `episode` records are an append-only log of what happened,
 * which is what makes "what did we decide about the migration?" answerable.
 *
 * Retrieval is keyword + recency rather than embeddings. For a single user's
 * memory (hundreds to low thousands of records) this is accurate, has no
 * index to rebuild, and costs nothing per write. Swap in pgvector here if the
 * corpus ever outgrows it — nothing outside this file depends on the method.
 */

const INDEX_KEY = "memory/index";

async function readIndex(): Promise<MemoryRecord[]> {
  return (await store.get<MemoryRecord[]>(INDEX_KEY)) ?? [];
}

async function writeIndex(records: MemoryRecord[]): Promise<void> {
  await store.set(INDEX_KEY, records);
}

export async function remember(
  key: string,
  value: string,
  kind: "fact" | "episode" = "fact",
): Promise<MemoryRecord> {
  const records = await readIndex();
  const now = new Date().toISOString();

  if (kind === "fact") {
    const existing = records.find((r) => r.kind === "fact" && r.key === key);
    if (existing) {
      existing.value = value;
      existing.updatedAt = now;
      await writeIndex(records);
      return existing;
    }
  }

  const record: MemoryRecord = {
    id: randomUUID(),
    key,
    value,
    kind,
    createdAt: now,
    updatedAt: now,
  };
  records.push(record);
  await writeIndex(records);
  return record;
}

export async function forget(id: string): Promise<boolean> {
  const records = await readIndex();
  const next = records.filter((r) => r.id !== id);
  if (next.length === records.length) return false;
  await writeIndex(next);
  return true;
}

export async function all(): Promise<MemoryRecord[]> {
  return (await readIndex()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "do", "does", "did", "what", "when", "who",
  "my", "me", "i", "you", "it", "that", "this", "how", "about",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Score records against a query. Key matches weigh more than value matches —
 * a record keyed `preference.email-tone` should win the query "email tone"
 * over a passing mention of email in some episode's body.
 */
export async function recall(query: string, limit = 12): Promise<MemoryRecord[]> {
  const records = await readIndex();
  if (!records.length) return [];

  const terms = tokenize(query);
  if (!terms.length) return records.slice(-limit).reverse();

  const now = Date.now();
  const scored = records.map((record) => {
    const key = record.key.toLowerCase();
    const value = record.value.toLowerCase();

    let relevance = 0;
    for (const term of terms) {
      if (key.includes(term)) relevance += 3;
      if (value.includes(term)) relevance += 1;
    }

    // A record that matches nothing is not a weak result, it's not a result.
    // The bonuses below break ties between genuine matches; letting them
    // accumulate on a non-match would surface unrelated memory as context.
    if (relevance === 0) return { record, score: 0 };

    // Gentle recency tilt, so a stale episode doesn't outrank a fresh one on
    // an otherwise equal keyword match.
    const ageDays = (now - Date.parse(record.updatedAt)) / 86_400_000;
    const recency = Math.max(0, 1 - ageDays / 90);
    // Facts are durable context; episodes are situational.
    const durability = record.kind === "fact" ? 0.5 : 0;

    return { record, score: relevance + recency + durability };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.record);
}

/** Render recalled memory for injection into the system prompt. */
export function renderMemory(records: MemoryRecord[]): string {
  if (!records.length) return "";
  const facts = records.filter((r) => r.kind === "fact");
  const episodes = records.filter((r) => r.kind === "episode");

  const sections: string[] = [];
  if (facts.length) {
    sections.push(
      `Known about the user:\n${facts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}`,
    );
  }
  if (episodes.length) {
    sections.push(
      `Relevant history:\n${episodes
        .map((e) => `- [${e.createdAt.slice(0, 10)}] ${e.value}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
