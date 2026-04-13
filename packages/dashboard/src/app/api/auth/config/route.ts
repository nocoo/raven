import { isAuthEnabled } from "@/lib/auth-mode";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export interface AuthConfig {
  authEnabled: boolean;
  provider: "google" | "local";
}

export function GET(): NextResponse<AuthConfig> {
  return NextResponse.json({
    authEnabled: isAuthEnabled,
    provider: isAuthEnabled ? "google" : "local",
  });
}
