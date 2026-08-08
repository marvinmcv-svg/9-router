import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Syscall } from "@/kernel/types";

const exec = promisify(execFile);

/**
 * Filesystem and shell — the syscalls that make this an operating system
 * rather than a chat window.
 *
 * Everything is confined to a workspace root. The model supplies paths, and
 * model-supplied paths are untrusted input: every one is resolved to its
 * canonical form and checked for containment before any operation. That check
 * is the security boundary, so it lives in one function that every syscall
 * here routes through, rather than being re-implemented per call site.
 */

function workspace(): string {
  return path.resolve(process.env.JARVIS_WORKSPACE ?? process.cwd());
}

/**
 * Whether this host can actually execute and write.
 *
 * Serverless platforms give you a read-only filesystem, no persistent disk,
 * and a container that vanishes between requests — so `fs.write` and
 * `shell.exec` are not merely restricted there, they are meaningless. They are
 * hidden from the model rather than left to fail with a confusing EROFS
 * halfway through a task.
 *
 * `JARVIS_ALLOW_EXEC=true` forces them on for hosts that look serverless but
 * genuinely have a writable disk (a container on Fly, Railway, or a VPS).
 */
export function hostCanExecute(): boolean {
  if (process.env.JARVIS_ALLOW_EXEC === "true") return true;
  if (process.env.JARVIS_ALLOW_EXEC === "false") return false;
  return !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME;
}

/**
 * Resolve a model-supplied path inside the workspace, or throw.
 *
 * `realpath` on the parent defeats symlinks that point outside the root —
 * a containment check on the unresolved string would pass for a symlink whose
 * target is /etc, which is exactly the escape worth closing.
 */
async function resolveInWorkspace(input: string): Promise<string> {
  const root = workspace();
  const candidate = path.resolve(root, input);

  let real = candidate;
  try {
    real = await fs.realpath(candidate);
  } catch {
    // The path may not exist yet (a file being created). Verify the deepest
    // existing ancestor instead, so a symlinked parent still can't escape.
    let parent = path.dirname(candidate);
    while (parent !== path.dirname(parent)) {
      try {
        real = path.join(await fs.realpath(parent), path.relative(parent, candidate));
        break;
      } catch {
        parent = path.dirname(parent);
      }
    }
  }

  const rootReal = await fs.realpath(root).catch(() => root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(
      `Path escapes the workspace. JARVIS can only touch files under ${rootReal}.`,
    );
  }
  return real;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".jarvis"]);

export const systemSyscalls: Syscall[] = [
  {
    name: "fs.list",
    risk: "read",
    description:
      "List files and directories under a workspace path. Call this to orient yourself before reading or editing — never guess at a file's location when you can look.",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path. Defaults to the root." },
        recursive: { type: "boolean", description: "Walk subdirectories. Default false." },
      },
      additionalProperties: false,
    },
    async run(input: { path?: string; recursive?: boolean }) {
      const target = await resolveInWorkspace(input.path ?? ".");
      const root = workspace();
      const out: string[] = [];

      async function walk(dir: string, depth: number) {
        if (out.length > 800) return;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(root, full) || ".";
          if (entry.isDirectory()) {
            out.push(`${rel}/`);
            if (input.recursive && depth < 6) await walk(full, depth + 1);
          } else {
            out.push(rel);
          }
        }
      }

      const stat = await fs.stat(target);
      if (!stat.isDirectory()) return path.relative(root, target);
      await walk(target, 0);
      return out.length ? out.sort().join("\n") : "(empty)";
    },
  },

  {
    name: "fs.read",
    risk: "read",
    description:
      "Read a file from the workspace. Always read a file before editing it — the edit syscall requires the exact current text, and guessing at contents is the most common way to corrupt a file.",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(input: { path: string }) {
      const target = await resolveInWorkspace(input.path);
      const content = await fs.readFile(target, "utf8");
      return content.length > 60_000
        ? `${content.slice(0, 60_000)}\n\n[truncated at 60k characters]`
        : content || "(empty file)";
    },
  },

  {
    name: "fs.search",
    risk: "read",
    description:
      "Search file contents across the workspace with a regular expression, returning matching lines with their file and line number. Use this to find where something is defined or used before changing it.",
    input: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression." },
        glob: { type: "string", description: "Optional filename filter, e.g. '*.ts'." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async run(input: { pattern: string; glob?: string }) {
      const root = workspace();
      const args = ["--line-number", "--no-heading", "--color=never", "--max-count=8"];
      if (input.glob) args.push("--glob", input.glob);
      args.push("--regexp", input.pattern, root);

      try {
        // ripgrep when available: it honours .gitignore and is far faster on
        // large trees. execFile (not exec) so the pattern is never shell-parsed.
        const { stdout } = await exec("rg", args, { maxBuffer: 4_000_000 });
        const lines = stdout.split("\n").filter(Boolean).slice(0, 200);
        return lines.map((l) => l.replace(`${root}/`, "")).join("\n") || "No matches.";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return manualSearch(root, input.pattern, input.glob);
        // ripgrep exits 1 for "no matches", which is not an error condition.
        if ((err as { code?: number }).code === 1) return "No matches.";
        throw err;
      }
    },
  },

  {
    name: "fs.write",
    available: hostCanExecute,
    risk: "write",
    description:
      "Create a file or overwrite it completely. For changing part of an existing file prefer fs.edit, which cannot silently discard content you did not read.",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    preview: (input: { path: string; content: string }) => {
      const lines = input.content.split("\n");
      const head = lines.slice(0, 40).join("\n");
      return `Write ${input.path} (${lines.length} lines)\n\n${head}${
        lines.length > 40 ? `\n… ${lines.length - 40} more lines` : ""
      }`;
    },
    async run(input: { path: string; content: string }) {
      const target = await resolveInWorkspace(input.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const existed = await fs
        .access(target)
        .then(() => true)
        .catch(() => false);
      await fs.writeFile(target, input.content, "utf8");
      return `${existed ? "Overwrote" : "Created"} ${input.path} (${input.content.length} bytes).`;
    },
  },

  {
    name: "fs.edit",
    available: hostCanExecute,
    risk: "write",
    description:
      "Replace an exact string in a file. Read the file first — `find` must match the current contents exactly and appear exactly once, which is what stops an edit from landing in the wrong place.",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        find: { type: "string", description: "Exact text to replace. Must be unique in the file." },
        replace: { type: "string", description: "Replacement text." },
      },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
    preview: (input: { path: string; find: string; replace: string }) =>
      `Edit ${input.path}\n\n- ${input.find.split("\n").slice(0, 12).join("\n- ")}\n\n+ ${input.replace
        .split("\n")
        .slice(0, 12)
        .join("\n+ ")}`,
    async run(input: { path: string; find: string; replace: string }) {
      const target = await resolveInWorkspace(input.path);
      const content = await fs.readFile(target, "utf8");

      const occurrences = content.split(input.find).length - 1;
      if (occurrences === 0) {
        throw new Error(
          "The `find` text does not appear in the file. Read the file again — it may have changed, or the whitespace may differ.",
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `The \`find\` text appears ${occurrences} times. Include more surrounding context so it matches exactly one location.`,
        );
      }

      await fs.writeFile(target, content.replace(input.find, input.replace), "utf8");
      return `Edited ${input.path}.`;
    },
  },

  {
    name: "shell.exec",
    available: hostCanExecute,
    // Arbitrary command execution. Nothing the model can produce is safe by
    // construction here, so this tier is the whole protection.
    risk: "dangerous",
    description:
      "Run a shell command in the workspace and return its output. Use for builds, tests, git, package managers and anything else the machine can do. The user sees the exact command before it runs.",
    input: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute." },
        timeoutSeconds: { type: "integer", description: "Kill after this long. Default 120." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    preview: (input: { command: string }) => `Run in workspace:\n\n  ${input.command}`,
    async run(input: { command: string; timeoutSeconds?: number }, ctx) {
      const timeout = Math.min((input.timeoutSeconds ?? 120) * 1000, 900_000);

      try {
        const { stdout, stderr } = await exec("bash", ["-lc", input.command], {
          cwd: workspace(),
          timeout,
          maxBuffer: 8_000_000,
          signal: ctx.signal,
        });
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        return output.length > 30_000
          ? `[earlier output trimmed]\n${output.slice(-30_000)}`
          : output || "(no output)";
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
        if (e.killed) throw new Error(`Command timed out after ${timeout / 1000}s.`);
        // A non-zero exit is information, not a crash — a failing test suite is
        // the answer to "run the tests", so return the output rather than
        // throwing away everything the command printed.
        const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
        return `Exit code ${e.code}\n\n${output.slice(-30_000) || "(no output)"}`;
      }
    },
  },
];

/** Fallback when ripgrep isn't installed. */
async function manualSearch(root: string, pattern: string, glob?: string): Promise<string> {
  const regex = new RegExp(pattern);
  const filter = glob ? new RegExp(`^${glob.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`) : null;
  const hits: string[] = [];

  async function walk(dir: string, depth: number) {
    if (hits.length >= 200 || depth > 8) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (filter && !filter.test(entry.name)) continue;
      const content = await fs.readFile(full, "utf8").catch(() => null);
      if (content === null) continue;
      content.split("\n").forEach((line, i) => {
        if (hits.length < 200 && regex.test(line)) {
          hits.push(`${path.relative(root, full)}:${i + 1}:${line.trim().slice(0, 200)}`);
        }
      });
    }
  }

  await walk(root, 0);
  return hits.join("\n") || "No matches.";
}
