"use client";

import { CopyButton } from "./copy-button";
import { cn } from "@/lib/utils";
import { LayerCard } from "@nocoo/basalt";

interface CodeBlockProps {
  code: string;
  className?: string;
}

export function CodeBlock({ code, className }: CodeBlockProps) {
  return (
    <LayerCard padding="none" className={cn("relative group", className ?? "")}>
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton value={code} />
      </div>
      <pre className="p-4 overflow-x-auto text-xs leading-relaxed text-basalt-muted-foreground">
        <code>{code}</code>
      </pre>
    </LayerCard>
  );
}
