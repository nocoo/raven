"use client";








import type { RoutingRule } from "@/lib/routing-types";
import { COPILOT_RULE_ID } from "@/lib/routing-model";
import { RoutingSelect } from "@/components/routing/routing-ui";
import { KeyRuleBinding } from "./key-rule-binding";
import { CopyButton } from "@/components/copy-button";
import { LocalTime } from "@/components/local-time";
import { CodeBlock } from "@/components/code-block";
import { SectionIcon } from "@/components/section-icon";
import type { ApiKeyPublic, ApiKeyCreated, ConnectionInfo, ModelInfo } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plus, Key, Trash2, Ban, AlertTriangle, Terminal, Code2, Loader2, Cpu, ExternalLink, ChevronRight, Plug, BookOpen, } from "lucide-react";
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label, LayerCard, Tabs, TabsContent, TabsList, TabsTrigger } from "@nocoo/basalt";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nocoo/basalt/components/table";

interface ConnectContentProps {
  keys: ApiKeyPublic[];
  connectionInfo: ConnectionInfo;
  rules: RoutingRule[];
}

export function ConnectContent({ keys, connectionInfo, rules }: ConnectContentProps) {
  // Use model_list if available, otherwise fall back to models array
  const models: ModelInfo[] = connectionInfo.model_list ??
    connectionInfo.models.map((id) => ({ id, owned_by: "unknown" }));

  return (
    <Tabs defaultValue="keys" className="w-full">
      <TabsList className="mb-4">
        <TabsTrigger value="keys" className="gap-1.5">
          <Key className="h-4 w-4" strokeWidth={1.5} />
          <span className="inline">Keys</span>
        </TabsTrigger>
        <TabsTrigger value="code" className="gap-1.5">
          <Code2 className="h-4 w-4" strokeWidth={1.5} />
          <span className="inline">Code</span>
        </TabsTrigger>
        <TabsTrigger value="models" className="gap-1.5">
          <Cpu className="h-4 w-4" strokeWidth={1.5} />
          <span className="inline">Models</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="keys">
        <ApiKeysSection keys={keys} rules={rules} />
      </TabsContent>

      <TabsContent value="code">
        <div className="space-y-4">
          <div className="settings-grid">
            <EndpointsSection info={connectionInfo} />
            <CodeExamplesSection info={connectionInfo} />
          </div>
          <SetupGuidesSection baseUrl={connectionInfo.base_url} />
          <Collapsible>
            <CollapsibleTrigger className="text-xs text-basalt-muted-foreground">Routing and protocol details</CollapsibleTrigger>
            <CollapsibleContent unstyled><div className="max-w-prose space-y-2 pt-3 text-xs text-basalt-muted-foreground">
              <p><code>auto</code> uses the key’s rule, current schedule and quota order. Explicit model IDs use the same upstream selection and pass through unchanged. Errors stop on that upstream.</p>
              <p>Use the upstream’s native API format unless the rule enables conversion.</p>
              <p>Embeddings currently require Copilot. Explicit IDs need no catalog; auto needs cached embedding capability.</p>
            </div></CollapsibleContent>
          </Collapsible>
        </div>
      </TabsContent>

      <TabsContent value="models">
        <p className="mb-3 text-sm text-basalt-muted-foreground">A global, cached catalog: auto plus exact IDs from every upstream. It is not filtered by your key’s rule or current period and does not guarantee availability on the selected upstream.</p>
        <ModelsSection models={models} />
      </TabsContent>
    </Tabs>
  );
}

// ── Endpoints Section ──

function EndpointsSection({ info }: { info: ConnectionInfo }) {
  const endpoints = [
    { label: "Base URL", value: info.base_url },
    { label: "Chat Completions", value: `${info.base_url}${info.endpoints.chat_completions}` },
    { label: "OpenAI Responses", value: `${info.base_url}${info.endpoints.responses}` },
    { label: "Anthropic Messages", value: `${info.base_url}${info.endpoints.messages}` },
    { label: "Models", value: `${info.base_url}${info.endpoints.models}` },
    { label: "Embeddings", value: `${info.base_url}${info.endpoints.embeddings}` },
  ];

  return (
    <LayerCard className="min-w-0">
      <LayerCard.Header><h2 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={Plug} tone="blue" />Endpoints</h2></LayerCard.Header>
      <LayerCard.Body className="divide-y divide-basalt-border/50">
        {endpoints.map((ep) => (
          <div
            key={ep.label}
            className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 space-y-1">
              <span className="block text-xs text-basalt-muted-foreground">{ep.label}</span>
              <code className="block truncate font-mono text-xs text-basalt-foreground" title={ep.value}>{ep.value}</code>
            </div>
            <CopyButton value={ep.value} />
          </div>
        ))}
      </LayerCard.Body>
    </LayerCard>
  );
}

// ── Code Examples Section ──

type CodeTab = "curl" | "python" | "typescript";

function CodeExamplesSection({ info }: { info: ConnectionInfo }) {
  const [activeTab, setActiveTab] = useState<CodeTab>("curl");
  const [selection, setSelection] = useState("auto");
  const [explicitModel, setExplicitModel] = useState("gpt-5.6-sol");
  const exampleModel = JSON.stringify(selection === "auto" ? "auto" : explicitModel);

  const tabs: { id: CodeTab; label: string; icon: React.ElementType }[] = [
    { id: "curl", label: "curl", icon: Terminal },
    { id: "python", label: "Python", icon: Code2 },
    { id: "typescript", label: "TypeScript", icon: Code2 },
  ];

  const examples: Record<CodeTab, string> = {
    curl: `curl ${info.base_url}${info.endpoints.chat_completions} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer rk-..." \\
  -d '{
    "model": ${exampleModel.replace(/'/g, "'\\''")},
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${info.base_url}/v1",
    api_key="rk-...",
)

response = client.chat.completions.create(
    model=${exampleModel},
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${info.base_url}",
  apiKey: "rk-...",
});

const message = await client.messages.create({
  model: ${exampleModel},
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(message.content);`,
  };

  return (
    <LayerCard className="min-w-0 overflow-hidden">
      <LayerCard.Header><h2 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={Code2} tone="purple" />Code examples</h2></LayerCard.Header>
      <LayerCard.Body>
      <div className="grid max-w-xl gap-3 @min-[32rem]/page:grid-cols-2">
        <RoutingSelect label="Model selection" value={selection} onChange={setSelection} options={[{ value: "auto", label: "auto · configured target model" }, { value: "explicit", label: "Explicit · preserve model ID" }]} />
        {selection === "explicit" && <div className="space-y-1.5"><Label htmlFor="example-model">Explicit model ID</Label><Input id="example-model" size="sm" value={explicitModel} onChange={event => setExplicitModel(event.target.value)} /></div>}
      </div>
      </LayerCard.Body>
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as CodeTab)}>
          <TabsList className="mx-4">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5">
                <tab.icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab) => (
            <TabsContent key={tab.id} value={tab.id}>
              <CodeBlock code={examples[tab.id]} className="border-0 rounded-none" />
            </TabsContent>
          ))}
        </Tabs>
    </LayerCard>
  );
}

// ── Setup Guides Section ──

type SetupTab = "claude-code" | "codex" | "cc-switch";

function SetupGuidesSection({ baseUrl }: { baseUrl: string }) {
  const [activeTab, setActiveTab] = useState<SetupTab>("claude-code");

  const tabs: { id: SetupTab; label: string }[] = [
    { id: "claude-code", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "cc-switch", label: "CC Switch" },
  ];

  return (
    <Collapsible asChild>
      <LayerCard className="overflow-hidden">
        <LayerCard.Header><h2 className="w-full"><CollapsibleTrigger className="w-full justify-between text-sm font-semibold text-basalt-foreground"><span className="flex items-center gap-2.5"><SectionIcon icon={BookOpen} tone="orange" />Client setup guides</span></CollapsibleTrigger></h2></LayerCard.Header>
        <CollapsibleContent unstyled><LayerCard.Body>
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SetupTab)}>
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="claude-code" className="p-4">
            <ClaudeCodeGuide baseUrl={baseUrl} />
          </TabsContent>
          <TabsContent value="codex" className="p-4">
            <CodexGuide baseUrl={baseUrl} />
          </TabsContent>
          <TabsContent value="cc-switch" className="p-4">
            <CCSwitchGuide />
          </TabsContent>
        </Tabs>
        </LayerCard.Body></CollapsibleContent>
      </LayerCard>
    </Collapsible>
  );
}

function ClaudeCodeGuide({ baseUrl }: { baseUrl: string }) {
  const envConfig = `{
  "ANTHROPIC_AUTH_TOKEN": "rk-...",
  "ANTHROPIC_BASE_URL": "${baseUrl}",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "auto",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "auto",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "auto",
  "ANTHROPIC_MODEL": "auto",
  "ANTHROPIC_REASONING_MODEL": "auto"
}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-basalt-muted-foreground">
        Add the following to your Claude Code{" "}
        <code className="text-xs bg-basalt-secondary/70 px-1 py-0.5 rounded">settings.json</code>{" "}
        env block:
      </p>
      <CodeBlock code={envConfig} className="text-xs" />
      <LayerCard.Well className="flex items-start gap-2 text-xs text-basalt-muted-foreground">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5" strokeWidth={1.5} />
        <span>
          Replace <code className="bg-basalt-secondary/70 px-1 rounded">rk-...</code> with your API key from the Keys tab.
          Adjust model names as needed.
        </span>
      </LayerCard.Well>
    </div>
  );
}

function CodexGuide({ baseUrl }: { baseUrl: string }) {
  const envVars = `export OPENAI_BASE_URL="${baseUrl}/v1"
export OPENAI_API_KEY="rk-..."`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-basalt-muted-foreground">
        Set these environment variables in your shell profile{" "}
        <code className="text-xs bg-basalt-secondary/70 px-1 py-0.5 rounded">~/.bashrc</code>,{" "}
        <code className="text-xs bg-basalt-secondary/70 px-1 py-0.5 rounded">~/.zshrc</code>, etc:
      </p>
      <CodeBlock code={envVars} className="text-xs" />
      <p className="text-sm text-basalt-muted-foreground">Then run Codex:</p>
      <CodeBlock code='codex "Explain this codebase"' className="text-xs" />
    </div>
  );
}

function CCSwitchGuide() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-basalt-muted-foreground">
        <a
          href="https://github.com/farion1231/cc-switch"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-basalt-primary hover:underline"
        >
          CC Switch
          <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
        </a>{" "}
        is a command-line tool to quickly switch between Claude Code configurations —
        ideal for toggling between Raven and direct Anthropic API.
      </p>
      <div className="space-y-3">
        <div>
          <p className="text-xs font-medium text-basalt-muted-foreground mb-2">Installation</p>
          <CodeBlock code="brew install farion1231/tap/cc-switch" className="text-xs" />
        </div>
        <div>
          <p className="text-xs font-medium text-basalt-muted-foreground mb-2">Usage</p>
          <CodeBlock
            code={`# Switch to Raven
cc-switch raven

# Switch to direct Anthropic
cc-switch anthropic

# Check current config
cc-switch status`}
            className="text-xs"
          />
        </div>
      </div>
      <div className="flex items-start gap-2 text-xs text-basalt-warning">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" strokeWidth={1.5} />
        <span>
          When configuring the model, use the hyphenated ID (e.g.{" "}
          <code className="bg-basalt-secondary/70 px-1 rounded">claude-opus-4-8</code>), not the
          dotted form (<code className="bg-basalt-secondary/70 px-1 rounded">claude-opus-4.8</code>).
          Both work upstream, but the status line only resolves the marketing name
          (&ldquo;Opus 4.8&rdquo;) from the hyphenated form &mdash; the dotted form shows a
          generic &ldquo;Opus 4&rdquo;.
        </span>
      </div>
    </div>
  );
}

// ── Models Section ──

// Known Copilot vendors (models from GitHub Copilot API)
const COPILOT_VENDORS = new Set([
  "openai",
  "anthropic",
  "google",
  "mistralai",
  "cohere",
  "meta",
  "xai",
  "ai21",
]);

function ModelsSection({ models }: { models: ModelInfo[] }) {
  if (models.length === 0) {
    return (
      <LayerCard padding="none">
        <LayerCard.Empty
          icon={<Cpu className="h-8 w-8" strokeWidth={1.5} />}
          title="No models available"
          description="Connect to GitHub Copilot or add upstream providers"
        />
      </LayerCard>
    );
  }

  // Group models by owned_by
  const grouped = models.reduce<Record<string, ModelInfo[]>>((acc, model) => {
    const key = model.owned_by || "unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(model);
    return acc;
  }, {});

  // Separate into Copilot vs Upstream
  const copilotGroups: [string, ModelInfo[]][] = [];
  const upstreamGroups: [string, ModelInfo[]][] = [];

  for (const [vendor, vendorModels] of Object.entries(grouped)) {
    if (COPILOT_VENDORS.has(vendor.toLowerCase())) {
      copilotGroups.push([vendor, vendorModels]);
    } else {
      upstreamGroups.push([vendor, vendorModels]);
    }
  }

  // Sort groups alphabetically
  copilotGroups.sort((a, b) => a[0].localeCompare(b[0]));
  upstreamGroups.sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="flex items-center gap-4 text-sm text-basalt-muted-foreground">
        <span>{models.length} models available</span>
        {copilotGroups.length > 0 && (
          <Badge variant="secondary" className="text-xs">
            {copilotGroups.reduce((sum, [, m]) => sum + m.length, 0)} Copilot
          </Badge>
        )}
        {upstreamGroups.length > 0 && (
          <Badge variant="outline" className="text-xs">
            {upstreamGroups.reduce((sum, [, m]) => sum + m.length, 0)} Upstream
          </Badge>
        )}
      </div>

      {/* Copilot Models */}
      {copilotGroups.length > 0 && (
        <SectionRule title="Copilot Models">
          <div className="space-y-4">
            {copilotGroups.map(([vendor, vendorModels]) => (
              <ModelGroup key={vendor} vendor={vendor} models={vendorModels} />
            ))}
          </div>
        </SectionRule>
      )}

      {/* Upstream Models */}
      {upstreamGroups.length > 0 && (
        <SectionRule title="Upstream Providers">
          <div className="space-y-4">
            {upstreamGroups.map(([provider, providerModels]) => (
              <ModelGroup key={provider} vendor={provider} models={providerModels} />
            ))}
          </div>
        </SectionRule>
      )}
    </div>
  );
}

function ModelGroup({ vendor, models }: { vendor: string; models: ModelInfo[] }) {
  // Capitalize vendor name
  const displayName = vendor.charAt(0).toUpperCase() + vendor.slice(1);

  return (
    <LayerCard padding="none" className="overflow-hidden">
      <LayerCard.Header className="items-center">
        <h3 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={Cpu} tone="purple" />{displayName}</h3>
        <Badge variant="secondary" className="text-xs">{models.length}</Badge>
      </LayerCard.Header>
        <div className="overflow-x-auto">
        <Table>
          <TableBody>
            {models.map((model) => (
              <TableRow key={model.id} className="group cursor-pointer" onClick={() => navigator.clipboard.writeText(model.id)} title="Click to copy">
                <TableCell className="py-2">
                  <code className="font-mono text-xs">{model.id}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
    </LayerCard>
  );
}

// ── API Keys Section ──

function ApiKeysSection({ keys: initialKeys, rules }: { keys: ApiKeyPublic[]; rules: RoutingRule[] }) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInstance, setDialogInstance] = useState(0);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Remount CreateKeyDialog on every open so its internal state (name input,
  // createdKey, error) starts fresh. Without this, the previous createdKey
  // sticks and the second open skips the name prompt while re-showing the
  // stale key — no new key is actually created.
  const handleOpenChange = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (open) setDialogInstance((n) => n + 1);
  }, []);

  const handleCreated = useCallback(() => {
    setDialogOpen(false);
    router.refresh();
  }, [router]);

  const handleAction = useCallback(
    async (id: string, action: "revoke" | "delete") => {
      setActionError(null);
      setActionLoading(id);
      try {
        const res = await fetch(
          action === "revoke" ? `/api/keys/${id}/revoke` : `/api/keys/${id}`,
          { method: action === "revoke" ? "POST" : "DELETE" }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          const msg = data?.error?.message ?? `Request failed (${res.status})`;
          setActionError(msg);
          return;
        }
        router.refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Action failed");
      } finally {
        setActionLoading(null);
      }
    },
    [router]
  );

  return (
    <LayerCard padding="none" className="overflow-hidden">
      <LayerCard.Header className="items-center gap-3">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={Key} tone="teal" />API keys</h2>
        <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
              Create Key
            </Button>
          </DialogTrigger>
          <CreateKeyDialog key={dialogInstance} onCreated={handleCreated} rules={rules} />
        </Dialog>
      </LayerCard.Header>

      {actionError && (
        <div role="alert" className="m-4 flex items-center gap-2 rounded-widget border border-basalt-destructive/40 bg-basalt-destructive/10 px-3 py-2">
          <AlertTriangle
            className="h-3.5 w-3.5 text-basalt-destructive shrink-0"
            strokeWidth={1.5}
          />
          <p className="text-xs text-basalt-destructive">{actionError}</p>
        </div>
      )}

      {initialKeys.length === 0 ? (
          <LayerCard.Empty
            icon={<Key className="h-8 w-8" strokeWidth={1.5} />}
            title="No API keys yet"
            description="Create a key to authenticate client requests"
          />
      ) : (
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Routing rule</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
                <TableHead className="hidden md:table-cell">Last Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <code className="text-xs text-basalt-muted-foreground">
                      {key.key_prefix}...
                    </code>
                  </TableCell>
                  <TableCell><KeyRuleBinding apiKey={key} rules={rules} /></TableCell>
                  <TableCell className="hidden sm:table-cell text-xs text-basalt-muted-foreground">
                    <LocalTime timestamp={key.created_at} precision="day" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-xs text-basalt-muted-foreground">
                    {key.last_used_at !== null
                      ? <LocalTime timestamp={key.last_used_at} precision="day" />
                      : "Never"}
                  </TableCell>
                  <TableCell>
                    {key.revoked_at ? (
                      <Badge variant="destructive" className="text-[10px]">
                        Revoked
                      </Badge>
                    ) : (
                      <Badge variant="success" className="text-[10px]">
                        Active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="pr-3">
                    {key.revoked_at ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleAction(key.id, "delete")}
                        disabled={actionLoading !== null}
                        className="h-7 w-[72px] text-xs text-basalt-destructive hover:bg-basalt-destructive/10 gap-1.5"
                      >
                        {actionLoading === key.id ? (
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            strokeWidth={1.5}
                          />
                        ) : (
                          <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                        )}
                        Delete
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleAction(key.id, "revoke")}
                        disabled={actionLoading !== null}
                        className="h-7 w-[72px] text-xs hover:bg-basalt-accent gap-1.5"
                      >
                        {actionLoading === key.id ? (
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            strokeWidth={1.5}
                          />
                        ) : (
                          <Ban className="h-3 w-3" strokeWidth={1.5} />
                        )}
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
      )}
    </LayerCard>
  );
}

// ── Create Key Dialog ──

function CreateKeyDialog({ onCreated, rules }: { onCreated: () => void; rules: RoutingRule[] }) {
  const [name, setName] = useState("");
  const [ruleId, setRuleId] = useState(COPILOT_RULE_ID);
  const [loading, setLoading] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || !rules.some(rule => rule.id === ruleId) || loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), rule_id: ruleId }),
      });
      if (!res.ok) {
        const data = await res.json();
        const errMsg =
          typeof data.error === "string"
            ? data.error
            : data.error?.message ?? "Failed to create key";
        setError(errMsg);
        return;
      }
      const data = (await res.json()) as ApiKeyCreated;
      setCreatedKey(data.key);
    } catch {
      setError("Failed to create key");
    } finally {
      setLoading(false);
    }
  };

  if (createdKey) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Key Created</DialogTitle>
          <DialogDescription>
            Copy this key now. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <LayerCard.Well className="flex items-center gap-2">
            <code className="text-xs font-mono flex-1 break-all select-all">
              {createdKey}
            </code>
            <CopyButton value={createdKey} />
          </LayerCard.Well>
          <div className="flex items-start gap-2 text-xs text-basalt-warning">
            <AlertTriangle
              className="h-3.5 w-3.5 shrink-0 mt-0.5"
              strokeWidth={1.5}
            />
            <span>This key will not be shown again. Store it securely.</span>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onCreated}>Done</Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create API Key</DialogTitle>
        <DialogDescription>
          Give your key a name and bind it to exactly one routing rule.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="key-name">Name</Label>
        <Input
          id="key-name"
          placeholder="e.g. cursor-mbp, claude-code"
          value={name}
          disabled={loading}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          maxLength={64}
        />
        <RoutingSelect label="Routing rule" value={ruleId} onChange={setRuleId} disabled={loading} options={rules.map(rule => ({ value: rule.id, label: rule.name }))} />
        <p className="text-xs text-basalt-muted-foreground">The environment client key always uses the protected Copilot rule.</p>
        {error && <p role="alert" className="text-xs text-basalt-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button onClick={handleCreate} disabled={loading || !name.trim() || !rules.some(rule => rule.id === ruleId)}>
          {loading ? "Creating..." : "Create"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
