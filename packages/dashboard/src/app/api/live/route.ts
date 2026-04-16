import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "../../package.json"), "utf-8"),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      version: getVersion(),
      component: "raven",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
