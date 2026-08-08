import { latestResult, ROUTINES, runRoutine } from "@/routines";

export const runtime = "nodejs";
export const maxDuration = 800;

/** List routines with their most recent output. */
export async function GET(): Promise<Response> {
  const routines = await Promise.all(
    ROUTINES.map(async (r) => ({ ...r, latest: await latestResult(r.id) })),
  );
  return Response.json({ routines });
}

/**
 * Trigger a routine. Called by the host's scheduler (Vercel Cron, Railway,
 * or any cron that can issue an authenticated POST) and by the "run now"
 * button in the UI.
 */
export async function POST(request: Request): Promise<Response> {
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };

  const routine = ROUTINES.find((r) => r.id === id);
  if (!routine) {
    return Response.json(
      { error: `Unknown routine. Available: ${ROUTINES.map((r) => r.id).join(", ")}` },
      { status: 404 },
    );
  }

  // A scheduler-facing endpoint that starts a paid agent run must not be
  // open to the internet. When a secret is configured, require it; refuse to
  // run at all if one isn't set and we're not in development.
  const secret = process.env.JARVIS_CRON_SECRET;
  if (secret) {
    const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== secret) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return Response.json(
      { error: "Set JARVIS_CRON_SECRET before triggering routines in production." },
      { status: 503 },
    );
  }

  return Response.json({ result: await runRoutine(routine) });
}
