"use client";

import { useState, useEffect } from "react";
import {
  Monitor,
  Shield,
  Github,
  Terminal,
  Key,
  Cable,
  ChevronRight,
  ChevronLeft,
  Rocket,
  ExternalLink,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/code-block";
import { useAuthConfig } from "@/hooks/use-auth-config";

const STORAGE_KEY = "raven-setup-dismissed";
const TOTAL_STEPS = 3;

// ---------------------------------------------------------------------------
// Step indicator — numbered circles with connecting lines
// ---------------------------------------------------------------------------

function StepIndicator({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  return (
    <div className="flex items-center justify-center gap-0 py-2">
      {Array.from({ length: total }, (_, i) => {
        const isActive = i === current;
        const isDone = i < current;

        return (
          <div key={i} className="flex items-center">
            {/* Circle */}
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors ${
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : isDone
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted-foreground/30 text-muted-foreground/50"
              }`}
            >
              {i + 1}
            </div>
            {/* Connector line */}
            {i < total - 1 && (
              <div
                className={`mx-1 h-0.5 w-10 rounded-full transition-colors ${
                  isDone ? "bg-primary" : "bg-muted-foreground/20"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Dashboard Access
// ---------------------------------------------------------------------------

function StepDashboard() {
  const { authEnabled } = useAuthConfig();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Monitor className="h-5 w-5 text-primary" strokeWidth={1.5} />
        <h3 className="text-base font-semibold">Dashboard Access</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        Raven runs locally on your machine. By default, the dashboard is open to
        anyone who can reach <code className="text-xs bg-secondary/70 px-1 py-0.5 rounded">localhost:7023</code> — no login required.
      </p>

      <div className="rounded-widget border border-border/60 bg-secondary/30 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Current mode</span>
          {authEnabled ? (
            <Badge variant="success">
              <Shield className="h-3 w-3" strokeWidth={1.5} />
              Google OAuth
            </Badge>
          ) : (
            <Badge variant="secondary">
              <Monitor className="h-3 w-3" strokeWidth={1.5} />
              Local (no auth)
            </Badge>
          )}
        </div>

        {!authEnabled && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              To enable Google OAuth login, set these environment variables
              before starting the dashboard:
            </p>
            <CodeBlock
              code={`GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
NEXTAUTH_SECRET=your-random-secret`}
            />
          </div>
        )}

        {authEnabled && (
          <p className="text-xs text-muted-foreground">
            Google OAuth is configured. Only authenticated users can access the
            dashboard.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — GitHub Copilot
// ---------------------------------------------------------------------------

function StepCopilot() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Github className="h-5 w-5 text-primary" strokeWidth={1.5} />
        <h3 className="text-base font-semibold">GitHub Copilot</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        Raven proxies requests through your GitHub Copilot subscription. You
        need to authenticate via GitHub&apos;s Device Flow — this happens in
        your terminal, not in the browser.
      </p>

      <div className="rounded-widget border border-border/60 bg-secondary/30 p-4 space-y-3">
        <p className="text-sm font-medium">Steps</p>
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>Start the proxy server</li>
          <li>
            The proxy prints a <strong>device code</strong> and a{" "}
            <strong>URL</strong> in your terminal
          </li>
          <li>Open the URL in your browser and enter the code</li>
          <li>Authorize the GitHub Copilot app</li>
          <li>The proxy stores the token and is ready to forward requests</li>
        </ol>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          You&apos;ll see output like this in your terminal:
        </p>
        <CodeBlock
          code={`$ bun run dev

[proxy] GitHub Device Flow — authorize at:
[proxy]   https://github.com/login/device
[proxy]   Code: ABCD-1234
[proxy] Waiting for authorization...
[proxy] ✓ Authenticated as @your-github-username`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Connect Your Tools
// ---------------------------------------------------------------------------

function StepApiKey() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Cable className="h-5 w-5 text-primary" strokeWidth={1.5} />
        <h3 className="text-base font-semibold">Connect Your Tools</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        Create an API key on the{" "}
        <strong>
          <Key className="inline h-3.5 w-3.5" strokeWidth={1.5} /> Connect
        </strong>{" "}
        page, then configure your tools to point at Raven.
      </p>

      <div className="rounded-widget border border-border/60 bg-secondary/30 p-4 space-y-3">
        <div className="flex items-center gap-1.5">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-sm font-medium">Claude Code config</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Add this to your Claude Code <code className="bg-secondary/70 px-1 py-0.5 rounded">settings.json</code> env block:
        </p>
        <CodeBlock
          code={`"env": {
  "ANTHROPIC_AUTH_TOKEN": "rk-your-api-key",
  "ANTHROPIC_BASE_URL": "http://localhost:7024",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4.6",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4.6",
  "ANTHROPIC_MODEL": "claude-opus-4.6",
  "ANTHROPIC_REASONING_MODEL": "claude-opus-4.6"
}`}
        />
      </div>

      <div className="rounded-widget border border-border/60 bg-secondary/30 p-4 space-y-2">
        <p className="text-sm font-medium">Recommended tool</p>
        <p className="text-xs text-muted-foreground">
          Use{" "}
          <a
            href="https://github.com/farion1231/cc-switch"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
          >
            CC Switch
            <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
          </a>{" "}
          to manage and switch between Claude Code configurations with ease.
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        Head to the{" "}
        <strong>Connect</strong>{" "}
        page from the sidebar to create your first API key and see examples for
        other tools (curl, Python, TypeScript).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

// Module-level flag — survives component unmount/remount across route changes
let closedThisSession = false;

export function SetupWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [dismiss, setDismiss] = useState(false);

  // SSR-safe: read localStorage only on mount
  useEffect(() => {
    // Already closed in this session — stay hidden even after re-mount
    if (closedThisSession) return;

    try {
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (dismissed !== "true") {
        setOpen(true);
      }
    } catch {
      // localStorage unavailable — show wizard anyway
      setOpen(true);
    }
  }, []);

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      if (dismiss) {
        try {
          localStorage.setItem(STORAGE_KEY, "true");
        } catch {
          // best effort
        }
      }
      closedThisSession = true;
      setOpen(false);
      setStep(0);
    }
  }

  const isFirst = step === 0;
  const isLast = step === TOTAL_STEPS - 1;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" strokeWidth={1.5} />
            Welcome to Raven
          </DialogTitle>
          <DialogDescription>
            Let&apos;s get you set up in a few quick steps.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <StepIndicator current={step} total={TOTAL_STEPS} />

        {/* Step content */}
        <div className="min-h-[260px]">
          {step === 0 && <StepDashboard />}
          {step === 1 && <StepCopilot />}
          {step === 2 && <StepApiKey />}
        </div>

        {/* Footer */}
        <DialogFooter className="flex-row items-center sm:justify-between">
          {/* Dismiss checkbox — left side */}
          <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
            <input
              type="checkbox"
              checked={dismiss}
              onChange={(e) => setDismiss(e.target.checked)}
              className="rounded"
            />
            Don&apos;t show again
          </label>

          {/* Navigation — right side */}
          <div className="flex items-center gap-2">
            {!isFirst && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep((s) => s - 1)}
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
                Back
              </Button>
            )}
            {!isLast ? (
              <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                Next
                <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => handleClose(false)}
              >
                Get Started
                <Rocket className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
