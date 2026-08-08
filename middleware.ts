import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/auth";

/**
 * The front door.
 *
 * Everything is gated except the login page itself and the scheduler endpoint,
 * which carries its own bearer secret. This runs before any route handler, so
 * there is no path into the kernel — or the connectors it holds credentials
 * for — that skips it.
 */

const PUBLIC_PATHS = ["/login", "/api/auth/login"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Routines are triggered by a scheduler that has no cookie; that endpoint
  // authenticates with JARVIS_CRON_SECRET and refuses to run without one.
  if (pathname.startsWith("/api/routines/run")) {
    return NextResponse.next();
  }

  if (!process.env.JARVIS_PASSWORD) {
    // Local development is exempt: requiring a password to run `npm run dev`
    // on your own laptop is friction with no attacker to stop. The exemption
    // is narrow on purpose — development build AND a loopback host, so a dev
    // server bound to 0.0.0.0 and reached over the network still gets locked.
    const host = request.headers.get("host") ?? "";
    const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

    if (process.env.NODE_ENV === "development" && isLoopback) {
      return NextResponse.next();
    }

    // Anywhere else, refuse to serve at all. A deployment that cannot
    // authenticate anyone is locked, not wide open.
    return new NextResponse(
      "JARVIS has no password configured. Set JARVIS_PASSWORD in your environment and redeploy.",
      { status: 503, headers: { "Content-Type": "text/plain" } },
    );
  }

  if (await verifyToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  // API callers get a status they can act on; browsers get the login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Exclude Next's own asset routes; everything else passes through.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
