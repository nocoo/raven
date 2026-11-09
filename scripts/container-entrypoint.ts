import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { resolve } from "node:path"

export interface ManagedChild {
  name: string
  exited: Promise<number>
  kill(signal: NodeJS.Signals | number): void
}

export interface ShutdownSignal {
  promise: Promise<NodeJS.Signals>
  dispose(): void
}

interface Service {
  name: string
  cwd: string
  command: string[]
}

const SHUTDOWN_GRACE_MS = 10_000

export function validateRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
): string | null {
  const internalKey = environment.RAVEN_INTERNAL_KEY ?? ""
  if (!internalKey.trim()) return "RAVEN_INTERNAL_KEY is required"
  if (internalKey === environment.RAVEN_API_KEY) {
    return "RAVEN_INTERNAL_KEY must differ from RAVEN_API_KEY"
  }
  return null
}

function warnForDashboardAuth(environment: NodeJS.ProcessEnv): void {
  const credentials = [
    environment.GOOGLE_CLIENT_ID,
    environment.GOOGLE_CLIENT_SECRET,
    environment.NEXTAUTH_SECRET,
  ]
  const configured = credentials.filter((value) => Boolean(value?.trim())).length
  if (configured < credentials.length) {
    console.warn(
      "[container] Dashboard is in Local mode; expose it only through host loopback",
    )
    return
  }
  if (!environment.ALLOWED_EMAILS?.trim()) {
    console.warn(
      "[container] OAuth is enabled without ALLOWED_EMAILS; all Google accounts are allowed",
    )
  }
}

function spawnService(service: Service): ManagedChild {
  const child = Bun.spawn(service.command, {
    cwd: service.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  return {
    name: service.name,
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  }
}

function installShutdownSignal(): ShutdownSignal {
  let resolveSignal: ((signal: NodeJS.Signals) => void) | undefined
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve
  })
  const onSigint = () => resolveSignal?.("SIGINT")
  const onSigterm = () => resolveSignal?.("SIGTERM")

  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  return {
    promise,
    dispose() {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
    },
  }
}

async function terminate(children: ManagedChild[], graceMs: number): Promise<void> {
  for (const child of children) {
    try {
      child.kill("SIGTERM")
    } catch {
      // The child may have exited between the race winner and termination.
    }
  }

  const allExited = Promise.all(children.map((child) => child.exited)).then(() => true)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolveTimer) => {
    timer = setTimeout(() => resolveTimer(false), graceMs)
  })
  const exited = await Promise.race([allExited, timedOut])
  if (timer) clearTimeout(timer)
  if (exited) return

  for (const child of children) {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already exited.
    }
  }
  await allExited
}

export async function supervise(
  children: ManagedChild[],
  shutdown: ShutdownSignal = installShutdownSignal(),
  graceMs = SHUTDOWN_GRACE_MS,
): Promise<number> {
  try {
    const firstExit = Promise.race(
      children.map(async (child) => ({
        kind: "exit" as const,
        child,
        code: await child.exited,
      })),
    )
    const firstSignal = shutdown.promise.then((signal) => ({
      kind: "signal" as const,
      signal,
    }))
    const outcome = await Promise.race([firstExit, firstSignal])

    await terminate(children, graceMs)
    if (outcome.kind === "signal") return 0

    if (outcome.code === 0) {
      console.error(`${outcome.child.name} exited unexpectedly with code 0`)
      return 1
    }
    return outcome.code
  } finally {
    shutdown.dispose()
  }
}

export async function main(): Promise<number> {
  const environmentError = validateRuntimeEnvironment(process.env)
  if (environmentError) {
    console.error(environmentError)
    return 1
  }
  warnForDashboardAuth(process.env)

  process.umask(0o077)
  try {
    await Promise.all([
      "/var/lib/raven/config",
      "/var/lib/raven/data",
    ].map((path) => access(path, constants.W_OK)))
  } catch {
    console.error("Container state directories must be writable by the non-root user")
    return 1
  }

  const root = resolve(import.meta.dir, "..")
  const services: Service[] = [
    {
      name: "proxy",
      cwd: resolve(root, "packages/proxy"),
      command: ["/usr/local/bin/bun", "run", "src/index.ts"],
    },
    {
      name: "dashboard",
      cwd: root,
      command: [
        "/usr/local/bin/node",
        resolve(root, "packages/dashboard/node_modules/next/dist/bin/next"),
        "start",
        resolve(root, "packages/dashboard"),
        "-H",
        "0.0.0.0",
        "-p",
        "7023",
      ],
    },
  ]

  const children: ManagedChild[] = []
  const shutdown = installShutdownSignal()
  try {
    for (const service of services) children.push(spawnService(service))
    return await supervise(children, shutdown)
  } catch (error) {
    shutdown.dispose()
    await terminate(children, SHUTDOWN_GRACE_MS)
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
