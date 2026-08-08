import { authUrl, disconnect, exchangeCode } from "@/syscalls/google/auth";

export const runtime = "nodejs";

/** The redirect URI must match what's registered in the Google console. */
function redirectUri(request: Request): string {
  const base = process.env.JARVIS_BASE_URL ?? new URL(request.url).origin;
  return `${base.replace(/\/$/, "")}/api/auth/google`;
}

/**
 * Doubles as the start of the OAuth flow and its callback — Google redirects
 * back here with `?code`, so one registered URI covers both directions.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error) {
    return Response.redirect(new URL(`/?connect=denied&reason=${error}`, url.origin));
  }

  if (code) {
    try {
      await exchangeCode(code, redirectUri(request));
      return Response.redirect(new URL("/?connect=google", url.origin));
    } catch (err) {
      const message = encodeURIComponent(err instanceof Error ? err.message : "unknown error");
      return Response.redirect(new URL(`/?connect=failed&reason=${message}`, url.origin));
    }
  }

  try {
    return Response.redirect(authUrl(redirectUri(request)));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Google is not configured." },
      { status: 400 },
    );
  }
}

/** Revoke the stored grant. */
export async function DELETE(): Promise<Response> {
  await disconnect();
  return Response.json({ ok: true });
}
