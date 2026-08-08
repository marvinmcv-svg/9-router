import type Anthropic from "@anthropic-ai/sdk";
import type { Syscall } from "./types";
import { syscalls as allSyscalls } from "@/syscalls";
import { connectorAvailable } from "@/syscalls/connectors";

/**
 * The syscall table.
 *
 * Syscalls whose connector has no credentials configured are hidden entirely
 * rather than exposed and left to fail. A tool the model can see is a tool it
 * will eventually call, and "call it, watch it 401, apologise" burns a turn
 * and teaches it nothing.
 */

const table = new Map<string, Syscall>();
for (const syscall of allSyscalls) {
  if (table.has(syscall.name)) {
    throw new Error(`Duplicate syscall registered: ${syscall.name}`);
  }
  table.set(syscall.name, syscall);
}

export function getSyscall(name: string): Syscall | undefined {
  return table.get(name);
}

/** Every registered syscall, including ones with no credentials. */
export function allRegistered(): Syscall[] {
  return [...table.values()];
}

/**
 * Whether a syscall is callable right now.
 *
 * The single source of truth for availability. Anything that reports on
 * syscalls — the tool schema, the UI panel — must route through this, or the
 * model gets offered a tool the loop would refuse to run.
 */
export function isAvailable(syscall: Syscall): boolean {
  if (syscall.connector && !connectorAvailable(syscall.connector)) return false;
  if (syscall.available && !syscall.available()) return false;
  return true;
}

/** Syscalls the model can actually call right now. */
export function availableSyscalls(): Syscall[] {
  return allRegistered().filter(isAvailable);
}

export function toolDefinitions(): Anthropic.Tool[] {
  // Sorted so the tool block is byte-stable across requests; an unstable tool
  // list renders at position 0 of the prompt and invalidates the whole cache.
  return availableSyscalls()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: s.input as Anthropic.Tool.InputSchema,
    }));
}

export function previewCall(syscall: Syscall, input: unknown): string {
  if (syscall.preview) {
    try {
      return syscall.preview(input);
    } catch {
      // A preview that throws must never block the approval card — falling
      // back to raw JSON still lets the user make an informed decision.
    }
  }
  const json = JSON.stringify(input);
  return `${syscall.name}(${json.length > 200 ? `${json.slice(0, 200)}…` : json})`;
}
