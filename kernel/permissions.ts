import type { Decision, Risk, Syscall } from "./types";
import { store } from "@/lib/store";

/**
 * The permission policy engine.
 *
 * Default posture is propose-then-act: JARVIS reads whatever it needs without
 * interrupting you, but anything that writes to the outside world stops and
 * asks first. The policy is data, not code — loosen a single syscall as you
 * come to trust it without touching the kernel.
 */

export interface Policy {
  /** Fallback decision per risk tier. */
  defaults: Record<Risk, Decision>;
  /** Per-syscall overrides, keyed by syscall name. Wins over `defaults`. */
  overrides: Record<string, Decision>;
  /**
   * Autonomy ceiling. `dangerous` syscalls are never auto-allowed by the
   * `defaults` map alone — they additionally require an explicit override,
   * so a broad "allow all writes" setting can't silently escalate.
   */
  allowDangerousWithoutOverride: boolean;
}

export const DEFAULT_POLICY: Policy = {
  defaults: { read: "allow", write: "ask", dangerous: "ask" },
  overrides: {},
  allowDangerousWithoutOverride: false,
};

const POLICY_KEY = "policy";

export async function getPolicy(): Promise<Policy> {
  const saved = await store.get<Partial<Policy>>(POLICY_KEY);
  if (!saved) return DEFAULT_POLICY;
  return {
    defaults: { ...DEFAULT_POLICY.defaults, ...saved.defaults },
    overrides: saved.overrides ?? {},
    allowDangerousWithoutOverride:
      saved.allowDangerousWithoutOverride ?? DEFAULT_POLICY.allowDangerousWithoutOverride,
  };
}

export async function setPolicy(policy: Policy): Promise<void> {
  await store.set(POLICY_KEY, policy);
}

/** Change the decision for one syscall. This is the knob the UI exposes. */
export async function setOverride(syscall: string, decision: Decision | null): Promise<Policy> {
  const policy = await getPolicy();
  if (decision === null) delete policy.overrides[syscall];
  else policy.overrides[syscall] = decision;
  await setPolicy(policy);
  return policy;
}

export function decide(syscall: Syscall, policy: Policy): Decision {
  const override = policy.overrides[syscall.name];
  if (override) return override;

  // A `dangerous` syscall needs its own override to run unattended. Without
  // one it asks, even if the risk default says allow — otherwise loosening
  // the tier default would quietly hand over irreversible actions too.
  if (syscall.risk === "dangerous" && !policy.allowDangerousWithoutOverride) {
    const tier = policy.defaults.dangerous;
    return tier === "deny" ? "deny" : "ask";
  }

  return policy.defaults[syscall.risk];
}
