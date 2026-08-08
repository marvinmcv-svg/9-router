import { run } from "@/kernel/agent";
import type { ApprovalDecision } from "@/kernel/types";

export const runtime = "nodejs";
// Agentic runs are long; never let the platform cut the stream mid-turn.
export const maxDuration = 300;

interface Body {
  sessionId: string;
  message?: string;
  decisions?: ApprovalDecision[];
  timezone?: string;
}

/**
 * The kernel endpoint. Streams kernel events back as SSE.
 *
 * The same endpoint starts a turn and resumes one that stopped for approval —
 * from the loop's point of view a decision is just another input, so the
 * client doesn't have to track which state it's resuming into.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.sessionId) {
    return Response.json({ error: "sessionId is required." }, { status: 400 });
  }

  const input = body.decisions
    ? ({ type: "decisions", decisions: body.decisions } as const)
    : body.message
      ? ({ type: "user", text: body.message } as const)
      : null;

  if (!input) {
    return Response.json({ error: "Provide either message or decisions." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const controller = new AbortController();
  // If the browser goes away mid-run, stop burning tokens on a turn nobody
  // will read.
  request.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (data: unknown) => {
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        for await (const event of run({
          sessionId: body.sessionId,
          input,
          timezone: body.timezone,
          signal: controller.signal,
        })) {
          send(event);
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        streamController.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and similar proxies buffer by default, which turns a live
      // stream into one delivery at the end.
      "X-Accel-Buffering": "no",
    },
  });
}
