// Next.js 16 proxy convention (replaces middleware.ts)
// Single enforcement point for authentication.

import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Allow auth flow routes
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Allow login page
  if (pathname === "/login") {
    // If already authenticated, redirect to home
    if (req.auth) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  // Protect everything else
  if (!req.auth) {
    // API routes get 401
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Pages redirect to login
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.ico$|.*\\.svg$).*)",
  ],
};
