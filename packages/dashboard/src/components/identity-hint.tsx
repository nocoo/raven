"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import type { ReactElement, ReactNode } from "react";

export function IdentityHint({ identity, children, details }: { identity: string; children: ReactElement; details?: ReactNode }) {
  return <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="bottom" align="start" className="max-w-xs space-y-1 text-xs">
      <p className="break-all font-mono">{identity}</p>
      {details}
    </TooltipContent>
  </Tooltip>;
}
