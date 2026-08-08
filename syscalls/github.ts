import type { Syscall } from "@/kernel/types";
import { requireEnv } from "./connectors";

const API = "https://api.github.com";

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 400)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const githubSyscalls: Syscall[] = [
  {
    name: "github.search_issues",
    connector: "github",
    risk: "read",
    description:
      "Search issues and pull requests across the user's repositories using GitHub search syntax. Call this when a request concerns open work, review load, or the state of a specific change. Examples: 'is:open is:pr review-requested:@me', 'repo:org/app is:issue label:bug'.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "GitHub issue search query." },
        limit: { type: "integer", description: "Maximum results. Default 20." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input: { query: string; limit?: number }) {
      const params = new URLSearchParams({
        q: input.query,
        per_page: String(Math.min(input.limit ?? 20, 50)),
        sort: "updated",
      });
      const data = await gh<{
        total_count: number;
        items: {
          number: number;
          title: string;
          state: string;
          html_url: string;
          repository_url: string;
          user: { login: string };
          updated_at: string;
          draft?: boolean;
          pull_request?: unknown;
        }[];
      }>(`/search/issues?${params}`);

      if (!data.items.length) return `No results for "${input.query}".`;

      return data.items.map((i) => ({
        repo: i.repository_url.replace(`${API}/repos/`, ""),
        number: i.number,
        title: i.title,
        kind: i.pull_request ? (i.draft ? "draft PR" : "PR") : "issue",
        state: i.state,
        author: i.user.login,
        updated: i.updated_at,
        url: i.html_url,
      }));
    },
  },

  {
    name: "github.read_file",
    connector: "github",
    risk: "read",
    description:
      "Read a file from a repository at a given ref. Use to ground answers about the user's code in what the code actually says.",
    input: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, e.g. 'acme/api'." },
        path: { type: "string", description: "File path within the repo." },
        ref: { type: "string", description: "Branch, tag or SHA. Defaults to the default branch." },
      },
      required: ["repo", "path"],
      additionalProperties: false,
    },
    async run(input: { repo: string; path: string; ref?: string }) {
      const query = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
      const file = await gh<{ content: string; encoding: string; size: number; html_url: string }>(
        `/repos/${input.repo}/contents/${input.path}${query}`,
      );

      if (file.encoding !== "base64") {
        throw new Error(`Unexpected encoding ${file.encoding} — the path may be a directory.`);
      }
      const content = Buffer.from(file.content, "base64").toString("utf8");
      return {
        path: input.path,
        size: file.size,
        url: file.html_url,
        content: content.length > 40_000 ? `${content.slice(0, 40_000)}\n[truncated]` : content,
      };
    },
  },

  {
    name: "github.check_runs",
    connector: "github",
    risk: "read",
    description:
      "Check CI status for a branch or commit — which checks passed, which failed. Call this when the user asks whether something is green, or before claiming a change is ready to merge.",
    input: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name." },
        ref: { type: "string", description: "Branch name or commit SHA." },
      },
      required: ["repo", "ref"],
      additionalProperties: false,
    },
    async run(input: { repo: string; ref: string }) {
      const data = await gh<{
        check_runs: {
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          completed_at: string | null;
        }[];
      }>(`/repos/${input.repo}/commits/${encodeURIComponent(input.ref)}/check-runs`);

      if (!data.check_runs.length) return `No checks reported for ${input.ref}.`;
      return data.check_runs.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        finished: c.completed_at,
        url: c.html_url,
      }));
    },
  },

  {
    name: "github.comment",
    connector: "github",
    risk: "write",
    description:
      "Post a comment on an issue or pull request. This is publicly visible to everyone with repo access, so the approval card shows the full comment body.",
    input: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name." },
        number: { type: "integer", description: "Issue or PR number." },
        body: { type: "string", description: "Markdown comment body." },
      },
      required: ["repo", "number", "body"],
      additionalProperties: false,
    },
    preview: (input: { repo: string; number: number; body: string }) =>
      `Comment on ${input.repo}#${input.number}:\n\n${input.body}`,
    async run(input: { repo: string; number: number; body: string }) {
      const comment = await gh<{ html_url: string }>(
        `/repos/${input.repo}/issues/${input.number}/comments`,
        { method: "POST", body: JSON.stringify({ body: input.body }) },
      );
      return `Commented on ${input.repo}#${input.number} — ${comment.html_url}`;
    },
  },

  {
    name: "github.create_issue",
    connector: "github",
    risk: "write",
    description:
      "Open a new issue. Use when the user wants work tracked rather than done right now — a bug they noticed, a follow-up they want remembered somewhere their team can see.",
    input: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name." },
        title: { type: "string" },
        body: { type: "string", description: "Markdown body." },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["repo", "title", "body"],
      additionalProperties: false,
    },
    preview: (input: { repo: string; title: string; body: string }) =>
      `Open issue in ${input.repo}: "${input.title}"\n\n${input.body}`,
    async run(input: { repo: string; title: string; body: string; labels?: string[] }) {
      const issue = await gh<{ number: number; html_url: string }>(
        `/repos/${input.repo}/issues`,
        {
          method: "POST",
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            labels: input.labels,
          }),
        },
      );
      return `Opened ${input.repo}#${issue.number} — ${issue.html_url}`;
    },
  },
];
