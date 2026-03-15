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
  "bg-badge-red",
  "bg-purple",
  "bg-purple/85",
  "bg-purple/70",
  "bg-info",
  "bg-info/85",
  "bg-primary",
  "bg-info/70",
  "bg-teal",
  "bg-teal/85",
  "bg-success",
  "bg-success/85",
  "bg-muted-foreground",
  "bg-warning",
  "bg-primary/85",
  "bg-destructive",
] as const;

export function getAvatarColor(name: string): string {
  const hash = hashString(name);
  const index = hash % AVATAR_COLORS.length;
  return AVATAR_COLORS[index] ?? AVATAR_COLORS[0];
}
