"use client";


import { cn } from "@/lib/utils";
import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@nocoo/basalt";

interface CopyButtonProps {
  value: string;
  className?: string;
}

export function CopyButton({ value, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 800);
    } catch {
      // Clipboard API may fail (e.g., no permission) — fail silently
    }
  }, [value]);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      className={cn("text-basalt-muted-foreground hover:text-basalt-foreground", className)}
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-basalt-chart-5" strokeWidth={1.5} />
      ) : (
        <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
      )}
    </Button>
  );
}
