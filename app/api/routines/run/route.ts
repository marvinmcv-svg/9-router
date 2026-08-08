import { ROUTINES, runRoutine } from "@/routines";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Scheduler entry point.
 *
 * Separate from `/api/routines` because schedulers issue GET — Vercel Cron
 * has no way to send a POST body, so the routine id travels in the query
 * string and the secret in the Authorization header.
 */
export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  const routine = ROUTINES.find((r) => r.id === id);

  if (!routine) {
    return Response.json(
      { error: `Unknown routine. Available: ${ROUTINES.map((r) => r.id).join(", ")}` },
      { status: 404 },
    );
  }

  // This endpoint starts a paid agent run with full access to the user's
  // accounts. It must never be callable by anyone who finds the URL.
  const secret = process.env.JARVIS_CRON_SECRET ?? process.env.CRON_SECRET;
  if (secret) {
    const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== secret) return Response.json({ error: "Unauthorized." }, { status: 401 });
  } else if (process.env.NODE_ENV === "production") {
    return Response.json(
      { error: "Set JARVIS_CRON_SECRET before scheduling routines in production." },
      { status: 503 },
    );
  }

  return Response.json({ result: await runRoutine(routine) });
}
