import type { LucideIcon } from "lucide-react";

const tones = {
  blue: "bg-basalt-info/10 text-basalt-info",
  purple: "bg-basalt-badge-purple/10 text-basalt-badge-purple",
  teal: "bg-basalt-badge-teal/10 text-basalt-badge-teal",
  orange: "bg-basalt-warning/10 text-basalt-warning",
};

export type SectionIconTone = keyof typeof tones;

export function SectionIcon({ icon: Icon, tone }: { icon: LucideIcon; tone: SectionIconTone }) {
  return (
    <span aria-hidden="true" className={`inline-flex size-7 shrink-0 items-center justify-center rounded-widget ${tones[tone]}`}>
      <Icon className="size-4" strokeWidth={1.5} />
    </span>
  );
}
