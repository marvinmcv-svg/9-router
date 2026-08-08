import { buildProvider, getProviderConfig, redact, setProviderConfig, type ProviderKind } from "@/kernel/provider";
import { getRoster, upsertAgent, type AgentDefinition } from "@/kernel/agents";

export const runtime = "nodejs";

/** Current model configuration (key redacted) and the agent roster. */
export async function GET(): Promise<Response> {
  return Response.json({
    provider: redact(await getProviderConfig()),
    agents: (await getRoster()).map((a) => ({
      ...a,
      // The roster is editable in the UI, but an agent's key lives in its
      // provider config and must not round-trip to the browser.
      model: a.model ? { ...a.model, apiKey: undefined } : undefined,
    })),
  });
}

interface Body {
  provider?: { kind?: ProviderKind; baseUrl?: string; apiKey?: string; model?: string; supportsThinking?: boolean };
  agent?: Partial<AgentDefinition> & { id: string };
  /** Send a one-token request to prove the configuration actually works. */
  test?: boolean;
}

export async function PATCH(request: Request): Promise<Response> {
  const body = (await request.json()) as Body;

  if (body.provider) await setProviderConfig(body.provider);
  if (body.agent) await upsertAgent(body.agent);

  if (body.test) {
    // Configuration that looks right and doesn't work is the most expensive
    // kind, so the UI can ask for a real round trip before trusting it.
    try {
      const provider = await buildProvider();
      const response = await provider.stream(
        {
          system: [{ type: "text", text: "Reply with the single word: ready" }],
          messages: [{ role: "user", content: "ping" }],
          tools: [],
          maxTokens: 32,
          signal: AbortSignal.timeout(45_000),
        },
        () => {},
      );
      const text = response.content
        .map((b) => ("text" in b ? b.text : ""))
        .join("")
        .trim();
      return Response.json({
        ok: true,
        model: provider.model,
        reply: text.slice(0, 200) || "(empty reply)",
        provider: redact(await getProviderConfig()),
      });
    } catch (err) {
      return Response.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        provider: redact(await getProviderConfig()),
      });
    }
  }

  return Response.json({
    ok: true,
    provider: redact(await getProviderConfig()),
    agents: await getRoster(),
  });
}
