/**
 * Core kernel types.
 *
 * The central abstraction is the *syscall*: every capability JARVIS has —
 * reading mail, writing a file, deploying a service — is a syscall with
 * declared risk. The permission engine reads that declaration to decide
 * whether a call runs immediately or pauses for human approval.
 */

/**
 * How much damage a syscall can do if the model gets it wrong.
 *
 * - `read`      Observes state. Cannot change anything the user cares about.
 * - `write`     Creates or modifies state. Recoverable, but visible to others
 *               (sending mail, creating events, pushing commits).
 * - `dangerous` Destroys state, spends money, or is effectively irreversible
 *               (deleting files, dropping tables, production deploys).
 */
export type Risk = "read" | "write" | "dangerous";

/** What the policy engine decided to do with a specific call. */
export type Decision = "allow" | "ask" | "deny";

export interface SyscallContext {
  /** Session the call belongs to, for audit and memory attribution. */
  sessionId: string;
  /** Emit a progress line the UI can render while a slow syscall runs. */
  progress: (message: string) => void;
  /** Abort signal — fires if the user interrupts the run. */
  signal: AbortSignal;
}

export interface Syscall<I = any, O = any> {
  /** Stable identifier, `namespace.verb` (e.g. `gmail.send_draft`). */
  name: string;
  /**
   * What the syscall does AND when to call it. Trigger conditions matter as
   * much as behaviour — the model reaches for tools conservatively otherwise.
   */
  description: string;
  risk: Risk;
  /** JSON Schema for the input. */
  input: Record<string, unknown>;
  /**
   * Human-readable one-line summary of a *specific* call, shown on the
   * approval card. This is what the user reads before clicking approve, so it
   * must surface the parts that would make them say no.
   */
  preview?: (input: I) => string;
  /** Which connector this belongs to; used to hide syscalls with no credentials. */
  connector?: string;
  run: (input: I, ctx: SyscallContext) => Promise<O>;
}

/** A tool call the kernel has paused on, waiting for the user. */
export interface PendingApproval {
  id: string;
  syscall: string;
  input: unknown;
  risk: Risk;
  preview: string;
  requestedAt: string;
}

export type KernelEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "syscall_start"; id: string; name: string; input: unknown }
  | { type: "syscall_progress"; id: string; message: string }
  | { type: "syscall_end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "approval_required"; approvals: PendingApproval[] }
  | { type: "memory_written"; key: string; value: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheRead: number }
  | { type: "done"; reason: "end_turn" | "awaiting_approval" | "max_iterations" }
  | { type: "error"; message: string };

/** A user's answer to one pending approval. */
export interface ApprovalDecision {
  id: string;
  decision: "allow" | "deny";
  /** Optional note passed back to the model explaining a denial. */
  note?: string;
}

export interface MemoryRecord {
  id: string;
  /** Short slug, e.g. `preference.email-tone`. Writing the same key updates it. */
  key: string;
  value: string;
  /** `fact` persists forever; `episode` is a timestamped log entry. */
  kind: "fact" | "episode";
  createdAt: string;
  updatedAt: string;
}
