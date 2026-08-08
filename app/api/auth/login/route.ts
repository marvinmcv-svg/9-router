import { checkPassword, issueToken, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const { password } = (await request.json().catch(() => ({}))) as { password?: string };

  if (!process.env.JARVIS_PASSWORD) {
    return Response.json(
      { error: "No password is configured on this deployment." },
      { status: 503 },
    );
  }

  if (!password || !(await checkPassword(password))) {
    // A deliberate pause: this endpoint is the only thing between a public URL
    // and a live mailbox, and rate limiting is not otherwise available here.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return Response.json({ error: "Incorrect password." }, { status: 401 });
  }

  const token = await issueToken();
  const response = Response.json({ ok: true });
  response.headers.append(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${token.value}`,
      "Path=/",
      `Max-Age=${token.maxAge}`,
      "HttpOnly",
      "SameSite=Lax",
      // Secure everywhere except plain-HTTP localhost, where it would prevent
      // the cookie being set at all.
      process.env.NODE_ENV === "production" ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  return response;
}

/** Sign out. */
export async function DELETE(): Promise<Response> {
  const response = Response.json({ ok: true });
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly`);
  return response;
}
