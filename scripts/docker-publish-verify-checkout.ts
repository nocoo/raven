#!/usr/bin/env bun
import { verifyCheckoutHead } from "./lib/docker-publish-build.ts"

try {
  verifyCheckoutHead(String(process.env.TARGET_SHA ?? ""))
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Checkout verification failed",
  )
  process.exit(1)
}
