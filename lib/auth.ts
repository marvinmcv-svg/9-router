/**
 * Single-user authentication.
 *
 * JARVIS holds OAuth grants to a real mailbox and a model key that costs real
 * money. Deployed to a public URL, the only thing standing between that and
 * the open internet is this file — so it is deliberately small enough to read
 * in one sitting.
 *
 * Web Crypto rather than node:crypto, because the middleware that enforces
 * this runs on the edge runtime where node builtins are unavailable.
 */

const COOKIE = "jarvis_session";
/** Re-authenticate every 30 days. */
const TTL_SECONDS = 60 * 60 * 24 * 30;

export { COOKIE as SESSION_COOKIE };

function secret(): string {
  const password = process.env.JARVIS_PASSWORD;
  if (!password) {
    throw new Error("JARVIS_PASSWORD is not set.");
  }
  // Signing with the password itself means changing the password invalidates
  // every existing session for free — no revocation list to maintain.
  return `${password}:${process.env.JARVIS_AUTH_SECRET ?? "jarvis"}`;
}

/** Is a password configured at all? */
export function authConfigured(): boolean {
  return Boolean(process.env.JARVIS_PASSWORD);
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Constant-time comparison, so a wrong answer leaks nothing through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkPassword(candidate: string): Promise<boolean> {
  const expected = process.env.JARVIS_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(candidate, expected);
}

export async function issueToken(): Promise<{ value: string; maxAge: number }> {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = String(expires);
  return { value: `${payload}.${await sign(payload)}`, maxAge: TTL_SECONDS };
}

export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;

  // Check expiry before the signature so an expired token can't be replayed
  // indefinitely even if the secret leaks later.
  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;

  try {
    return timingSafeEqual(mac, await sign(payload));
  } catch {
    // No password configured — fail closed.
    return false;
  }
}
