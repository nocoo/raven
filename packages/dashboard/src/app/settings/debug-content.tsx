"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { SettingsCard, SettingsSection, SettingToggleRow } from "./settings-ui"

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
  const info = data.tool_call_debug

  if (!info) {
    return (
      <p className="text-sm text-basalt-muted-foreground">
        Debug settings not available
      </p>
    )
  }

  return <DebugContentBody info={info} />
}

function DebugContentBody({ info }: { info: DebugInfo }) {
  const router = useRouter()
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
    <SettingsSection title="Debugging">
      <SettingsCard>
        {DEBUG_ITEMS.map((item) => (
          <SettingToggleRow
            key={item.id}
            id={`debug-${item.id}`}
            label={item.label}
            description={item.description}
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
            saving={saving}
            error={error}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}
