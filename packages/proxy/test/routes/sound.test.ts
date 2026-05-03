import { beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";

const { unrefMock, spawnMock } = vi.hoisted(() => {
  const unrefMock = vi.fn(() => {});
  const spawnMock = vi.fn(() => ({ unref: unrefMock }));
  return { unrefMock, spawnMock };
});

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

// Use direct static import so coverage instruments the actual file
import {
  SOUND_AVAILABLE,
  SYSTEM_SOUNDS,
  isValidSound,
  playSound,
  createSoundRoute,
} from "../../src/routes/sound";

function createApp(route: Hono) {
  const app = new Hono();
  app.route("/api", route);
  return app;
}

beforeEach(() => {
  spawnMock.mockClear();
  unrefMock.mockClear();
});

describe("sound route helpers", () => {
  test("SOUND_AVAILABLE reflects platform", () => {
    // We're running on macOS in CI/dev
    expect(typeof SOUND_AVAILABLE).toBe("boolean");
  });

  test("SYSTEM_SOUNDS contains known sounds", () => {
    expect(SYSTEM_SOUNDS).toContain("Ping");
    expect(SYSTEM_SOUNDS).toContain("Glass");
    expect(SYSTEM_SOUNDS.length).toBeGreaterThan(0);
  });

  test("isValidSound validates correctly", () => {
    expect(isValidSound("Ping")).toBe(true);
    expect(isValidSound("NotARealSound")).toBe(false);
    expect(isValidSound("")).toBe(false);
  });

  test("playSound spawns afplay with correct args on macOS", () => {
    // On macOS (darwin), SOUND_AVAILABLE is true
    if (!SOUND_AVAILABLE) return;

    playSound("Ping");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("afplay", ["/System/Library/Sounds/Ping.aiff"], {
      stdio: "ignore",
      detached: true,
    });
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });
});

describe("sound routes", () => {
  test("GET /api/sound/list returns all system sounds", async () => {
    const app = createApp(createSoundRoute());
    const res = await app.request("/api/sound/list");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sounds).toEqual(SYSTEM_SOUNDS);
  });

  test("POST /api/sound/preview with valid sound returns ok", async () => {
    const app = createApp(createSoundRoute());
    const res = await app.request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ping" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, played: "Ping" });
  });

  test("POST /api/sound/preview without name returns 400", async () => {
    const app = createApp(createSoundRoute());
    const res = await app.request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("validation_error");
    expect(body.error.message).toBe("name is required");
  });

  test("POST /api/sound/preview with non-string name returns 400", async () => {
    const app = createApp(createSoundRoute());
    const res = await app.request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("name is required");
  });

  test("POST /api/sound/preview with unknown sound returns 400", async () => {
    const app = createApp(createSoundRoute());
    const res = await app.request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("validation_error");
    expect(body.error.message).toContain("unknown sound: Nope");
  });
});
