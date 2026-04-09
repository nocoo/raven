import { Hono } from "hono";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Platform check — sound feature is macOS-only
// ---------------------------------------------------------------------------

/**
 * Whether the sound feature is available on this platform.
 * Currently only macOS is supported (requires afplay and system sounds).
 */
export const SOUND_AVAILABLE = process.platform === "darwin";

// ---------------------------------------------------------------------------
// Available system sounds (macOS built-in)
// ---------------------------------------------------------------------------

export const SYSTEM_SOUNDS = [
  "Basso",
  "Blow",
  "Bottle",
  "Frog",
  "Funk",
  "Glass",
  "Hero",
  "Morse",
  "Ping",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
  "Tink",
] as const;

export type SystemSound = (typeof SYSTEM_SOUNDS)[number];

export function isValidSound(name: string): name is SystemSound {
  return (SYSTEM_SOUNDS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Play sound (non-blocking)
// ---------------------------------------------------------------------------

/**
 * Play a macOS system sound asynchronously.
 * Uses afplay which is built into macOS.
 * No-op on non-macOS platforms.
 */
export function playSound(name: SystemSound): void {
  if (!SOUND_AVAILABLE) return;

  const path = `/System/Library/Sounds/${name}.aiff`;
  spawn("afplay", [path], {
    stdio: "ignore",
    detached: true,
  }).unref();
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Create sound-related routes.
 * Mounted at /api in app.ts, so paths become /api/sound/*.
 */
export function createSoundRoute(): Hono {
  const route = new Hono();

  // List available sounds
  route.get("/sound/list", (c) => {
    return c.json({ sounds: SYSTEM_SOUNDS });
  });

  // Preview a sound
  route.post("/sound/preview", async (c) => {
    const body = await c.req.json<{ name?: string }>();
    const name = body.name;

    if (!name || typeof name !== "string") {
      return c.json(
        { error: { type: "validation_error", message: "name is required" } },
        400,
      );
    }

    if (!isValidSound(name)) {
      return c.json(
        {
          error: {
            type: "validation_error",
            message: `unknown sound: ${name}. Must be one of: ${SYSTEM_SOUNDS.join(", ")}`,
          },
        },
        400,
      );
    }

    playSound(name);
    return c.json({ ok: true, played: name });
  });

  return route;
}
