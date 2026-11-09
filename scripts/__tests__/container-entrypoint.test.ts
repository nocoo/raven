import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { supervise, validateRuntimeEnvironment, type ManagedChild, type ShutdownSignal } from "../container-entrypoint"

function deferred(): {
  promise: Promise<number>
  resolve(value: number): void
} {
  let resolvePromise: (value: number) => void = () => {}
  const promise = new Promise<number>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function child(name: string, stopOnTerm = true): {
  process: ManagedChild
  finish: ReturnType<typeof deferred>["resolve"]
  signals: Array<NodeJS.Signals | number>
} {
  const completion = deferred()
  const signals: Array<NodeJS.Signals | number> = []
  return {
    process: {
      name,
      exited: completion.promise,
      kill(signal) {
        signals.push(signal)
        if (stopOnTerm && signal === "SIGTERM") completion.resolve(143)
        if (signal === "SIGKILL") completion.resolve(137)
      },
    },
    finish: completion.resolve,
    signals,
  }
}

function shutdown(): {
  signal: ShutdownSignal
  terminate(): void
} {
  let resolveSignal: (value: NodeJS.Signals) => void = () => {}
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve
  })
  return {
    signal: { promise, dispose: () => {} },
    terminate: () => resolveSignal("SIGTERM"),
  }
}

describe("container entrypoint", () => {
  test("requires a distinct internal key for direct docker run", () => {
    expect(validateRuntimeEnvironment({})).toContain("RAVEN_INTERNAL_KEY")
    expect(
      validateRuntimeEnvironment({
        RAVEN_INTERNAL_KEY: "   ",
        RAVEN_API_KEY: "client",
      }),
    ).toContain("RAVEN_INTERNAL_KEY")
    expect(
      validateRuntimeEnvironment({
        RAVEN_INTERNAL_KEY: "same",
        RAVEN_API_KEY: "same",
      }),
    ).toContain("must differ")
    expect(
      validateRuntimeEnvironment({
        RAVEN_INTERNAL_KEY: "management",
        RAVEN_API_KEY: "client",
      }),
    ).toBeNull()
  })

  test("rejects reused keys before a direct container start", async () => {
    const entrypoint = resolve(process.cwd(), "scripts/container-entrypoint.ts")
    const childProcess = Bun.spawn([globalThis.process.execPath, "run", entrypoint], {
      env: {
        ...Bun.env,
        RAVEN_INTERNAL_KEY: "same",
        RAVEN_API_KEY: "same",
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await childProcess.exited).toBe(1)
    expect(await new Response(childProcess.stderr).text()).toContain("must differ")
  })

  test("turns an unexpected zero exit into a failure and stops its peer", async () => {
    const proxy = child("proxy")
    const dashboard = child("dashboard")
    const stop = shutdown()
    const result = supervise([proxy.process, dashboard.process], stop.signal, 10)

    proxy.finish(0)

    await expect(result).resolves.toBe(1)
    expect(dashboard.signals).toContain("SIGTERM")
  })

  test("preserves a non-zero child failure", async () => {
    const proxy = child("proxy")
    const dashboard = child("dashboard")
    const stop = shutdown()
    const result = supervise([proxy.process, dashboard.process], stop.signal, 10)

    proxy.finish(7)

    await expect(result).resolves.toBe(7)
    expect(dashboard.signals).toContain("SIGTERM")
  })

  test("returns success and terminates all children on SIGTERM", async () => {
    const proxy = child("proxy")
    const dashboard = child("dashboard")
    const stop = shutdown()
    const result = supervise([proxy.process, dashboard.process], stop.signal, 10)

    stop.terminate()

    await expect(result).resolves.toBe(0)
    expect(proxy.signals).toContain("SIGTERM")
    expect(dashboard.signals).toContain("SIGTERM")
  })

  test("escalates a stuck child to SIGKILL", async () => {
    const proxy = child("proxy")
    const dashboard = child("dashboard", false)
    const stop = shutdown()
    const result = supervise([proxy.process, dashboard.process], stop.signal, 1)

    proxy.finish(2)

    await expect(result).resolves.toBe(2)
    expect(dashboard.signals).toEqual(["SIGTERM", "SIGKILL"])
  })
})
