import type Anthropic from "@anthropic-ai/sdk";
import { store } from "@/lib/store";

/**
 * Model provider abstraction.
 *
 * JARVIS is not tied to one vendor. The kernel speaks Anthropic's content-block
 * shape as its canonical form — it is the most expressive of the wire formats
 * (thinking blocks, typed tool_use, cache control) — and each provider adapter
 * translates at the boundary. Adding a provider means implementing `stream`;
 * nothing in the loop, the permission engine, or the UI changes.
 */

export type ProviderKind = "anthropic" | "anthropic-compatible" | "openai-compatible";

export interface ProviderConfig {
  kind: ProviderKind;
  /** API base URL. Ignored for `anthropic` unless explicitly overridden. */
  baseUrl?: string;
  apiKey?: string;
  model: string;
  /** Providers that don't implement extended thinking must not be sent it. */
  supportsThinking?: boolean;
}

/** Canonical request, in Anthropic's shape. */
export interface ModelRequest {
  system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  content: Anthropic.ContentBlockParam[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheRead: number };
}

export type Delta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string };

export interface Provider {
  readonly kind: ProviderKind;
  readonly model: string;
  stream(request: ModelRequest, onDelta: (delta: Delta) => void): Promise<ModelResponse>;
}

const CONFIG_KEY = "provider";

/**
 * Sensible per-vendor defaults, so a user who supplies only a key and a base
 * URL doesn't have to know which capabilities their endpoint implements.
 */
function defaultsFor(kind: ProviderKind): Partial<ProviderConfig> {
  switch (kind) {
    case "anthropic":
      return { model: "claude-opus-5", supportsThinking: true };
    case "anthropic-compatible":
      // GLM/Z.ai and most compatible gateways accept Anthropic's message shape
      // but reject `thinking` and `output_config`, so both are off by default.
      return { model: "glm-4.6", supportsThinking: false };
    case "openai-compatible":
      return { model: "gpt-4o", supportsThinking: false };
  }
}

/**
 * Resolve the active configuration.
 *
 * Stored config (set in the UI) wins over environment, so a user can switch
 * models at runtime without a redeploy — but env provides the bootstrap so a
 * fresh install is usable before anyone opens the settings panel.
 */
export async function getProviderConfig(): Promise<ProviderConfig> {
  const saved = await store.get<ProviderConfig>(CONFIG_KEY);
  if (saved?.apiKey) return saved;

  const kind = (process.env.JARVIS_PROVIDER as ProviderKind) ?? "anthropic";
  const defaults = defaultsFor(kind);

  return {
    kind,
    baseUrl: process.env.JARVIS_BASE_URL_MODEL ?? undefined,
    apiKey: process.env.JARVIS_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    model: process.env.JARVIS_MODEL ?? defaults.model!,
    supportsThinking: process.env.JARVIS_THINKING
      ? process.env.JARVIS_THINKING === "true"
      : defaults.supportsThinking,
  };
}

export async function setProviderConfig(config: Partial<ProviderConfig>): Promise<ProviderConfig> {
  const current = await getProviderConfig();
  const kind = config.kind ?? current.kind;
  // Switching provider kind resets capability flags to that vendor's
  // defaults, otherwise a stale `supportsThinking` from the previous provider
  // produces 400s that look like the new endpoint is broken.
  const defaults = config.kind && config.kind !== current.kind ? defaultsFor(config.kind) : {};

  const next: ProviderConfig = {
    ...current,
    ...defaults,
    ...config,
    kind,
    // An empty string from a cleared form field must not wipe a working key.
    apiKey: config.apiKey?.trim() ? config.apiKey.trim() : current.apiKey,
  };

  await store.set(CONFIG_KEY, next);
  return next;
}

/** Redacted view for the UI — the key must never round-trip to the browser. */
export function redact(config: ProviderConfig) {
  const key = config.apiKey;
  return {
    kind: config.kind,
    baseUrl: config.baseUrl,
    model: config.model,
    supportsThinking: config.supportsThinking ?? false,
    hasKey: Boolean(key),
    keyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
  };
}

export async function buildProvider(override?: Partial<ProviderConfig>): Promise<Provider> {
  const config = { ...(await getProviderConfig()), ...override };

  if (!config.apiKey) {
    throw new Error(
      "No model API key configured. Add one in the Model panel, or set JARVIS_API_KEY in .env.local.",
    );
  }

  if (config.kind === "openai-compatible") {
    const { OpenAICompatibleProvider } = await import("./providers/openai");
    return new OpenAICompatibleProvider(config);
  }

  const { AnthropicProvider } = await import("./providers/anthropic");
  return new AnthropicProvider(config);
}
