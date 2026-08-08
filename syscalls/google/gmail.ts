import type { Syscall } from "@/kernel/types";
import { google } from "./auth";

/**
 * Gmail syscalls.
 *
 * Search and read are `read`. Anything that leaves the account — sending,
 * replying — is `write` and stops for approval with the full body on the card,
 * because "the model sent an email I hadn't seen" is the failure mode that
 * destroys trust fastest.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  labelIds?: string[];
  payload?: {
    headers?: { name: string; value: string }[];
    mimeType?: string;
    body?: { data?: string; size: number };
    parts?: GmailMessage["payload"][];
  };
}

function header(message: GmailMessage, name: string): string {
  const found = message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

/** Walk the MIME tree for the best readable body. Prefers text/plain. */
function extractBody(payload: GmailMessage["payload"]): string {
  if (!payload) return "";

  const decode = (data?: string) =>
    data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";

  if (payload.mimeType === "text/plain" && payload.body?.data) return decode(payload.body.data);

  if (payload.parts?.length) {
    const plain = payload.parts.find((p) => p?.mimeType === "text/plain");
    if (plain?.body?.data) return decode(plain.body.data);

    const html = payload.parts.find((p) => p?.mimeType === "text/html");
    if (html?.body?.data) {
      return decode(html.body.data)
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Multipart wrappers nest; recurse into the first branch that has content.
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return decode(payload.body?.data);
}

/** RFC 2822 message, base64url encoded as Gmail's send endpoint expects. */
function encodeMessage(fields: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [
    `To: ${fields.to}`,
    fields.cc ? `Cc: ${fields.cc}` : null,
    `Subject: ${fields.subject}`,
    fields.inReplyTo ? `In-Reply-To: ${fields.inReplyTo}` : null,
    fields.references ? `References: ${fields.references}` : null,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    fields.body,
  ].filter((l): l is string => l !== null);

  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const gmailSyscalls: Syscall[] = [
  {
    name: "gmail.search",
    connector: "google",
    risk: "read",
    description:
      "Search the user's mailbox using Gmail query syntax and return matching messages with sender, subject, date and snippet. Call this whenever a request depends on what's in their inbox — triaging mail, finding a thread, checking whether someone replied, or answering a question about a conversation. Query syntax examples: 'is:unread', 'from:alice@co.com', 'newer_than:2d', 'has:attachment subject:invoice'.",
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query, e.g. 'is:unread newer_than:1d'.",
        },
        limit: {
          type: "integer",
          description: "Maximum messages to return. Default 15, max 50.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input: { query: string; limit?: number }) {
      const limit = Math.min(input.limit ?? 15, 50);
      const list = await google<{ messages?: { id: string }[]; resultSizeEstimate: number }>(
        `${API}/messages?q=${encodeURIComponent(input.query)}&maxResults=${limit}`,
      );

      if (!list.messages?.length) return `No messages match "${input.query}".`;

      const messages = await Promise.all(
        list.messages.map((m) =>
          google<GmailMessage>(
            `${API}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          ),
        ),
      );

      return messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        from: header(m, "From"),
        subject: header(m, "Subject"),
        date: header(m, "Date"),
        unread: m.labelIds?.includes("UNREAD") ?? false,
        snippet: m.snippet,
      }));
    },
  },

  {
    name: "gmail.read",
    connector: "google",
    risk: "read",
    description:
      "Read one message in full, including its body. Use after gmail.search when the snippet isn't enough to answer the question or draft a reply — always read the message you're replying to before drafting the reply.",
    input: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message id from gmail.search." },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    async run(input: { messageId: string }) {
      const message = await google<GmailMessage>(`${API}/messages/${input.messageId}?format=full`);
      const body = extractBody(message.payload);
      return {
        id: message.id,
        threadId: message.threadId,
        from: header(message, "From"),
        to: header(message, "To"),
        cc: header(message, "Cc"),
        subject: header(message, "Subject"),
        date: header(message, "Date"),
        messageIdHeader: header(message, "Message-ID"),
        references: header(message, "References"),
        // Long bodies are truncated rather than dropped — the model can ask
        // for a different message if it needs more.
        body: body.length > 20_000 ? `${body.slice(0, 20_000)}\n\n[truncated]` : body,
      };
    },
  },

  {
    name: "gmail.send",
    connector: "google",
    risk: "write",
    description:
      "Send an email from the user's account. Write the complete message you intend to send — the user reviews the full body on an approval card before it goes out, so this is how you propose an email, not a step you take after asking permission in chat.",
    input: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address, or comma-separated addresses." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text body." },
        cc: { type: "string", description: "Optional cc addresses." },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    preview: (input: { to: string; subject: string; body: string }) =>
      `Send to ${input.to} — "${input.subject}"\n\n${input.body}`,
    async run(input: { to: string; subject: string; body: string; cc?: string }) {
      const sent = await google<{ id: string; threadId: string }>(`${API}/messages/send`, {
        method: "POST",
        body: JSON.stringify({ raw: encodeMessage(input) }),
      });
      return `Sent to ${input.to} (message ${sent.id}).`;
    },
  },

  {
    name: "gmail.reply",
    connector: "google",
    risk: "write",
    description:
      "Reply within an existing thread, keeping it threaded correctly. Read the message you're replying to first — call gmail.read to get its messageIdHeader and the context you're responding to.",
    input: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from gmail.search or gmail.read." },
        to: { type: "string", description: "Recipient address." },
        subject: { type: "string", description: "Subject line, usually 'Re: <original>'." },
        body: { type: "string", description: "Plain text reply body." },
        inReplyTo: {
          type: "string",
          description: "The messageIdHeader of the message being replied to, from gmail.read.",
        },
      },
      required: ["threadId", "to", "subject", "body"],
      additionalProperties: false,
    },
    preview: (input: { to: string; subject: string; body: string }) =>
      `Reply to ${input.to} — "${input.subject}"\n\n${input.body}`,
    async run(input: {
      threadId: string;
      to: string;
      subject: string;
      body: string;
      inReplyTo?: string;
    }) {
      const sent = await google<{ id: string }>(`${API}/messages/send`, {
        method: "POST",
        body: JSON.stringify({
          threadId: input.threadId,
          raw: encodeMessage({
            to: input.to,
            subject: input.subject,
            body: input.body,
            inReplyTo: input.inReplyTo,
            references: input.inReplyTo,
          }),
        }),
      });
      return `Replied in thread ${input.threadId} (message ${sent.id}).`;
    },
  },

  {
    name: "gmail.modify_labels",
    connector: "google",
    risk: "write",
    description:
      "Add or remove labels on a message — mark as read (remove UNREAD), archive (remove INBOX), star (add STARRED). Use this for inbox triage once the user has told you how they want things sorted.",
    input: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        add: { type: "array", items: { type: "string" }, description: "Label ids to add." },
        remove: { type: "array", items: { type: "string" }, description: "Label ids to remove." },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    preview: (input: { messageId: string; add?: string[]; remove?: string[] }) => {
      const changes = [
        input.add?.length ? `add ${input.add.join(", ")}` : null,
        input.remove?.length ? `remove ${input.remove.join(", ")}` : null,
      ].filter(Boolean);
      return `Message ${input.messageId}: ${changes.join("; ") || "no changes"}`;
    },
    async run(input: { messageId: string; add?: string[]; remove?: string[] }) {
      await google(`${API}/messages/${input.messageId}/modify`, {
        method: "POST",
        body: JSON.stringify({
          addLabelIds: input.add ?? [],
          removeLabelIds: input.remove ?? [],
        }),
      });
      return `Updated labels on ${input.messageId}.`;
    },
  },
];
