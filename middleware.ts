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

  // Refuse to serve anything at all when no password is configured. Failing
  // closed here means a misconfigured deployment is locked, not wide open.
  if (!process.env.JARVIS_PASSWORD) {
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
