"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, Key, Trash2, Ban, AlertTriangle, Cable, Terminal, Code2, Loader2 } from "lucide-react";
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
import { CopyButton } from "@/components/copy-button";
import { CodeBlock } from "@/components/code-block";
import { cn } from "@/lib/utils";
import type { ApiKeyPublic, ApiKeyCreated, ConnectionInfo } from "@/lib/types";

interface ConnectContentProps {
  keys: ApiKeyPublic[];
  connectionInfo: ConnectionInfo;
}

export function ConnectContent({ keys, connectionInfo }: ConnectContentProps) {
  return (
    <div className="space-y-8">
      <ConnectionInfoSection info={connectionInfo} />
      <ModelsSection models={connectionInfo.models} />
      <CodeExamplesSection info={connectionInfo} />
      <ApiKeysSection keys={keys} />
    </div>
  );
}

// ── Connection Info ──

function ConnectionInfoSection({ info }: { info: ConnectionInfo }) {
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

// ── Models ──

function ModelsSection({ models }: { models: string[] }) {
  if (models.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">Available Models</h2>
      <div className="flex flex-wrap gap-2">
        {models.map((model) => (
          <div key={model} className="group flex items-center gap-1">
            <Badge variant="secondary" className="font-mono text-xs">
              {model}
            </Badge>
            <CopyButton value={model} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Code Examples ──

type CodeTab = "curl" | "python" | "typescript" | "claude-code";

function CodeExamplesSection({ info }: { info: ConnectionInfo }) {
  const [activeTab, setActiveTab] = useState<CodeTab>("curl");

  const tabs: { id: CodeTab; label: string; icon: React.ElementType }[] = [
    { id: "curl", label: "curl", icon: Terminal },
    { id: "python", label: "Python", icon: Code2 },
    { id: "typescript", label: "TypeScript", icon: Code2 },
    { id: "claude-code", label: "Claude Code", icon: Terminal },
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
    "claude-code": `// Add to your Claude Code settings.json "env" block:
{
  "ANTHROPIC_AUTH_TOKEN": "rk-...",
  "ANTHROPIC_BASE_URL": "${info.base_url}",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4.6",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4.6",
  "ANTHROPIC_MODEL": "claude-opus-4.6",
  "ANTHROPIC_REASONING_MODEL": "claude-opus-4.6"
}`,
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

// ── API Keys ──

function ApiKeysSection({ keys: initialKeys }: { keys: ApiKeyPublic[] }) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCreated = useCallback(() => {
    setDialogOpen(false);
    router.refresh();
  }, [router]);

  const handleAction = useCallback(async (id: string, action: "revoke" | "delete") => {
    setActionError(null);
    setActionLoading(id);
    try {
      const res = await fetch(
        action === "revoke" ? `/api/keys/${id}/revoke` : `/api/keys/${id}`,
        { method: action === "revoke" ? "POST" : "DELETE" },
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
  }, [router]);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Key className="h-4 w-4" strokeWidth={1.5} />
          API Keys
        </h2>
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
          <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" strokeWidth={1.5} />
          <p className="text-xs text-destructive">{actionError}</p>
        </div>
      )}

      {initialKeys.length === 0 ? (
        <div className="rounded-widget border border-border/40 bg-secondary/30 px-6 py-8 text-center">
          <Key className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">No API keys yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Create a key to authenticate client requests</p>
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
                    <code className="text-xs text-muted-foreground">{key.key_prefix}...</code>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(key.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : "Never"}
                  </TableCell>
                  <TableCell>
                    {key.revoked_at ? (
                      <Badge variant="destructive" className="text-[10px]">Revoked</Badge>
                    ) : (
                      <Badge variant="success" className="text-[10px]">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {key.revoked_at ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => handleAction(key.id, "delete")}
                        disabled={actionLoading !== null}
                        aria-label="Delete key"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" strokeWidth={1.5} />
                      </Button>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => handleAction(key.id, "revoke")}
                        disabled={actionLoading !== null}
                        aria-label="Revoke key"
                      >
                        {actionLoading === key.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                        ) : (
                          <Ban className="h-3.5 w-3.5" strokeWidth={1.5} />
                        )}
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
        const errMsg = typeof data.error === "string"
          ? data.error
          : data.error?.message ?? "Failed to create key";
        setError(errMsg);
        return;
      }
      const data = await res.json() as ApiKeyCreated;
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
            <code className="text-xs font-mono flex-1 break-all select-all">{createdKey}</code>
            <CopyButton value={createdKey} />
          </div>
          <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" strokeWidth={1.5} />
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
