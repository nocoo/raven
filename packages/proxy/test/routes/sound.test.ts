import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const unrefMock = mock(() => {});
const spawnMock = mock(() => ({ unref: unrefMock }));

mock.module("child_process", () => ({
  spawn: spawnMock,
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

async function importSoundModule(platform: NodeJS.Platform) {
  setPlatform(platform);
  return import(`../../src/routes/sound.ts?platform=${platform}&t=${Math.random()}`);
}

function createApp(route: Hono) {
  const app = new Hono();
  app.route("/api", route);
  return app;
}

beforeEach(() => {
  spawnMock.mockClear();
  unrefMock.mockClear();
  setPlatform(originalPlatform);
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("sound route helpers", () => {
  test("exports the macOS availability flag from the runtime platform", async () => {
    const { SOUND_AVAILABLE } = await importSoundModule("darwin");
    expect(SOUND_AVAILABLE).toBe(true);

    const nonDarwinModule = await importSoundModule("linux");
    expect(nonDarwinModule.SOUND_AVAILABLE).toBe(false);
  });

  test("validates built-in system sounds", async () => {
    const { SYSTEM_SOUNDS, isValidSound } = await importSoundModule("darwin");

    expect(SYSTEM_SOUNDS).toContain("Ping");
    expect(isValidSound("Ping")).toBe(true);
    expect(isValidSound("NotARealSound")).toBe(false);
  });

  test("spawns afplay and unreferences the process on macOS", async () => {
    const { playSound } = await importSoundModule("darwin");

    playSound("Ping");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("afplay", ["/System/Library/Sounds/Ping.aiff"], {
      stdio: "ignore",
      detached: true,
    });
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  test("does nothing on non-macOS platforms", async () => {
    const { playSound } = await importSoundModule("linux");

    playSound("Ping");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(unrefMock).not.toHaveBeenCalled();
  });
});

describe("sound routes", () => {
  test("lists the available system sounds", async () => {
    const { SYSTEM_SOUNDS, createSoundRoute } = await importSoundModule("darwin");

    const res = await createApp(createSoundRoute()).request("/api/sound/list");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sounds: SYSTEM_SOUNDS });
  });

  test("rejects preview requests without a name", async () => {
    const { createSoundRoute } = await importSoundModule("darwin");

    const res = await createApp(createSoundRoute()).request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        type: "validation_error",
        message: "name is required",
      },
    });
  });

  test("rejects preview requests with a non-string name", async () => {
    const { createSoundRoute } = await importSoundModule("darwin");

    const res = await createApp(createSoundRoute()).request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 123 }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        type: "validation_error",
        message: "name is required",
      },
    });
  });

  test("rejects unknown sound names", async () => {
    const { SYSTEM_SOUNDS, createSoundRoute } = await importSoundModule("darwin");

    const res = await createApp(createSoundRoute()).request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        type: "validation_error",
        message: `unknown sound: Nope. Must be one of: ${SYSTEM_SOUNDS.join(", ")}`,
      },
    });
  });

  test("previews a valid sound", async () => {
    const { createSoundRoute } = await importSoundModule("darwin");

    const res = await createApp(createSoundRoute()).request("/api/sound/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ping" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, played: "Ping" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });
});
