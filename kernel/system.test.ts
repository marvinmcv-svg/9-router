import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

import { getSyscall } from "./registry";
import { agentAllows, type AgentDefinition } from "./agents";
import type { SyscallContext } from "./types";

// Confine the filesystem syscalls to a scratch workspace for the duration of
// these tests — they write real files.
const workspace = mkdtempSync(path.join(tmpdir(), "jarvis-ws-"));
process.env.JARVIS_WORKSPACE = workspace;

const ctx: SyscallContext = {
  sessionId: "test",
  progress: () => {},
  signal: new AbortController().signal,
};

const call = (name: string, input: unknown) => getSyscall(name)!.run(input, ctx);

test("filesystem syscalls refuse to escape the workspace", async () => {
  await fs.writeFile(path.join(workspace, "inside.txt"), "safe", "utf8");

  // A secret outside the sandbox that no syscall should ever reach.
  const outside = mkdtempSync(path.join(tmpdir(), "jarvis-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "TOP SECRET", "utf8");

  for (const escape of [
    "../../../etc/passwd",
    "/etc/passwd",
    path.join(outside, "secret.txt"),
    "subdir/../../../../etc/hosts",
  ]) {
    await assert.rejects(
      () => call("fs.read", { path: escape }),
      /escapes the workspace/,
      `fs.read must refuse: ${escape}`,
    );
    await assert.rejects(
      () => call("fs.write", { path: escape, content: "pwned" }),
      /escapes the workspace/,
      `fs.write must refuse: ${escape}`,
    );
  }

  // Reading inside the workspace still works.
  assert.equal(await call("fs.read", { path: "inside.txt" }), "safe");
});

test("a symlink pointing outside the workspace does not become a back door", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "jarvis-link-target-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "TOP SECRET", "utf8");

  // The path string looks contained; only resolving the link reveals it isn't.
  symlinkSync(outside, path.join(workspace, "escape-hatch"));

  await assert.rejects(
    () => call("fs.read", { path: "escape-hatch/secret.txt" }),
    /escapes the workspace/,
    "a symlinked directory must not grant access outside the root",
  );
});

test("fs.edit refuses ambiguous and stale matches rather than guessing", async () => {
  await fs.writeFile(path.join(workspace, "dup.txt"), "alpha\nbeta\nalpha\n", "utf8");

  await assert.rejects(
    () => call("fs.edit", { path: "dup.txt", find: "alpha", replace: "gamma" }),
    /appears 2 times/,
    "an edit matching twice could land in the wrong place",
  );

  await assert.rejects(
    () => call("fs.edit", { path: "dup.txt", find: "not present", replace: "x" }),
    /does not appear/,
  );

  await call("fs.edit", { path: "dup.txt", find: "beta", replace: "delta" });
  assert.equal(await fs.readFile(path.join(workspace, "dup.txt"), "utf8"), "alpha\ndelta\nalpha\n");
});

test("shell.exec returns a failing command's output instead of throwing it away", async () => {
  const result = (await call("shell.exec", {
    command: "echo hello-there && exit 3",
  })) as string;

  // A non-zero exit is information — a failing test suite is the answer to
  // "run the tests", not a crash.
  assert.match(result, /Exit code 3/);
  assert.match(result, /hello-there/, "stdout must survive a non-zero exit");
});

test("shell.exec is classified dangerous so it can never be auto-allowed by tier", () => {
  assert.equal(getSyscall("shell.exec")!.risk, "dangerous");
  assert.equal(getSyscall("fs.write")!.risk, "write");
  assert.equal(getSyscall("fs.read")!.risk, "read");
});

test("subagent allow-lists are prefix-scoped, not substring matches", () => {
  const researcher: AgentDefinition = {
    id: "r",
    name: "R",
    description: "",
    systemPrompt: "",
    allow: ["fs.read", "web."],
    canWrite: false,
    maxIterations: 5,
  };

  assert.ok(agentAllows(researcher, "fs.read"));
  assert.ok(agentAllows(researcher, "web.fetch"));
  assert.ok(!agentAllows(researcher, "fs.write"), "must not leak write access");
  assert.ok(!agentAllows(researcher, "shell.exec"));

  // An empty allow-list means "everything the coordinator can reach".
  assert.ok(agentAllows({ ...researcher, allow: [] }, "shell.exec"));
});

test("delegation is not exposed to subagents, so recursion is impossible", async () => {
  const { getRoster } = await import("./agents");
  for (const agent of await getRoster()) {
    assert.ok(
      !agent.allow.some((prefix) => "agent.delegate".startsWith(prefix)),
      `${agent.id} must not be able to delegate further`,
    );
  }
});

test("built-in roster keeps writes funnelled through the coordinator", async () => {
  const { getRoster } = await import("./agents");
  const roster = await getRoster();

  const researcher = roster.find((a) => a.id === "researcher")!;
  assert.equal(researcher.canWrite, false, "the researcher must not be able to change anything");

  const hermes = roster.find((a) => a.id === "hermes")!;
  assert.equal(hermes.canWrite, false, "an externally-hosted agent starts read-only");
});
