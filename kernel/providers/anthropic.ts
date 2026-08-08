import Anthropic from "@anthropic-ai/sdk";
import type { Delta, ModelRequest, ModelResponse, Provider, ProviderConfig } from "../provider";

/**
 * Anthropic and Anthropic-compatible endpoints.
 *
 * Covers the first-party API and every gateway that speaks its message format
 * — Z.ai/GLM, LiteLLM, OpenRouter's Anthropic surface, and self-hosted proxies.
 * The difference is mostly which optional features the endpoint tolerates, so
 * capability-gated fields are omitted rather than sent and hoped for.
 */
export class AnthropicProvider implements Provider {
  readonly kind = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      // Compatible gateways are frequently slower and flakier than the
      // first-party API; a long agentic turn shouldn't die on one blip.
      maxRetries: 3,
    });
  }

  async stream(request: ModelRequest, onDelta: (delta: Delta) => void): Promise<ModelResponse> {
    const thinking = this.config.supportsThinking
      ? ({ type: "adaptive", display: "summarized" } as const)
      : undefined;

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        ...(thinking ? { thinking, output_config: { effort: "high" as const } } : {}),
      },
      { signal: request.signal },
    );

    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") {
        onDelta({ type: "text", text: event.delta.text });
      } else if (event.delta.type === "thinking_delta") {
        onDelta({ type: "thinking", text: event.delta.thinking });
      }
    }

    const message = await stream.finalMessage();

    return {
      content: message.content as Anthropic.ContentBlockParam[],
      stopReason: message.stop_reason,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
