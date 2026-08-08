#!/usr/bin/env node
/**
 * Interactive first-run setup.
 *
 * Writes .env.local and verifies the model actually answers before you find
 * out mid-task. Everything here is also editable in the Model panel later —
 * this exists so the first run is one command rather than a documentation
 * scavenger hunt.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

const ENV_PATH = path.join(process.cwd(), ".env.local");

const PROVIDERS = {
  1: {
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "",
    model: "claude-opus-5",
    hint: "key starts sk-ant-",
  },
  2: {
    kind: "anthropic-compatible",
    label: "GLM / Z.ai",
    baseUrl: "https://api.z.ai/api/anthropic",
    model: "glm-4.6",
    hint: "key looks like <id>.<secret>",
  },
  3: {
    kind: "openai-compatible",
    label: "Local model (Ollama, vLLM, LM Studio)",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    hint: "usually needs no key — press enter to skip",
  },
  4: {
    kind: "openai-compatible",
    label: "OpenAI / OpenRouter / other OpenAI-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    hint: "key starts sk-",
  },
};

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (question, fallback = "") => {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
};

console.log("\n  JARVIS setup\n  ────────────\n");

// Refuse to clobber an existing configuration without being told to.
try {
  await fs.access(ENV_PATH);
  const overwrite = await ask("  .env.local already exists. Overwrite it? [y/N] ", "n");
  if (!overwrite.toLowerCase().startsWith("y")) {
    console.log("\n  Left it alone. Run `npm run dev`.\n");
    rl.close();
    process.exit(0);
  }
} catch {
  // No existing config — the normal first-run path.
}

console.log("  Which model should JARVIS run on?\n");
for (const [key, p] of Object.entries(PROVIDERS)) {
  console.log(`    ${key}. ${p.label}  (${p.hint})`);
}
console.log("");

const choice = await ask("  Choice [1-4]: ", "1");
const provider = PROVIDERS[choice] ?? PROVIDERS[1];

const baseUrl = provider.baseUrl
  ? await ask(`  Base URL [${provider.baseUrl}]: `, provider.baseUrl)
  : "";
const model = await ask(`  Model [${provider.model}]: `, provider.model);
const apiKey = await ask("  API key: ");

console.log("");
const workspace = await ask(
  `  Workspace — the directory JARVIS may read and edit\n  [${process.cwd()}]: `,
  process.cwd(),
);

const resolved = path.resolve(workspace);
try {
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("not a directory");
} catch {
  console.log(`\n  ⚠ ${resolved} is not a directory. Setting it anyway — fix it in .env.local.`);
}

const lines = [
  "# Written by `npm run setup`. Never commit this file.",
  `JARVIS_PROVIDER=${provider.kind}`,
  baseUrl ? `JARVIS_BASE_URL_MODEL=${baseUrl}` : "",
  `JARVIS_MODEL=${model}`,
  apiKey ? `JARVIS_API_KEY=${apiKey}` : "",
  `JARVIS_WORKSPACE=${resolved}`,
  "",
  "# Local dev on localhost needs no password. Set one before deploying.",
  "# JARVIS_PASSWORD=",
  "",
  "# Optional connectors — see .env.example.",
  "# GOOGLE_CLIENT_ID=",
  "# GOOGLE_CLIENT_SECRET=",
  "# GITHUB_TOKEN=",
  "",
].filter((l) => l !== "");

// Trailing newline: without it the last line concatenates with whatever gets
// appended later, which is a confusing way to lose a variable.
await fs.writeFile(ENV_PATH, `${lines.join("\n")}\n`, "utf8");
// The file holds an API key; keep it off other users on shared machines.
await fs.chmod(ENV_PATH, 0o600).catch(() => {});
console.log(`\n  ✓ Wrote ${ENV_PATH}`);

if (apiKey) {
  process.stdout.write("  · Checking the model answers… ");
  try {
    const isAnthropicShaped = provider.kind !== "openai-compatible";
    const url = isAnthropicShaped
      ? `${(baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`
      : `${baseUrl.replace(/\/$/, "")}/chat/completions`;

    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      headers: isAnthropicShaped
        ? {
            "x-api-key": apiKey,
            Authorization: `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          }
        : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
      }),
    });

    if (res.ok) {
      console.log("✓ it answered.");
    } else {
      console.log(`✗ HTTP ${res.status}`);
      console.log(`    ${(await res.text()).slice(0, 200)}`);
      console.log("    Config is saved — fix it in the Model panel once running.");
    }
  } catch (err) {
    console.log(`✗ ${err.message}`);
    console.log("    Config is saved — fix it in the Model panel once running.");
  }
}

console.log("\n  Ready. Run:\n\n    npm run dev\n\n  Then open http://localhost:3000\n");
rl.close();
