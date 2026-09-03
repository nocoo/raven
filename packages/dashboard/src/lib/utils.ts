import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

const AVATAR_COLORS = [
  "bg-basalt-danger",
  "bg-basalt-chart-14",
  "bg-basalt-chart-14/85",
  "bg-basalt-chart-14/70",
  "bg-basalt-info",
  "bg-basalt-info/85",
  "bg-basalt-primary",
  "bg-basalt-info/70",
  "bg-basalt-chart-3",
  "bg-basalt-chart-3/85",
  "bg-basalt-chart-5",
  "bg-basalt-chart-5/85",
  "bg-basalt-muted-foreground",
  "bg-basalt-warning",
  "bg-basalt-primary/85",
  "bg-basalt-destructive",
] as const;

export function getAvatarColor(name: string): string {
  const hash = hashString(name);
  const index = hash % AVATAR_COLORS.length;
  return AVATAR_COLORS[index] ?? AVATAR_COLORS[0];
}
