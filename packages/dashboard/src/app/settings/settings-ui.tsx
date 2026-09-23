"use client";

import { Button, Input, Label, LayerCard, Switch } from "@nocoo/basalt";
import { Loader2, Plus, Trash2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SectionIcon, type SectionIconTone } from "@/components/section-icon";

export function SettingsCard({
  title,
  icon,
  tone,
  action,
  children,
  footer,
}: {
  title: string;
  icon: LucideIcon;
  tone: SectionIconTone;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <LayerCard className="min-w-0">
      <LayerCard.Header className="items-center gap-3">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={icon} tone={tone} />{title}</h2>
        {action}
      </LayerCard.Header>
      <LayerCard.Body className="max-w-3xl space-y-4">{children}</LayerCard.Body>
      {footer ? <LayerCard.Footer>{footer}</LayerCard.Footer> : null}
    </LayerCard>
  );
}

export function SettingToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  saving = false,
  error,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  saving?: boolean;
  error?: string | null;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={id} className="cursor-pointer text-sm font-medium">
            {label}
          </Label>
          {description ? (
            <p className="mt-0.5 text-xs text-basalt-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saving ? <Loader2 className="h-3 w-3 animate-spin text-basalt-muted-foreground" /> : null}
          <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
        </div>
      </div>
      {error ? <p className="text-xs text-basalt-destructive">{error}</p> : null}
    </div>
  );
}

export function SettingNote({ children }: { children: ReactNode }) {
  return <div className="text-xs text-basalt-muted-foreground">{children}</div>;
}

export function SettingListItem({
  value,
  onRemove,
  disabled = false,
}: {
  value: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <LayerCard.Well className="flex items-center gap-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 text-basalt-muted-foreground hover:text-basalt-destructive"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${value}`}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </LayerCard.Well>
  );
}

export function SettingAddRow({
  value,
  onChange,
  onAdd,
  placeholder,
  disabled = false,
  saving = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  placeholder: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd();
          }
        }}
        placeholder={placeholder}
        className="h-8 flex-1 font-mono text-xs"
        disabled={disabled}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={onAdd}
        disabled={disabled || !value.trim()}
        className="h-8 px-3 text-xs"
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        <span className="ml-1.5">Add</span>
      </Button>
    </div>
  );
}
