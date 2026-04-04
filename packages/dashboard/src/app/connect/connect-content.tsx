"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Key,
  Trash2,
  Ban,
  AlertTriangle,
  Cable,
  Terminal,
  Code2,
  Loader2,
  Cpu,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { CopyButton } from "@/components/copy-button";
import { CodeBlock } from "@/components/code-block";
import { cn } from "@/lib/utils";
import type { ApiKeyPublic, ApiKeyCreated, ConnectionInfo, ModelInfo } from "@/lib/types";

interface ConnectContentProps {
  keys: ApiKeyPublic[];
  connectionInfo: ConnectionInfo;
}

export function ConnectContent({ keys, connectionInfo }: ConnectContentProps) {
  // Use model_list if available, otherwise fall back to models array
  const models: ModelInfo[] = connectionInfo.model_list ??
    connectionInfo.models.map((id) => ({ id, owned_by: "unknown" }));

  return (
    <Tabs defaultValue="keys" className="w-full">
      <TabsList className="mb-6">
        <TabsTrigger value="keys" className="gap-1.5">
          <Key className="h-4 w-4" strokeWidth={1.5} />
          <span className="hidden sm:inline">Keys</span>
        </TabsTrigger>
        <TabsTrigger value="code" className="gap-1.5">
          <Code2 className="h-4 w-4" strokeWidth={1.5} />
          <span className="hidden sm:inline">Code</span>
        </TabsTrigger>
        <TabsTrigger value="models" className="gap-1.5">
          <Cpu className="h-4 w-4" strokeWidth={1.5} />
          <span className="hidden sm:inline">Models</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="keys">
        <ApiKeysSection keys={keys} />
      </TabsContent>

      <TabsContent value="code">
        <div className="space-y-8">
          <EndpointsSection info={connectionInfo} />
          <CodeExamplesSection info={connectionInfo} />
          <SetupGuidesSection baseUrl={connectionInfo.base_url} />
        </div>
      </TabsContent>

      <TabsContent value="models">
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
    { label: "Anthropic Messages", value: `${info.base_url}${info.endpoints.messages}` },
    { label: "Models", value: `${info.base_url}${info.endpoints.models}` },
    { label: "Embeddings", value: `${info.base_url}${info.endpoints.embeddings}` },
  ];

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
        <Cable className="h-4 w-4" strokeWidth={1.5} />
        Endpoints
      </h2>
      <div className="grid gap-2">
        {endpoints.map((ep) => (
          <div
            key={ep.label}
            className="flex items-center justify-between rounded-widget bg-secondary/50 border border-border/40 px-4 py-2.5"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs text-muted-foreground shrink-0 w-36">{ep.label}</span>
              <code className="text-xs font-mono text-foreground truncate">{ep.value}</code>
            </div>
            <CopyButton value={ep.value} />
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Code Examples Section ──

type CodeTab = "curl" | "python" | "typescript";

function CodeExamplesSection({ info }: { info: ConnectionInfo }) {
  const [activeTab, setActiveTab] = useState<CodeTab>("curl");

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
    "model": "claude-sonnet-4",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${info.base_url}/v1",
    api_key="rk-...",
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${info.base_url}/v1",
  apiKey: "rk-...",
});

const message = await client.messages.create({
  model: "claude-sonnet-4",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(message.content);`,
  };

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">Code Examples</h2>
      <div className="rounded-widget border border-border/40 overflow-hidden">
        <div className="flex border-b border-border/40 bg-secondary/30">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors",
                activeTab === tab.id
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <tab.icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              {tab.label}
            </button>
          ))}
        </div>
        <CodeBlock code={examples[activeTab]} className="border-0 rounded-none" />
      </div>
    </section>
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
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
        <Terminal className="h-4 w-4" strokeWidth={1.5} />
        Setup Guides
      </h2>
      <div className="rounded-widget border border-border/40 overflow-hidden">
        <div className="flex border-b border-border/40 bg-secondary/30">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors",
                activeTab === tab.id
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="p-4">
          {activeTab === "claude-code" && <ClaudeCodeGuide baseUrl={baseUrl} />}
          {activeTab === "codex" && <CodexGuide baseUrl={baseUrl} />}
          {activeTab === "cc-switch" && <CCSwitchGuide />}
        </div>
      </div>
    </section>
  );
}

function ClaudeCodeGuide({ baseUrl }: { baseUrl: string }) {
  const envConfig = `{
  "ANTHROPIC_AUTH_TOKEN": "rk-...",
  "ANTHROPIC_BASE_URL": "${baseUrl}",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4.6",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4.6",
  "ANTHROPIC_MODEL": "claude-opus-4.6",
  "ANTHROPIC_REASONING_MODEL": "claude-opus-4.6"
}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Add the following to your Claude Code{" "}
        <code className="text-xs bg-secondary/70 px-1 py-0.5 rounded">settings.json</code>{" "}
        env block:
      </p>
      <CodeBlock code={envConfig} className="text-xs" />
      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/30 rounded-widget p-3">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5" strokeWidth={1.5} />
        <span>
          Replace <code className="bg-secondary/70 px-1 rounded">rk-...</code> with your API key from the Keys tab.
          Adjust model names as needed.
        </span>
      </div>
    </div>
  );
}

function CodexGuide({ baseUrl }: { baseUrl: string }) {
  const envVars = `export OPENAI_BASE_URL="${baseUrl}/v1"
export OPENAI_API_KEY="rk-..."`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Set these environment variables in your shell profile{" "}
        <code className="text-xs bg-secondary/70 px-1 py-0.5 rounded">~/.bashrc</code>,{" "}
        <code className="text-xs bg-secondary/70 px-1 py-0.5 rounded">~/.zshrc</code>, etc:
      </p>
      <CodeBlock code={envVars} className="text-xs" />
      <p className="text-sm text-muted-foreground">Then run Codex:</p>
      <CodeBlock code='codex "Explain this codebase"' className="text-xs" />
    </div>
  );
}

function CCSwitchGuide() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <a
          href="https://github.com/farion1231/cc-switch"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          CC Switch
          <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
        </a>{" "}
        is a command-line tool to quickly switch between Claude Code configurations —
        ideal for toggling between Raven and direct Anthropic API.
      </p>
      <div className="space-y-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Installation</p>
          <CodeBlock code="brew install farion1231/tap/cc-switch" className="text-xs" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Usage</p>
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
      <div className="rounded-widget border border-border/40 bg-secondary/30 px-6 py-8 text-center">
        <Cpu className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" strokeWidth={1.5} />
        <p className="text-sm text-muted-foreground">No models available</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Connect to GitHub Copilot or add upstream providers
        </p>
      </div>
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
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
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

      <Accordion type="multiple" defaultValue={["copilot"]} className="w-full">
        {/* Copilot Models */}
        {copilotGroups.length > 0 && (
          <AccordionItem value="copilot">
            <AccordionTrigger className="text-sm">
              <div className="flex items-center gap-2">
                <span>Copilot Models</span>
                <Badge variant="secondary" className="text-xs font-normal">
                  {copilotGroups.reduce((sum, [, m]) => sum + m.length, 0)}
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">
                {copilotGroups.map(([vendor, vendorModels]) => (
                  <ModelGroup key={vendor} vendor={vendor} models={vendorModels} />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {/* Upstream Models */}
        {upstreamGroups.length > 0 && (
          <AccordionItem value="upstream">
            <AccordionTrigger className="text-sm">
              <div className="flex items-center gap-2">
                <span>Upstream Providers</span>
                <Badge variant="outline" className="text-xs font-normal">
                  {upstreamGroups.reduce((sum, [, m]) => sum + m.length, 0)}
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">
                {upstreamGroups.map(([provider, providerModels]) => (
                  <ModelGroup key={provider} vendor={provider} models={providerModels} />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </div>
  );
}

function ModelGroup({ vendor, models }: { vendor: string; models: ModelInfo[] }) {
  // Capitalize vendor name
  const displayName = vendor.charAt(0).toUpperCase() + vendor.slice(1);

  return (
    <div className="rounded-widget border border-border/40 overflow-hidden">
      <div className="flex items-center justify-between bg-secondary/30 px-4 py-2">
        <span className="text-sm font-medium">{displayName}</span>
        <Badge variant="secondary" className="text-xs">{models.length}</Badge>
      </div>
      <div className="p-2">
        <div className="flex flex-wrap gap-2">
          {models.map((model) => (
            <div key={model.id} className="group flex items-center gap-1">
              <Badge variant="outline" className="font-mono text-xs">
                {model.id}
              </Badge>
              <CopyButton
                value={model.id}
                className="opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── API Keys Section ──

function ApiKeysSection({ keys: initialKeys }: { keys: ApiKeyPublic[] }) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
    <section>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-medium">API Keys</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Create and manage API keys for authenticating client requests
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
              Create Key
            </Button>
          </DialogTrigger>
          <CreateKeyDialog onCreated={handleCreated} />
        </Dialog>
      </div>

      {actionError && (
        <div className="flex items-center gap-2 rounded-widget border border-destructive/40 bg-destructive/10 px-3 py-2 mb-3">
          <AlertTriangle
            className="h-3.5 w-3.5 text-destructive shrink-0"
            strokeWidth={1.5}
          />
          <p className="text-xs text-destructive">{actionError}</p>
        </div>
      )}

      {initialKeys.length === 0 ? (
        <div className="rounded-widget border border-border/40 bg-secondary/30 px-6 py-8 text-center">
          <Key
            className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2"
            strokeWidth={1.5}
          />
          <p className="text-sm text-muted-foreground">No API keys yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Create a key to authenticate client requests
          </p>
        </div>
      ) : (
        <div className="rounded-widget border border-border/40 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">
                      {key.key_prefix}...
                    </code>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(key.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {key.last_used_at
                      ? new Date(key.last_used_at).toLocaleDateString()
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
                        className="h-7 w-[72px] text-xs text-destructive hover:bg-destructive/10 gap-1.5"
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
                        className="h-7 w-[72px] text-xs hover:bg-accent gap-1.5"
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
    </section>
  );
}

// ── Create Key Dialog ──

function CreateKeyDialog({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
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
          <div className="flex items-center gap-2 rounded-widget bg-secondary/50 border border-border/40 px-3 py-2">
            <code className="text-xs font-mono flex-1 break-all select-all">
              {createdKey}
            </code>
            <CopyButton value={createdKey} />
          </div>
          <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
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
          Give your key a name to identify it later.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="key-name">Name</Label>
        <Input
          id="key-name"
          placeholder="e.g. cursor-mbp, claude-code"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          maxLength={64}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button onClick={handleCreate} disabled={loading || !name.trim()}>
          {loading ? "Creating..." : "Create"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
