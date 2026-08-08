import { decide, getPolicy, setOverride, type Policy } from "@/kernel/permissions";
import { allRegistered } from "@/kernel/registry";
import { connectorAvailable, connectorStatus } from "@/syscalls/connectors";
import { isConnected } from "@/syscalls/google/auth";
import { listSessions } from "@/kernel/session";
import { all as allMemory, forget } from "@/kernel/memory";
import { storeBackend } from "@/lib/store";

export const runtime = "nodejs";

/** Everything the OS shell needs to render its panels, in one request. */
export async function GET(): Promise<Response> {
  const policy = await getPolicy();

  // Google is the one connector where configured credentials aren't enough —
  // it also needs the user to have completed the OAuth grant.
  const googleAuthorized = await isConnected().catch(() => false);

  const syscalls = allRegistered()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      name: s.name,
      summary: s.description.split(". ")[0],
      risk: s.risk,
      connector: s.connector ?? "core",
      available: !s.connector || connectorAvailable(s.connector),
      decision: decide(s, policy),
    }));

  const connectors = connectorStatus().map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    configured: c.available,
    ready: c.id === "google" ? c.available && googleAuthorized : c.available,
    missing: c.missing,
    setup: c.setup,
  }));

  return Response.json({
    storeBackend,
    policy,
    syscalls,
    connectors,
    sessions: await listSessions(),
    memory: await allMemory(),
  });
}

interface PatchBody {
  syscall?: string;
  decision?: "allow" | "ask" | "deny" | null;
  policy?: Policy;
  forgetMemoryId?: string;
}

/** Change a syscall's permission, or delete a memory record. */
export async function PATCH(request: Request): Promise<Response> {
  const body = (await request.json()) as PatchBody;

  if (body.forgetMemoryId) {
    return Response.json({ ok: await forget(body.forgetMemoryId) });
  }

  if (body.syscall) {
    return Response.json({ policy: await setOverride(body.syscall, body.decision ?? null) });
  }

  return Response.json({ error: "Nothing to update." }, { status: 400 });
}
