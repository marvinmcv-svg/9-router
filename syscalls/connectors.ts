/**
 * Connector registry.
 *
 * A connector is a credentialed integration. Syscalls declare which connector
 * they need, and the registry hides them when its credentials are missing —
 * so a fresh install exposes exactly the capabilities that actually work.
 */

export interface Connector {
  id: string;
  name: string;
  /** Written for the model: what this connector lets it reach. */
  description: string;
  /** Env vars that must all be present for the connector to be usable. */
  requires: string[];
  /** Where to get the credentials, shown in the UI when unconfigured. */
  setup: string;
}

export const CONNECTORS: Connector[] = [
  {
    id: "google",
    name: "Google Workspace",
    description:
      "Gmail, Calendar and Drive for the signed-in account — read mail and events, draft and send, schedule, search and read documents.",
    requires: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    setup:
      "Create an OAuth client at console.cloud.google.com, enable the Gmail, Calendar and Drive APIs, then connect from the Connectors panel.",
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "Repositories, issues, pull requests and CI status. Read code and history, open and comment on issues and PRs.",
    requires: ["GITHUB_TOKEN"],
    setup: "Create a fine-grained personal access token at github.com/settings/tokens.",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Projects, deployments and runtime logs. Check what shipped and why a build failed.",
    requires: ["VERCEL_TOKEN"],
    setup: "Create a token at vercel.com/account/tokens.",
  },
  {
    id: "railway",
    name: "Railway",
    description: "Services, deployments and logs for Railway-hosted infrastructure.",
    requires: ["RAILWAY_TOKEN"],
    setup: "Create a token at railway.app/account/tokens.",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Query the user's Postgres database and inspect its schema.",
    requires: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    setup: "Copy the project URL and service role key from the Supabase dashboard API settings.",
  },
];

export function connectorAvailable(id: string): boolean {
  const connector = CONNECTORS.find((c) => c.id === id);
  if (!connector) return false;
  return connector.requires.every((key) => Boolean(process.env[key]));
}

export function connectorStatus(): (Connector & { available: boolean; missing: string[] })[] {
  return CONNECTORS.map((c) => ({
    ...c,
    available: connectorAvailable(c.id),
    missing: c.requires.filter((key) => !process.env[key]),
  }));
}

/** Read a required env var, failing with a message the model can act on. */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `${key} is not configured. Tell the user to add it in .env.local and restart, then retry.`,
    );
  }
  return value;
}
