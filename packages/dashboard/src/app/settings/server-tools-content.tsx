"use client"

import { Button, Input, LayerCard, Switch } from "@nocoo/basalt"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { SettingNote, SettingsCard, SettingsSection } from "./settings-ui"

interface ServerToolsContentProps {
  data: Record<string, { enabled: boolean; has_api_key: boolean }>
}

const SERVER_TOOL_ITEMS = [
  {
    id: "web_search",
    label: "Web Search",
    description:
      "Replace Anthropic's built-in web_search with Tavily API. Required when routing through GitHub Copilot upstream.",
    key: "st_web_search_enabled",
    apiKeyKey: "st_web_search_api_key",
  },
]

export function ServerToolsContent({ data }: ServerToolsContentProps) {
  const router = useRouter()
  const webSearch = data.web_search

  const [enabled, setEnabled] = useState(webSearch?.enabled ?? false)
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)

  async function handleToggle(checked: boolean) {
    setEnabled(checked)
    setSaving(true)
    setError(null)

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "st_web_search_enabled", value: checked ? "true" : "false" }),
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

  async function handleSaveKey() {
    if (!apiKey.trim()) {
      setKeyError("API key is required")
      return
    }

    setSavingKey(true)
    setKeyError(null)

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "st_web_search_api_key", value: apiKey.trim() }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to save API key")
      }

      setApiKey("")
      router.refresh()
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <SettingsSection
      title="Server Tools"
      hint="Replace Anthropic server-side tools with third-party APIs. Required when routing through GitHub Copilot."
    >
      {SERVER_TOOL_ITEMS.map((item) => {
        const itemEnabled = item.id === "web_search" ? enabled : false
        const hasKey = item.id === "web_search" ? (webSearch?.has_api_key ?? false) : false

        return (
          <SettingsCard
            key={item.id}
            title={item.label}
            action={
              <div className="flex items-center gap-2">
                {saving ? <Loader2 className="h-3 w-3 animate-spin text-basalt-muted-foreground" /> : null}
                <Switch
                  id={`st-${item.id}`}
                  checked={itemEnabled}
                  onCheckedChange={handleToggle}
                  disabled={saving}
                />
              </div>
            }
          >
            <SettingNote>{item.description}</SettingNote>
            {error ? <p className="text-xs text-basalt-destructive">{error}</p> : null}

            {itemEnabled ? (
              <LayerCard.Well className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">API Key</span>
                  {hasKey && !apiKey ? (
                    <span className="flex items-center gap-1 text-xs text-basalt-chart-5">
                      <span className="size-1.5 rounded-full bg-basalt-chart-5" />
                      Configured
                    </span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder={hasKey ? "Update API key..." : "Enter Tavily API key..."}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={savingKey}
                    className="h-8 flex-1 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSaveKey}
                    disabled={savingKey || !apiKey.trim()}
                    className="h-8 shrink-0 px-3 text-xs"
                  >
                    {savingKey ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                  </Button>
                </div>
                {keyError ? <p className="text-xs text-basalt-destructive">{keyError}</p> : null}
                {!hasKey && itemEnabled ? (
                  <p className="text-xs text-basalt-warning">API key required for search functionality</p>
                ) : null}
                <SettingNote>
                  Get your API key at{" "}
                  <a
                    href="https://tavily.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-basalt-foreground"
                  >
                    tavily.com
                  </a>
                </SettingNote>
              </LayerCard.Well>
            ) : null}
          </SettingsCard>
        )
      })}
    </SettingsSection>
  )
}
