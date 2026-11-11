"use client";

import { ProjectLinks } from "@nocoo/basalt/components/app-header";
import { ThemeToggle } from "@nocoo/basalt/components/theme-toggle";

export function HeaderActions() {
  return (
    <>
      <ProjectLinks github="nocoo/raven" hexly="raven" name="Raven" />
      <ThemeToggle />
    </>
  );
}
