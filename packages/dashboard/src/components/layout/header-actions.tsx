"use client";

import { Button, ThemeToggle, Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { useTheme } from "@nocoo/basalt/providers/theme";
import type { ReactElement } from "react";
import { Github } from "@/components/icons/github";
import { Hexly } from "@/components/icons/hexly";

function HeaderTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function HeaderActions() {
  const { theme } = useTheme();
  return (
    <>
      <HeaderTooltip label="GitHub repository">
        <Button variant="ghost" size="icon" asChild>
          <a
            href="https://github.com/nocoo/raven"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
          >
            <Github aria-hidden="true" strokeWidth={1.5} />
            <span className="sr-only">GitHub repository</span>
          </a>
        </Button>
      </HeaderTooltip>
      <HeaderTooltip label="Raven on hexly.ai">
        <Button variant="ghost" size="icon" asChild>
          <a
            href="https://hexly.ai/projects/raven"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Raven on hexly.ai (opens in a new tab)"
          >
            <Hexly aria-hidden="true" strokeWidth={1.5} />
            <span className="sr-only">Raven on hexly.ai</span>
          </a>
        </Button>
      </HeaderTooltip>
      <ThemeToggle aria-label={`Toggle theme (now ${theme})`} />
    </>
  );
}
