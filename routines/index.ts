import { newSessionId, run } from "@/kernel/agent";
import { store } from "@/lib/store";

/**
 * Routines — the daemons that make JARVIS feel like it's running rather than
 * waiting.
 *
 * A routine is a scheduled prompt executed in a fresh session. It runs under
 * the same permission policy as an interactive turn, which matters: an
 * unattended run has no one to click approve, so anything needing approval
 * parks and surfaces in the UI next time the user looks, rather than acting
 * unilaterally at 6am.
 */

export interface Routine {
  id: string;
  name: string;
  description: string;
  /** Cron expression, UTC. Documented for the host's scheduler to match. */
  schedule: string;
  prompt: string;
}

export const ROUTINES: Routine[] = [
  {
    id: "morning-brief",
    name: "Morning brief",
    description: "What today looks like: schedule, mail that needs a reply, anything broken.",
    schedule: "0 12 * * 1-5",
    prompt: `Prepare my morning brief. Work through this and then write it up:

1. Today's calendar — what's on, when, and anything that needs preparation.
2. Mail from the last 24 hours that plausibly needs a reply from me. Skip
   newsletters and automated notifications.
3. If I have GitHub connected: pull requests waiting on my review, and any CI
   that's currently failing on my repositories.
4. Anything in memory flagged as due or pending that I should be reminded of.

Write it as a short brief I can read in under a minute. Lead with the single
most important thing. If something needs action from me, say what and why — but
don't send anything or change anything, just tell me.`,
  },
  {
    id: "evening-wrap",
    name: "Evening wrap",
    description: "What happened today, what slipped, what tomorrow looks like.",
    schedule: "0 1 * * 2-6",
    prompt: `Wrap up my day. Check what happened across my connected systems today
— meetings that took place, mail that arrived and whether it was handled, code
that shipped or broke.

Then record anything durable in memory: decisions that were made, commitments I
took on, people or projects that came up for the first time.

Finish with a two-line preview of tomorrow. Keep the whole thing short.`,
  },
];

export interface RoutineResult {
  routineId: string;
  sessionId: string;
  ranAt: string;
  output: string;
  awaitingApproval: boolean;
  error?: string;
}

/** Run a routine to completion and store its output for the UI to surface. */
export async function runRoutine(routine: Routine): Promise<RoutineResult> {
  const sessionId = newSessionId();
  let output = "";
  let awaitingApproval = false;
  let error: string | undefined;

  for await (const event of run({
    sessionId,
    input: { type: "user", text: routine.prompt },
    timezone: process.env.JARVIS_TIMEZONE ?? "UTC",
  })) {
    if (event.type === "text") output += event.text;
    if (event.type === "approval_required") awaitingApproval = true;
    if (event.type === "error") error = event.message;
  }

  const result: RoutineResult = {
    routineId: routine.id,
    sessionId,
    ranAt: new Date().toISOString(),
    output: output.trim(),
    awaitingApproval,
    error,
  };

  await store.set(`routines/${routine.id}/latest`, result);
  return result;
}

export async function latestResult(routineId: string): Promise<RoutineResult | null> {
  return store.get<RoutineResult>(`routines/${routineId}/latest`);
}
