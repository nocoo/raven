"use client";

import { CopyButton } from "./copy-button";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  className?: string;
}

export function CodeBlock({ code, className }: CodeBlockProps) {
  return (
    <div className={cn("relative group rounded-widget bg-secondary/50 border border-border/30", className)}>
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton value={code} />
      </div>
      <pre className="p-4 overflow-x-auto text-xs leading-relaxed text-muted-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}
