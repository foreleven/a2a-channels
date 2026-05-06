import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const AUTH_COOKIE_NAME = "a2a_auth_token";
const AUTH_PATHS = new Set(["/login", "/register"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(AUTH_COOKIE_NAME);
  const isAuthPath = AUTH_PATHS.has(pathname);

  if (!hasSession && !isAuthPath) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (hasSession && isAuthPath) {
    const requestedNext = request.nextUrl.searchParams.get("next");
    return NextResponse.redirect(
      new URL(safeNextPath(requestedNext), request.url),
    );
  }

  return NextResponse.next();
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
