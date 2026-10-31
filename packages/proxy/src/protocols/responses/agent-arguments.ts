import { isTerminalResponseEvent } from "./stream-state"

const AGENT_TASK_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"])
const WIRE_NAMESPACE = "raven_agent_compat"

interface AgentToolAlias {
  name: string
  flattened: boolean
  /** Undefined for unchanged tools that only need namespace restoration. */
  encryptedParameters?: readonly string[]
}

export type AgentToolAliases = ReadonlyMap<string, AgentToolAlias>
/** Caller-owned, per-response state; explicit upstream metadata is authoritative. */
export type AgentArgumentState = Map<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mapArray(value: unknown, transform: (item: unknown, index: number) => unknown): unknown {
  if (!Array.isArray(value)) return value
  let changed = false
  const next = value.map((item, index) => {
    const mapped = transform(item, index)
    changed ||= mapped !== item
    return mapped
  })
  return changed ? next : value
}

function plaintextParameters(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  if (tool.type !== "function" || typeof tool.name !== "string" || !AGENT_TASK_TOOLS.has(tool.name)) return
  const parameters = tool.parameters
  if (!isRecord(parameters) || !isRecord(parameters.properties)) return
  const message = parameters.properties.message
  if (!isRecord(message) || message.encrypted !== true) return
  return { ...parameters, properties: { ...parameters.properties, message: { ...message, encrypted: false } } }
}

function findAlias(value: Record<string, unknown>, aliases: AgentToolAliases, namespace: string): AgentToolAlias | undefined {
  if (typeof value.name !== "string") return
  if (value.namespace === namespace) return aliases.get(value.name)
  if (value.namespace == null) {
    // Exact equality only: unknown prefix-looking names must never become native tools.
    for (const alias of aliases.values()) if (value.name === `${namespace}${alias.name}`) return alias
  }
  return
}

/** Opt-in Copilot compatibility. Fail closed on ambiguous wire identities. */
export function preparePlaintextAgentTasks<T extends { input: unknown; tools?: unknown; tool_choice?: unknown }>(request: T): {
  request: T
  toolNames: AgentToolAliases
} {
  const toolNames = new Map<string, AgentToolAlias>()
  const declarations = [
    ...(Array.isArray(request.tools) ? request.tools.map((tool) => ({ tool, flattened: true })) : []),
    ...(Array.isArray(request.input) ? request.input.flatMap((item) => isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)
      ? item.tools.map((tool) => ({ tool, flattened: false })) : []) : []),
  ]
  const candidates = declarations.filter(({ tool }) => isRecord(tool) && tool.type === "namespace" && tool.name === "collaboration")
  const candidate = candidates[0]
  if (candidates.length !== 1 || !candidate || !isRecord(candidate.tool) || !Array.isArray(candidate.tool.tools)) return { request, toolNames }
  const source = candidate.tool
  const children = candidate.tool.tools
  if (!children.some((child) => isRecord(child) && plaintextParameters(child))) return { request, toolNames }
  // Reject malformed children rather than aliasing a namespace with unknown members.
  if (children.some((child) => !isRecord(child) || child.type !== "function" || typeof child.name !== "string")) return { request, toolNames }
  const names = children.map((child) => (child as Record<string, unknown>).name as string)
  if (new Set(names).size !== names.length) return { request, toolNames }
  const occupied = new Set<string>()
  for (const { tool } of declarations) {
    if (tool === source || !isRecord(tool)) continue
    if (tool.type === "namespace") {
      if (tool.name === WIRE_NAMESPACE) return { request, toolNames }
      if (typeof tool.name === "string" && Array.isArray(tool.tools)) {
        for (const child of tool.tools) if (isRecord(child) && typeof child.name === "string") occupied.add(`${tool.name}${child.name}`)
      }
    } else if (typeof tool.name === "string") occupied.add(tool.name)
  }
  if (names.some((name) => occupied.has(`${WIRE_NAMESPACE}${name}`) || occupied.has(`collaboration${name}`))) return { request, toolNames }
  const tools = children.map((child: Record<string, unknown>) => {
    const parameters = plaintextParameters(child)
    const encryptedParameters = parameters && isRecord(parameters.properties)
      ? Object.entries(parameters.properties).filter(([, schema]) => isRecord(schema) && schema.encrypted === true).map(([name]) => name) : undefined
    toolNames.set(child.name as string, { name: child.name as string, flattened: candidate.flattened, ...(encryptedParameters ? { encryptedParameters } : {}) })
    return parameters ? { ...child, parameters } : child
  })
  const mapTool = (tool: unknown): unknown => tool === source ? { ...source, name: WIRE_NAMESPACE, tools } : tool
  const preparedTools = mapArray(request.tools, mapTool)
  const input = mapArray(request.input, (item) => {
    if (!isRecord(item)) return item
    if (item.type === "additional_tools") {
      const mapped = mapArray(item.tools, mapTool)
      return mapped === item.tools ? item : { ...item, tools: mapped }
    }
    if (item.type !== "function_call") return item
    const alias = findAlias(item, toolNames, "collaboration")
    return alias ? { ...item, namespace: WIRE_NAMESPACE, name: alias.name } : item
  })
  const mapChoice = (value: unknown): unknown => {
    if (!isRecord(value)) return value
    if (value.type === "allowed_tools") {
      const tools = mapArray(value.tools, mapChoice)
      return tools === value.tools ? value : { ...value, tools }
    }
    if (value.type !== "function") return value
    const alias = findAlias(value, toolNames, "collaboration")
    if (!alias) return value
    if (!alias.flattened) return { ...value, namespace: WIRE_NAMESPACE, name: alias.name }
    const { namespace: _namespace, ...rest } = value
    return { ...rest, name: `${WIRE_NAMESPACE}${alias.name}` }
  }
  const tool_choice = mapChoice(request.tool_choice)
  return {
    request: { ...request, ...(preparedTools !== request.tools ? { tools: preparedTools } : {}),
      ...(input !== request.input ? { input } : {}), ...(tool_choice !== request.tool_choice ? { tool_choice } : {}) },
    toolNames,
  }
}

function inferEncoding(argumentsText: unknown, remaining: readonly string[]): readonly string[] | undefined {
  if (typeof argumentsText !== "string") return
  try {
    const args: unknown = JSON.parse(argumentsText)
    if (!isRecord(args)) return
    const opaque = typeof args.message === "string" && args.message.length > 80 && /^(?:gAAAA|UlQC)[A-Za-z0-9_+/=-]+$/.test(args.message)
    return opaque ? [...remaining, "message"] : remaining
  } catch {
    return // Incomplete or malformed arguments are not evidence of plaintext.
  }
}

/** Restore declared identities and mark complete arguments, never streaming fragments. */
export function markPlaintextAgentArguments(
  value: unknown,
  aliases: AgentToolAliases,
  state: AgentArgumentState = new Map(),
  event?: string,
): unknown {
  if (aliases.size === 0) return value
  const complete = event === undefined || event === "response.output_item.done" || isTerminalResponseEvent(event)
  const visit = (value: unknown, outputIndex?: number): unknown => {
    if (Array.isArray(value)) return mapArray(value, (item, index) => visit(item, index))
    if (!isRecord(value)) return value
    if (value.type === "function_call") {
      const wireAlias = findAlias(value, aliases, WIRE_NAMESPACE)
      const alias = wireAlias ?? findAlias(value, aliases, "collaboration")
      if (!alias) return value
      const restored = wireAlias ? { ...value, namespace: "collaboration", name: alias.name } : value
      if (!alias.encryptedParameters) return restored
      const keys = [
        ...(typeof value.call_id === "string" ? [`call:${value.call_id}`] : []),
        ...(typeof value.id === "string" ? [`item:${value.id}`] : []),
        ...(outputIndex !== undefined ? [`index:${outputIndex}`] : []),
      ]
      const explicit = restored.encrypted_function_args
      const rememberedKey = keys.find((key) => state.has(key))
      const metadata = explicit ?? (rememberedKey === undefined ? undefined : state.get(rememberedKey))
      // Only explicit evidence is remembered; inferred encoding may change as arguments finish.
      if (metadata != null) for (const key of keys) state.set(key, metadata)
      const completeItem = complete && (restored.status == null || restored.status === "completed")
      const encoding = metadata ?? (completeItem ? inferEncoding(restored.arguments, alias.encryptedParameters) : undefined)
      return encoding !== undefined && explicit == null ? { ...restored, encrypted_function_args: encoding } : restored
    }
    let result = value
    for (const key of ["item", "response", "output"] as const) {
      if (!(key in value)) continue
      const index = typeof value.output_index === "number" ? value.output_index : outputIndex
      const mapped = visit(value[key], index)
      if (mapped !== value[key]) result = { ...result, [key]: mapped }
    }
    return result
  }
  return visit(value)
}
