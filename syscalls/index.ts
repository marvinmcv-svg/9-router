import type { Syscall } from "@/kernel/types";
import { agentSyscalls } from "./agents";
import { coreSyscalls } from "./core";
import { githubSyscalls } from "./github";
import { infraSyscalls } from "./infra";
import { systemSyscalls } from "./system";
import { calendarSyscalls } from "./google/calendar";
import { driveSyscalls } from "./google/drive";
import { gmailSyscalls } from "./google/gmail";

/**
 * The complete syscall table.
 *
 * Adding a capability to JARVIS means adding a Syscall here — the registry,
 * permission engine, approval UI and tool schema all derive from this list.
 */
export const syscalls: Syscall[] = [
  ...coreSyscalls,
  ...systemSyscalls,
  ...agentSyscalls,
  ...gmailSyscalls,
  ...calendarSyscalls,
  ...driveSyscalls,
  ...githubSyscalls,
  ...infraSyscalls,
];
