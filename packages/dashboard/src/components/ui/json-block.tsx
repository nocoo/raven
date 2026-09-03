"use client";


import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@nocoo/basalt";

type TokenKind = "key" | "string" | "number" | "boolean" | "null" | "punct" | "whitespace";

export interface JsonToken {
  kind: TokenKind;
  text: string;
}

/**
 * Tokenize a JSON-shaped string for syntax highlighting.
 *
 * Distinguishes object keys from values by looking ahead for a colon. Strings,
 * numbers, true/false/null and punctuation each get their own token kind.
 * Anything that doesn't parse cleanly (trailing characters, invalid escapes)
 * just collapses to a punct/whitespace stream — the caller still gets a
 * readable render rather than an exception.
 */
export function tokenizeJson(input: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  const n = input.length;

  const readString = (): string => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = input[i];
      if (c === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return input.slice(start, i);
      }
      i++;
    }
    return input.slice(start, i);
  };

  while (i < n) {
    const ch = input[i]!;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      const start = i;
      while (i < n && /\s/.test(input[i]!)) i++;
      tokens.push({ kind: "whitespace", text: input.slice(start, i) });
      continue;
    }

    if (ch === '"') {
      const text = readString();
      // Look ahead past whitespace for a colon: if present, this is an object key.
      let j = i;
      while (j < n && /\s/.test(input[j]!)) j++;
      const isKey = input[j] === ":";
      tokens.push({ kind: isKey ? "key" : "string", text });
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const start = i;
      if (ch === "-") i++;
      while (i < n && /[0-9.eE+-]/.test(input[i]!)) i++;
      tokens.push({ kind: "number", text: input.slice(start, i) });
      continue;
    }

    if (input.startsWith("true", i)) {
      tokens.push({ kind: "boolean", text: "true" });
      i += 4;
      continue;
    }
    if (input.startsWith("false", i)) {
      tokens.push({ kind: "boolean", text: "false" });
      i += 5;
      continue;
    }
    if (input.startsWith("null", i)) {
      tokens.push({ kind: "null", text: "null" });
      i += 4;
      continue;
    }

    tokens.push({ kind: "punct", text: ch });
    i++;
  }

  return tokens;
}

const TOKEN_CLASSES: Record<TokenKind, string> = {
  key: "text-[hsl(var(--chart-2))]",
  string: "text-[hsl(var(--chart-3))]",
  number: "text-[hsl(var(--chart-1))]",
  boolean: "text-[hsl(var(--chart-5))]",
  null: "text-muted-foreground",
  punct: "text-muted-foreground",
  whitespace: "",
};

interface JsonBlockProps {
  /** Raw JSON-like text. Will be pretty-printed if it parses; otherwise rendered as-is. */
  value: string;
  /** Optional max height; defaults to a compact pane that scrolls. */
  maxHeightClass?: string;
  className?: string;
}

export function JsonBlock({ value, maxHeightClass = "max-h-48", className }: JsonBlockProps) {
  const [copied, setCopied] = useState(false);

  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }, [value]);

  const tokens = useMemo(() => tokenizeJson(pretty), [pretty]);

  const handleCopy = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(pretty).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {
      /* clipboard blocked — ignore */
    });
  };

  return (
    <div className={cn("relative rounded-basalt-widget border border-basalt-border/50 bg-basalt-secondary", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleCopy}
        aria-label="Copy JSON"
        className="absolute right-1 top-1 opacity-70 hover:opacity-100"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
      <pre
        className={cn(
          "font-mono text-[11px] leading-relaxed overflow-auto p-2 pr-8 m-0",
          maxHeightClass,
        )}
      >
        <code>
          {tokens.map((t, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens are a memoized linear stream, order is intrinsic
            <span key={idx} className={TOKEN_CLASSES[t.kind]}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
