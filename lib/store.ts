import fs from "node:fs/promises";
import path from "node:path";

/**
 * Key/value persistence for kernel state — policy, memory, sessions, routines.
 *
 * Two backends. Supabase when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are
 * set (required on serverless hosts, where the filesystem is ephemeral and not
 * shared between invocations), and a JSON directory otherwise so `npm run dev`
 * works with zero setup.
 *
 * The Supabase backend expects a table created by `supabase/schema.sql`.
 */

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys beginning with `prefix`, for scanning memory and sessions. */
  list(prefix: string): Promise<string[]>;
}

const DATA_DIR = process.env.JARVIS_DATA_DIR ?? path.join(process.cwd(), ".jarvis");

/** Key → filename. Slashes become `__` so keys can be namespaced safely. */
function keyToFile(key: string): string {
  if (!/^[A-Za-z0-9._:/-]+$/.test(key)) throw new Error(`Unsafe store key: ${key}`);
  return path.join(DATA_DIR, `${key.replace(/\//g, "__")}.json`);
}

const fileStore: Store = {
  async get<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(keyToFile(key), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const file = keyToFile(key);
    // Write-then-rename so a crash mid-write can't leave truncated JSON.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tmp, file);
  },
  async delete(key: string): Promise<void> {
    await fs.rm(keyToFile(key), { force: true });
  },
  async list(prefix: string): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(DATA_DIR);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length).replace(/__/g, "/"))
      .filter((k) => k.startsWith(prefix));
  },
};

function supabaseStore(url: string, serviceKey: string): Store {
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/jarvis_kv`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  async function request(init: RequestInit & { query?: string }): Promise<Response> {
    const res = await fetch(`${endpoint}${init.query ?? ""}`, { ...init, headers });
    if (!res.ok) {
      throw new Error(`Supabase store ${init.method ?? "GET"} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const res = await request({ query: `?key=eq.${encodeURIComponent(key)}&select=value` });
      const rows = (await res.json()) as { value: T }[];
      return rows.length ? rows[0].value : null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await request({
        method: "POST",
        query: "?on_conflict=key",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      });
    },
    async delete(key: string): Promise<void> {
      await request({ method: "DELETE", query: `?key=eq.${encodeURIComponent(key)}` });
    },
    async list(prefix: string): Promise<string[]> {
      const res = await request({ query: `?key=like.${encodeURIComponent(`${prefix}%`)}&select=key` });
      return ((await res.json()) as { key: string }[]).map((r) => r.key);
    },
  };
}

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const store: Store = url && serviceKey ? supabaseStore(url, serviceKey) : fileStore;

export const storeBackend = url && serviceKey ? "supabase" : "filesystem";
