"use client";

import { ThemeToggle, Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { LinkButton } from "@nocoo/basalt/components/button";
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
        <LinkButton
          variant="ghost"
          size="icon"
          href="https://github.com/nocoo/raven"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub repository"
        >
          <Github aria-hidden="true" strokeWidth={1.5} />
        </LinkButton>
      </HeaderTooltip>
      <HeaderTooltip label="Raven on hexly.ai">
        <LinkButton
          variant="ghost"
          size="icon"
          href="https://hexly.ai/projects/raven"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Raven on hexly.ai (opens in a new tab)"
        >
          <Hexly aria-hidden="true" strokeWidth={1.5} />
        </LinkButton>
      </HeaderTooltip>
      <ThemeToggle aria-label={`Toggle theme (now ${theme})`} />
    </>
  );
}
