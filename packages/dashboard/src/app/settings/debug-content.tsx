"use client"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"

interface DebugInfo {
  enabled: boolean
  key: string
}

interface DebugContentProps {
  data: Record<string, DebugInfo>
}

const DEBUG_ITEMS = [
  {
    id: "tool_call_debug",
    label: "Tool Call Debug",
    description:
      "Emit debug-level events for tool call processing (definitions, invocations, stop reasons). View in Logs page with debug filter enabled.",
  },
]

export function DebugContent({ data }: DebugContentProps) {
  const router = useRouter()
  const info = data.tool_call_debug

  if (!info) {
    return (
      <p className="text-sm text-muted-foreground">
        Debug settings not available
      </p>
    )
  }

  const key = info.key
  const [enabled, setEnabled] = useState(info.enabled)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleToggle(checked: boolean) {
    setEnabled(checked)
    setSaving(true)
    setError(null)

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: checked ? "true" : "false" }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to update setting")
      }

      router.refresh()
    } catch (err) {
      setEnabled(!checked)
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        Debugging
      </h2>
      <div className="grid gap-3">
        {DEBUG_ITEMS.map((item) => (
          <div
            key={item.id}
            className="rounded-widget border border-border/40 bg-secondary/50 p-4"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <Label
                  htmlFor={`debug-${item.id}`}
                  className="text-sm font-medium cursor-pointer"
                >
                  {item.label}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                <Switch
                  id={`debug-${item.id}`}
                  checked={enabled}
                  onCheckedChange={handleToggle}
                  disabled={saving}
                />
              </div>
            </div>
            {error && <p className="text-xs text-destructive mt-2">{error}</p>}
          </div>
        ))}
      </div>
    </section>
  )
}
