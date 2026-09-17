"use client";

import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { useTheme } from "@nocoo/basalt/providers/theme";
import { Monitor, Moon, Sun } from "lucide-react";
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
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const themeLabel = nextTheme === "system" ? "Use system theme" : `Switch to ${nextTheme} theme`;
  const ThemeIcon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;

  return (
    <>
      <HeaderTooltip label="GitHub repository">
        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <a
            href="https://github.com/nocoo/raven"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
          >
            <Github className="h-[18px] w-[18px]" aria-hidden="true" strokeWidth={1.5} />
          </a>
        </Button>
      </HeaderTooltip>
      <HeaderTooltip label="Raven on hexly.ai">
        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <a
            href="https://hexly.ai/projects/raven"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Raven on hexly.ai (opens in a new tab)"
          >
            <Hexly className="h-[18px] w-[18px]" aria-hidden="true" strokeWidth={1.5} />
          </a>
        </Button>
      </HeaderTooltip>
      <HeaderTooltip label={themeLabel}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setTheme(nextTheme)}
          aria-label={`Toggle theme (now ${theme})`}
        >
          <ThemeIcon className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} />
        </Button>
      </HeaderTooltip>
    </>
  );
}
