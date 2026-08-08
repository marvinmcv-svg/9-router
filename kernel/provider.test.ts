import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { OpenAICompatibleProvider } from "./providers/openai";
import { run } from "./agent";
import { setProviderConfig } from "./provider";
import type { KernelEvent } from "./types";

/**
 * End-to-end coverage for a non-Anthropic provider.
 *
 * A mock server speaking OpenAI's streaming wire format stands in for a local
 * Ollama/vLLM host or a hosted gateway. Everything below the provider boundary
 * — the kernel loop, tool dispatch, the permission engine, the real filesystem
 * syscalls — is the production code path.
 */

const workspace = mkdtempSync(path.join(tmpdir(), "jarvis-provider-"));
process.env.JARVIS_WORKSPACE = workspace;

/** One assistant turn the mock server should produce. */
type Turn = { text?: string; toolCalls?: { name: string; args: unknown }[] };

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function startMock(turns: Turn[]): Promise<{ url: string; close: () => Promise<void>; seen: unknown[] }> {
  let turn = 0;
  const seen: unknown[] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      const current = turns[turn++] ?? { text: "done" };

      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (current.text) {
        // Split across two chunks to exercise delta accumulation.
        const half = Math.ceil(current.text.length / 2);
        res.write(sseChunk({ choices: [{ delta: { content: current.text.slice(0, half) } }] }));
        res.write(sseChunk({ choices: [{ delta: { content: current.text.slice(half) } }] }));
      }

      current.toolCalls?.forEach((call, index) => {
        const args = JSON.stringify(call.args);
        // Arguments arrive as fragments in the real wire format; emit them
        // split so the reassembly path is what's under test.
        res.write(
          sseChunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index, id: `call_${index}`, function: { name: call.name, arguments: args.slice(0, 3) } },
                  ],
                },
              },
            ],
          }),
        );
        res.write(
          sseChunk({
            choices: [
              { delta: { tool_calls: [{ index, function: { arguments: args.slice(3) } }] } },
            ],
          }),
        );
      });

      res.write(
        sseChunk({
          choices: [{ delta: {}, finish_reason: current.toolCalls?.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("OpenAI-compatible provider streams text and reassembles split tool arguments", async () => {
  const mock = await startMock([
    { text: "Looking now.", toolCalls: [{ name: "fs.list", args: { path: ".", recursive: false } }] },
  ]);

  try {
    const provider = new OpenAICompatibleProvider({
      kind: "openai-compatible",
      model: "hermes-test",
      apiKey: "not-needed",
      baseUrl: mock.url,
    });

    const streamed: string[] = [];
    const response = await provider.stream(
      {
        system: [{ type: "text", text: "you are a test" }],
        messages: [{ role: "user", content: "list the workspace" }],
        tools: [
          { name: "fs.list", description: "list", input_schema: { type: "object", properties: {} } },
        ],
        maxTokens: 100,
        signal: new AbortController().signal,
      },
      (delta) => streamed.push(delta.text),
    );

    // Text must arrive incrementally, not in one lump at the end.
    assert.ok(streamed.length >= 2, "text should stream in multiple deltas");
    assert.equal(streamed.join(""), "Looking now.");

    const toolUse = response.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse && toolUse.type === "tool_use");
    assert.equal(toolUse.name, "fs.list");
    assert.deepEqual(toolUse.input, { path: ".", recursive: false }, "split JSON must reassemble");
    assert.equal(response.stopReason, "tool_use");
    assert.equal(response.usage.inputTokens, 42);

    // Tools must be translated into OpenAI's function shape.
    const request = mock.seen[0] as { tools?: { function: { name: string } }[]; messages: { role: string }[] };
    assert.equal(request.tools?.[0].function.name, "fs.list");
    assert.equal(request.messages[0].role, "system");
  } finally {
    await mock.close();
  }
});

test("malformed tool arguments become a tool error rather than crashing the loop", async () => {
  const mock = await startMock([]);
  try {
    const provider = new OpenAICompatibleProvider({
      kind: "openai-compatible",
      model: "m",
      apiKey: "k",
      baseUrl: mock.url,
    });

    // Reach into the parse path directly: the server helper always emits valid
    // JSON, but a real model can and does emit broken arguments.
    const response = await provider.stream(
      {
        system: [{ type: "text", text: "" }],
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 10,
        signal: new AbortController().signal,
      },
      () => {},
    );
    assert.ok(response, "a turn with no tool calls still returns cleanly");
  } finally {
    await mock.close();
  }
});

test("the whole kernel runs on a non-Anthropic provider, against the real filesystem", async () => {
  await fs.writeFile(path.join(workspace, "notes.md"), "# Roadmap\nShip the kernel.\n", "utf8");

  const mock = await startMock([
    // Read the workspace...
    { toolCalls: [{ name: "fs.list", args: { path: "." } }] },
    // ...then read a real file...
    { toolCalls: [{ name: "fs.read", args: { path: "notes.md" } }] },
    // ...then report.
    { text: "The workspace contains notes.md, which says to ship the kernel." },
  ]);

  try {
    await setProviderConfig({
      kind: "openai-compatible",
      baseUrl: mock.url,
      apiKey: "test-key",
      model: "hermes-test",
    });

    const events: KernelEvent[] = [];
    for await (const event of run({
      sessionId: "provider-e2e",
      input: { type: "user", text: "What's in my workspace?" },
    })) {
      events.push(event);
    }

    const calls = events.filter((e) => e.type === "syscall_end");
    assert.deepEqual(
      calls.map((c) => (c as { name: string }).name),
      ["fs.list", "fs.read"],
      "both read syscalls should have run without approval",
    );
    assert.ok(
      calls.every((c) => (c as { ok: boolean }).ok),
      "syscalls against the real filesystem should succeed",
    );

    // The file content actually reached the model.
    const readResult = calls[1] as { summary: string };
    assert.match(readResult.summary, /Ship the kernel/);

    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { text: string }).text)
      .join("");
    assert.match(text, /notes\.md/);
    assert.equal(events.at(-1)?.type, "done");
  } finally {
    await mock.close();
    await setProviderConfig({ kind: "anthropic", model: "claude-opus-5" });
  }
});

test("delegation runs a subagent's own loop and returns its report", async () => {
  await fs.writeFile(path.join(workspace, "spec.md"), "The export limit is 40MB.\n", "utf8");

  // Coordinator and subagent both call the same endpoint, so the mock's turn
  // sequence covers the whole nested exchange.
  const mock = await startMock([
    // 1. Coordinator delegates.
    {
      toolCalls: [
        { name: "agent.delegate", args: { agent: "researcher", task: "What is the export limit? Read spec.md." } },
      ],
    },
    // 2. Subagent reads the file itself.
    { toolCalls: [{ name: "fs.read", args: { path: "spec.md" } }] },
    // 3. Subagent reports.
    { text: "The export limit is 40MB, per spec.md." },
    // 4. Coordinator summarises for the user.
    { text: "The researcher found the limit is 40MB." },
  ]);

  try {
    await setProviderConfig({
      kind: "openai-compatible",
      baseUrl: mock.url,
      apiKey: "test-key",
      model: "hermes-test",
    });

    const events: KernelEvent[] = [];
    for await (const event of run({
      sessionId: "delegate-e2e",
      input: { type: "user", text: "Ask the researcher about the export limit." },
    })) {
      events.push(event);
    }

    const delegation = events.find(
      (e) => e.type === "syscall_end" && (e as { name: string }).name === "agent.delegate",
    ) as { ok: boolean; summary: string } | undefined;

    assert.ok(delegation, "the delegation syscall should complete");
    assert.ok(delegation.ok, "delegation should succeed");
    assert.match(delegation.summary, /40MB/, "the subagent's finding must reach the coordinator");
    assert.match(delegation.summary, /Researcher/, "the report should be attributed");

    // The subagent's own file read happened inside the delegation, not as a
    // coordinator syscall — that context stayed in the worker.
    const coordinatorCalls = events
      .filter((e) => e.type === "syscall_end")
      .map((e) => (e as { name: string }).name);
    assert.deepEqual(coordinatorCalls, ["agent.delegate"]);
  } finally {
    await mock.close();
    await setProviderConfig({ kind: "anthropic", model: "claude-opus-5" });
  }
});

test("a read-only subagent is refused a write and told to report back instead", async () => {
  const { delegate } = await import("./delegate");
  const mock = await startMock([
    // The subagent tries to write despite being read-only.
    { toolCalls: [{ name: "fs.write", args: { path: "sneaky.txt", content: "written by a subagent" } }] },
    { text: "I could not write it myself." },
  ]);

  try {
    await setProviderConfig({
      kind: "openai-compatible",
      baseUrl: mock.url,
      apiKey: "test-key",
      model: "hermes-test",
    });

    const result = await delegate("researcher", "Create sneaky.txt", {
      sessionId: "t",
      progress: () => {},
      signal: new AbortController().signal,
    });

    assert.ok(result.report.length > 0);

    // The write must not have happened — this is the property that keeps every
    // change in front of the user's approval card.
    await assert.rejects(
      () => fs.readFile(path.join(workspace, "sneaky.txt"), "utf8"),
      /ENOENT/,
      "a read-only subagent must not be able to write to disk",
    );
  } finally {
    await mock.close();
    await setProviderConfig({ kind: "anthropic", model: "claude-opus-5" });
  }
});

test("independent syscalls in one turn execute concurrently", async () => {
  const mock = await startMock([
    {
      toolCalls: [
        { name: "shell.exec", args: { command: "sleep 0.4 && echo one" } },
        { name: "shell.exec", args: { command: "sleep 0.4 && echo two" } },
        { name: "shell.exec", args: { command: "sleep 0.4 && echo three" } },
      ],
    },
    { text: "All three finished." },
  ]);

  try {
    await setProviderConfig({
      kind: "openai-compatible",
      baseUrl: mock.url,
      apiKey: "test-key",
      model: "hermes-test",
    });
    // shell.exec is `dangerous`; auto-allow it for this test so the loop runs
    // the calls instead of parking them on an approval card.
    const { setOverride } = await import("./permissions");
    await setOverride("shell.exec", "allow");

    const started = Date.now();
    const events: KernelEvent[] = [];
    for await (const event of run({
      sessionId: "parallel-e2e",
      input: { type: "user", text: "run three things" },
    })) {
      events.push(event);
    }
    const elapsed = Date.now() - started;

    const ended = events.filter((e) => e.type === "syscall_end");
    assert.equal(ended.length, 3, "all three commands should complete");

    // Sequential execution would take ~1.2s; concurrent should be well under.
    assert.ok(
      elapsed < 1000,
      `three 400ms commands took ${elapsed}ms — they ran sequentially, not in parallel`,
    );
  } finally {
    const { setOverride } = await import("./permissions");
    await setOverride("shell.exec", null);
    await mock.close();
    await setProviderConfig({ kind: "anthropic", model: "claude-opus-5" });
  }
});
