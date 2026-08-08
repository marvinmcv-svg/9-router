import type { Syscall } from "@/kernel/types";
import { requireEnv } from "./connectors";

/**
 * Deployment and database syscalls — Vercel, Railway, Supabase.
 *
 * Everything here is read-only by design. Triggering a production deploy or
 * mutating a database from a chat message is a category of action that
 * deserves a deliberate decision rather than an approval card in the middle
 * of a conversation, so JARVIS observes infrastructure and reports; a human
 * pushes the button.
 */

export const infraSyscalls: Syscall[] = [
  {
    name: "vercel.list_deployments",
    connector: "vercel",
    risk: "read",
    description:
      "List recent Vercel deployments with their state, commit and age. Call this when the user asks what shipped, whether a deploy succeeded, or what's currently live.",
    input: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id. Omit for all projects." },
        limit: { type: "integer", description: "Maximum deployments. Default 10." },
      },
      additionalProperties: false,
    },
    async run(input: { project?: string; limit?: number }) {
      const params = new URLSearchParams({ limit: String(Math.min(input.limit ?? 10, 50)) });
      if (input.project) params.set("app", input.project);

      const res = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
        headers: { Authorization: `Bearer ${requireEnv("VERCEL_TOKEN")}` },
      });
      if (!res.ok) throw new Error(`Vercel ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const data = (await res.json()) as {
        deployments: {
          uid: string;
          name: string;
          url: string;
          state: string;
          created: number;
          target?: string;
          meta?: Record<string, string>;
        }[];
      };

      if (!data.deployments.length) return "No deployments found.";
      return data.deployments.map((d) => ({
        id: d.uid,
        project: d.name,
        url: `https://${d.url}`,
        state: d.state,
        target: d.target ?? "preview",
        commitMessage: d.meta?.githubCommitMessage,
        branch: d.meta?.githubCommitRef,
        createdAt: new Date(d.created).toISOString(),
      }));
    },
  },

  {
    name: "vercel.build_logs",
    connector: "vercel",
    risk: "read",
    description:
      "Fetch build logs for a Vercel deployment. Call this after vercel.list_deployments shows a failed state — read the actual error before speculating about the cause.",
    input: {
      type: "object",
      properties: {
        deploymentId: { type: "string", description: "Deployment id from vercel.list_deployments." },
      },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    async run(input: { deploymentId: string }) {
      const res = await fetch(
        `https://api.vercel.com/v2/deployments/${input.deploymentId}/events?limit=200`,
        { headers: { Authorization: `Bearer ${requireEnv("VERCEL_TOKEN")}` } },
      );
      if (!res.ok) throw new Error(`Vercel ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const events = (await res.json()) as { type: string; payload?: { text?: string } }[];
      const text = events
        .map((e) => e.payload?.text)
        .filter(Boolean)
        .join("\n");

      // Failures announce themselves at the end of the log, so keep the tail.
      return text.length > 15_000 ? `[earlier output trimmed]\n${text.slice(-15_000)}` : text;
    },
  },

  {
    name: "railway.list_services",
    connector: "railway",
    risk: "read",
    description:
      "List Railway projects and their services with current deployment status. Use when the user asks about backend infrastructure hosted on Railway.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const query = `
        query {
          me {
            projects {
              edges { node {
                id name
                services { edges { node { id name } } }
              } }
            }
          }
        }`;

      const res = await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requireEnv("RAILWAY_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`Railway ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const body = (await res.json()) as {
        data?: {
          me: {
            projects: {
              edges: {
                node: {
                  id: string;
                  name: string;
                  services: { edges: { node: { id: string; name: string } }[] };
                };
              }[];
            };
          };
        };
        errors?: { message: string }[];
      };

      if (body.errors?.length) throw new Error(`Railway: ${body.errors[0].message}`);

      const projects = body.data?.me.projects.edges ?? [];
      if (!projects.length) return "No Railway projects found.";

      return projects.map(({ node }) => ({
        project: node.name,
        projectId: node.id,
        services: node.services.edges.map((e) => ({ id: e.node.id, name: e.node.name })),
      }));
    },
  },

  {
    name: "supabase.query",
    connector: "supabase",
    risk: "read",
    description:
      "Run a read-only SQL SELECT against the user's Supabase database and return the rows. Use for answering questions about their application data. Only SELECT is permitted — the syscall rejects anything that writes.",
    input: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    async run(input: { sql: string }) {
      const sql = input.sql.trim().replace(/;\s*$/, "");

      // Read-only is enforced here, not just described in the tool
      // description — a syscall marked `read` must be structurally incapable
      // of writing, or the whole permission model is a suggestion.
      if (!/^select\b/i.test(sql)) {
        throw new Error("Only SELECT statements are allowed through supabase.query.");
      }
      if (/;/.test(sql)) {
        throw new Error("Multiple statements are not allowed — send a single SELECT.");
      }
      if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b/i.test(sql)) {
        throw new Error("That statement contains a write keyword and was rejected.");
      }

      const res = await fetch(
        `${requireEnv("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/rpc/jarvis_readonly_query`,
        {
          method: "POST",
          headers: {
            apikey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
            Authorization: `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query_text: sql }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404) {
          throw new Error(
            "The jarvis_readonly_query function is missing. Tell the user to run supabase/schema.sql against their database.",
          );
        }
        throw new Error(`Supabase ${res.status}: ${body.slice(0, 400)}`);
      }

      const rows = await res.json();
      const text = JSON.stringify(rows, null, 2);
      return text.length > 20_000 ? `${text.slice(0, 20_000)}\n[truncated — add a LIMIT]` : text;
    },
  },
];
