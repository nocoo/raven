"use client";

import {
  LinkProvider,
  ThemeProvider,
  Toaster,
  TooltipProvider,
} from "@nocoo/basalt";
import Link from "next/link";
import type { ReactNode } from "react";
import { AuthProvider } from "@/components/auth-provider";

function AppLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children?: ReactNode;
}) {
  if (/^(https?:|mailto:|tel:)/.test(href)) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <LinkProvider render={AppLink}>
        <TooltipProvider>
          <AuthProvider>
            <Toaster />
            {children}
          </AuthProvider>
        </TooltipProvider>
      </LinkProvider>
    </ThemeProvider>
  );
}
