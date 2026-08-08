import type { Syscall } from "@/kernel/types";
import { google, googleRaw } from "./auth";

const API = "https://www.googleapis.com/drive/v3";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  owners?: { displayName: string; emailAddress: string }[];
  size?: string;
}

/** Google-native formats have no bytes to download; they export instead. */
const EXPORT_FORMATS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export const driveSyscalls: Syscall[] = [
  {
    name: "drive.search",
    connector: "google",
    risk: "read",
    description:
      "Search the user's Google Drive by name or full-text content. Call this when a request references a document, spreadsheet or deck by name, or when the answer is likely to live in their files rather than their head.",
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words to match against file names and contents.",
        },
        limit: { type: "integer", description: "Maximum results. Default 15." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input: { query: string; limit?: number }) {
      const escaped = input.query.replace(/'/g, "\\'");
      const params = new URLSearchParams({
        q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners,size)",
        pageSize: String(Math.min(input.limit ?? 15, 50)),
        orderBy: "modifiedTime desc",
      });

      const data = await google<{ files: DriveFile[] }>(`${API}/files?${params}`);
      if (!data.files.length) return `No files match "${input.query}".`;

      return data.files.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.mimeType.replace("application/vnd.google-apps.", "google-"),
        modified: f.modifiedTime,
        owner: f.owners?.[0]?.emailAddress,
        link: f.webViewLink,
      }));
    },
  },

  {
    name: "drive.read",
    connector: "google",
    risk: "read",
    description:
      "Read a Drive file's contents as text. Google Docs, Sheets and Slides are exported automatically. Use this to ground work in what a document actually says rather than what its title suggests.",
    input: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "File id from drive.search." },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
    async run(input: { fileId: string }) {
      const meta = await google<DriveFile>(
        `${API}/files/${input.fileId}?fields=id,name,mimeType,modifiedTime,webViewLink`,
      );

      const exportAs = EXPORT_FORMATS[meta.mimeType];
      const url = exportAs
        ? `${API}/files/${input.fileId}/export?mimeType=${encodeURIComponent(exportAs)}`
        : `${API}/files/${input.fileId}?alt=media`;

      // Export and media endpoints return bytes, not JSON.
      const text = await (await googleRaw(url)).text();

      return {
        name: meta.name,
        type: meta.mimeType,
        modified: meta.modifiedTime,
        link: meta.webViewLink,
        content: text.length > 40_000 ? `${text.slice(0, 40_000)}\n\n[truncated]` : text,
      };
    },
  },

  {
    name: "drive.create_doc",
    connector: "google",
    risk: "write",
    description:
      "Create a new Google Doc with the given content. Use when the user asks for a document, write-up, or report as a deliverable rather than as a chat response.",
    input: {
      type: "object",
      properties: {
        name: { type: "string", description: "Document title." },
        content: { type: "string", description: "Plain text body." },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
    preview: (input: { name: string; content: string }) =>
      `Create Google Doc "${input.name}" (${input.content.length} characters)`,
    async run(input: { name: string; content: string }) {
      // Uploading text/plain with a Docs target mime type makes Drive convert
      // it into a real Doc rather than an attached .txt file.
      const boundary = `jarvis${Date.now()}`;
      const metadata = JSON.stringify({
        name: input.name,
        mimeType: "application/vnd.google-apps.document",
      });

      const body = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        metadata,
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        input.content,
        `--${boundary}--`,
        "",
      ].join("\r\n");

      const res = await googleRaw(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
        {
          method: "POST",
          headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
          body,
        },
      );

      const file = (await res.json()) as { id: string; webViewLink: string };
      return `Created "${input.name}" — ${file.webViewLink}`;
    },
  },
];
