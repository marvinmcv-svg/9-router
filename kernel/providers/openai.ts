import type Anthropic from "@anthropic-ai/sdk";
import type { Delta, ModelRequest, ModelResponse, Provider, ProviderConfig } from "../provider";

/**
 * OpenAI-compatible endpoints — OpenRouter, Ollama, vLLM, llama.cpp, LM Studio,
 * Together, Groq, and anything else exposing `/chat/completions`.
 *
 * This is what lets a self-hosted or open-weights model act as a JARVIS agent.
 * The kernel's canonical form is Anthropic-shaped, so everything here is
 * translation in both directions.
 */

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export class OpenAICompatibleProvider implements Provider {
  readonly kind = "openai-compatible" as const;
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey!;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async stream(request: ModelRequest, onDelta: (delta: Delta) => void): Promise<ModelResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        stream: true,
        // Not every gateway returns usage on streamed responses; asking for it
        // is harmless where unsupported and avoids a second call where it works.
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: request.system.map((s) => s.text).join("\n\n") },
          ...toOpenAIMessages(request.messages),
        ],
        ...(request.tools.length
          ? {
              tools: request.tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.input_schema,
                },
              })),
            }
          : {}),
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(
        `Model endpoint ${res.status} at ${this.baseUrl}: ${(await res.text()).slice(0, 400)}`,
      );
    }

    let text = "";
    // Tool call arguments arrive as JSON fragments spread across many deltas,
    // keyed by index rather than id, so they must be reassembled positionally.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0 };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk: {
          choices?: { delta?: Partial<OpenAIMessage>; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          // Some gateways emit keep-alive comments or partial frames; a bad
          // parse on one chunk shouldn't abort the whole turn.
          continue;
        }

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheRead: 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stopReason = choice.finish_reason;

        const content = choice.delta?.content;
        if (content) {
          text += content;
          onDelta({ type: "text", text: content });
        }

        for (const [index, call] of Object.entries(choice.delta?.tool_calls ?? {})) {
          const delta = call as unknown as {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          const slot = delta.index ?? Number(index);
          const existing = toolCalls.get(slot) ?? { id: "", name: "", args: "" };
          toolCalls.set(slot, {
            id: delta.id ?? existing.id,
            name: delta.function?.name ?? existing.name,
            args: existing.args + (delta.function?.arguments ?? ""),
          });
        }
      }
    }

    const blocks: Anthropic.ContentBlockParam[] = [];
    if (text) blocks.push({ type: "text", text });

    for (const [slot, call] of toolCalls) {
      let input: unknown = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        // A model that emits malformed arguments should get a tool error back
        // rather than crashing the loop, so pass the raw text through and let
        // the syscall's own validation reject it.
        input = { __malformed_arguments: call.args };
      }
      blocks.push({
        type: "tool_use",
        // Some gateways omit ids entirely; the kernel needs a stable one to
        // match tool_result blocks against.
        id: call.id || `call_${slot}_${Date.now()}`,
        name: call.name,
        input,
      });
    }

    return {
      content: blocks,
      stopReason: toolCalls.size ? "tool_use" : stopReason === "stop" ? "end_turn" : stopReason,
      usage,
    };
  }
}

/** Anthropic message blocks → OpenAI chat messages. */
function toOpenAIMessages(messages: Anthropic.MessageParam[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
    );
    const toolResults = message.content.filter(
      (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result",
    );

    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolUses.length
          ? {
              tool_calls: toolUses.map((t) => ({
                id: t.id,
                type: "function" as const,
                function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    // Tool results are their own role in OpenAI's format, and must come before
    // any accompanying user text or the assistant turn they answer is orphaned.
    for (const result of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content:
          typeof result.content === "string"
            ? result.content
            : (result.content ?? [])
                .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                .join("\n"),
      });
    }

    if (text) out.push({ role: "user", content: text });
  }

  return out;
}
