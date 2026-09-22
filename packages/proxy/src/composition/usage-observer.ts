import { createUsageCollector, normalizeUsage, type NormalizedUsage, type UsageProtocol } from "../core/usage"

export interface AttemptUsage {
  attempt_ordinal: number
  usage: NormalizedUsage
}

function requestsStream(init?: RequestInit): boolean {
  if (typeof init?.body !== "string") return false
  try {
    return (JSON.parse(init.body) as { stream?: unknown }).stream === true
  } catch {
    return false
  }
}

export function observeModelFetch(
  protocol: UsageProtocol,
  settle: (attempt: AttemptUsage) => void,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  let ordinal = 0
  const observed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const attempt_ordinal = ordinal++
    let settled = false
    const finish = (usage: NormalizedUsage) => {
      if (settled) return
      settled = true
      settle({ attempt_ordinal, usage })
    }
    let response: Response
    try {
      response = await fetchImpl(input, init)
    } catch (error) {
      finish(normalizeUsage(protocol, null))
      throw error
    }
    if (!response.body) {
      finish(normalizeUsage(protocol, null))
      return response
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    const json = contentType === "application/json" || contentType?.endsWith("+json") === true
    const collector = createUsageCollector(protocol,
      contentType === "text/event-stream" || (!json && response.ok && requestsStream(init)))
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let cancelled = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      reader.releaseLock()
    }
    const close = (complete: boolean) => {
      if (settled) return
      collector.push(decoder.decode())
      finish(collector.finish(complete))
    }
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (cancelled) return
          if (done) {
            close(true)
            release()
            controller.close()
          } else {
            collector.push(decoder.decode(value, { stream: true }))
            controller.enqueue(value)
          }
        } catch (error) {
          if (cancelled) return
          close(false)
          release()
          controller.error(error)
        }
      },
      async cancel(reason) {
        cancelled = true
        close(false)
        try { await reader.cancel(reason) } finally { release() }
      },
    }), { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return Object.assign(observed, { preconnect: fetchImpl.preconnect }) as typeof globalThis.fetch
}
