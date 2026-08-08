import type { Syscall } from "@/kernel/types";
import { all, forget, recall, remember } from "@/kernel/memory";

/**
 * Core syscalls — always available, no credentials required.
 *
 * Memory is the one that changes JARVIS's character most: without it every
 * session starts from zero and the user re-explains themselves forever.
 */

export const coreSyscalls: Syscall[] = [
  {
    name: "memory.remember",
    risk: "write",
    description:
      "Store something durable about the user. Call this whenever you learn a standing preference, a recurring person or project, a decision and its reasoning, or how they like something done. Use kind 'fact' for standing truths — writing the same key again updates it in place rather than accumulating contradictions. Use kind 'episode' for things that happened on a date. Do not store things a syscall can already tell you; store what would otherwise be lost.",
    input: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Short dotted slug, e.g. 'preference.email-tone' or 'project.atlas'. Reused keys overwrite for facts.",
        },
        value: { type: "string", description: "What to remember, in a sentence or two." },
        kind: {
          type: "string",
          enum: ["fact", "episode"],
          description: "'fact' for standing truths, 'episode' for dated events. Default 'fact'.",
        },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
    preview: (input: { key: string; value: string }) => `Remember ${input.key}: ${input.value}`,
    async run(input: { key: string; value: string; kind?: "fact" | "episode" }) {
      const record = await remember(input.key, input.value, input.kind ?? "fact");
      return `Stored ${record.kind} "${record.key}".`;
    },
  },

  {
    name: "memory.recall",
    risk: "read",
    description:
      "Search long-term memory. Relevant memory is injected into your context automatically each turn, so call this only when you need to dig for something that wasn't surfaced — an older decision, a specific project's history, everything known about a person.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        limit: { type: "integer", description: "Maximum records. Default 15." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input: { query: string; limit?: number }) {
      const records = await recall(input.query, input.limit ?? 15);
      if (!records.length) return `Nothing in memory matches "${input.query}".`;
      return records.map((r) => ({
        id: r.id,
        key: r.key,
        kind: r.kind,
        value: r.value,
        updated: r.updatedAt,
      }));
    },
  },

  {
    name: "memory.forget",
    risk: "write",
    description:
      "Delete a memory record by id. Use when the user says something you stored is wrong or out of date — correct a wrong fact by remembering the right value under the same key instead, and reserve this for things that should not be remembered at all.",
    input: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record id from memory.recall." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    preview: (input: { id: string }) => `Delete memory record ${input.id}`,
    async run(input: { id: string }) {
      const removed = await forget(input.id);
      return removed ? `Forgot ${input.id}.` : `No record with id ${input.id}.`;
    },
  },

  {
    name: "memory.list",
    risk: "read",
    description:
      "List everything in memory, most recently updated first. Use when the user asks what you know about them, or when auditing memory for stale entries.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const records = await all();
      if (!records.length) return "Memory is empty.";
      return records.map((r) => ({ id: r.id, key: r.key, kind: r.kind, value: r.value }));
    },
  },

  {
    name: "web.fetch",
    risk: "read",
    description:
      "Fetch a URL and return its text content, with HTML stripped. Use when the user gives you a link, or when a search result or email references a page whose contents you need.",
    input: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run(input: { url: string }, ctx) {
      const url = new URL(input.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Only http and https URLs can be fetched.");
      }

      const res = await fetch(url, {
        signal: ctx.signal,
        headers: { "User-Agent": "JARVIS-OS/0.1 (personal assistant)" },
      });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();

      if (!contentType.includes("html")) {
        return body.length > 30_000 ? `${body.slice(0, 30_000)}\n[truncated]` : body;
      }

      const text = body
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();

      return text.length > 30_000 ? `${text.slice(0, 30_000)}\n[truncated]` : text;
    },
  },
];
