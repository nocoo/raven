"use client";
import { cn } from "@/lib/utils";
import { useLogStream, type LogLevel } from "@/hooks/use-log-stream";
import { LogsStats } from "./logs-stats";
import { LogItem } from "@/components/logs/log-item";
import { filterLogGroups } from "@/lib/log-entry";
import { useState, useRef, useLayoutEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Pause, Play, Trash2, Circle, Rocket, X } from "lucide-react";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { Button, Input, LayerCard } from "@nocoo/basalt";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nocoo/basalt/components/select";
const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function ConnectionIndicator({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Circle
        className={cn(
          "size-2 fill-current",
          connected ? "text-basalt-chart-5" : "text-basalt-destructive animate-pulse",
        )}
      />
      <span className="text-basalt-muted-foreground">
        {connected ? "Connected" : "Reconnecting..."}
      </span>
    </span>
  );
}

function LevelSelect({
  value,
  onChange,
}: {
  value: LogLevel;
  onChange: (level: LogLevel) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as LogLevel)}>
      <SelectTrigger size="sm" className="w-auto text-xs min-w-[90px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEVELS.map((l) => (
          <SelectItem key={l} value={l}>
            {l.charAt(0).toUpperCase() + l.slice(1)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface LogsContentProps {
  onClose?: () => void;
  requestIdFilter?: string | undefined;
  onClearRequestIdFilter?: () => void;
}

export function LogsContent({
  onClose,
  requestIdFilter: explicitRequestIdFilter,
  onClearRequestIdFilter,
}: LogsContentProps = {}) {
  const searchParams = useSearchParams();
  const requestIdFilter = explicitRequestIdFilter ?? searchParams?.get("requestId") ?? undefined;
  const [level, setLevel] = useState<LogLevel>("info");
  const [search, setSearch] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  // "pinned to top" means user is at scrollTop ≈ 0 and wants to see newest
  const pinnedRef = useRef(true);
  // DOM anchor captured on the SSE event boundary — a stable
  // group-key + its distance below scrollTop. Not in render body:
  // React render must be pure and can be aborted under concurrent
  // rendering. Snapshotting on the event boundary (see the
  // onBeforeAppend callback below) runs exactly once per event, in
  // browser event-handler context, with the previous commit's DOM
  // still on screen.
  const anchorRef = useRef<{ key: string; distance: number } | null>(null);

  // Stable snapshot closure — reads DOM refs at call time; safe to
  // pass to useLogStream without retriggering the SSE connection.
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      anchorRef.current = null;
      return;
    }
    if (pinnedRef.current) {
      anchorRef.current = null;
      return;
    }
    const containerTop = el.getBoundingClientRect().top;
    const nodes = el.querySelectorAll<HTMLElement>("[data-group-key]");
    // First group whose bottom sits below the viewport top — that's
    // the one the user sees at the top edge.
    for (const node of Array.from(nodes)) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        anchorRef.current = {
          key: node.dataset.groupKey ?? "",
          distance: rect.top - containerTop,
        };
        return;
      }
    }
    anchorRef.current = null;
  }, []);

  const { events, eventSeq, connected, paused, setPaused, clear, setLevel: setStreamLevel } = useLogStream({
    level,
    onBeforeAppend: captureAnchor,
    ...(requestIdFilter ? { requestId: requestIdFilter } : {}),
  });

  const handleLevelChange = useCallback(
    (newLevel: LogLevel) => {
      setLevel(newLevel);
      setStreamLevel(newLevel);
    },
    [setStreamLevel],
  );

  // Apply anchor after commit, before browser paints. useLayoutEffect
  // runs synchronously after DOM update, before the browser paints,
  // so scroll adjustment lands in the same frame — no flicker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: eventSeq is the intentional trigger; effect closure reads only refs/DOM
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      el.scrollTop = 0;
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor?.key) return;
    const node = el.querySelector<HTMLElement>(
      `[data-group-key="${CSS.escape(anchor.key)}"]`,
    );
    if (!node) {
      // Anchor group was evicted from the ring buffer. The user's frame
      // of reference is gone; least-jarring recovery is to leave scrollTop
      // alone so the surrounding content position drifts naturally with
      // the layout shift, rather than snapping to top or bottom.
      return;
    }
    const containerTop = el.getBoundingClientRect().top;
    const nodeTop = node.getBoundingClientRect().top - containerTop;
    const delta = nodeTop - anchor.distance;
    if (delta !== 0) {
      el.scrollTop += delta;
    }
  }, [eventSeq]);

  // Track whether user is pinned to top
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    pinnedRef.current = scrollRef.current.scrollTop < 30;
  }, []);

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    pinnedRef.current = true;
  }, []);

  const groups = filterLogGroups(events, search);
  const filteredCount = groups.reduce((count, group) => count + group.events.length, 0);

  // Show FAB when not pinned
  const [showFab, setShowFab] = useState(false);
  const handleScrollForFab = useCallback(() => {
    if (!scrollRef.current) return;
    setShowFab(scrollRef.current.scrollTop >= 100);
  }, []);

  const onScroll = useCallback(() => {
    handleScroll();
    handleScrollForFab();
  }, [handleScroll, handleScrollForFab]);

  return (
    <div className="@container/logs flex h-full min-h-0 flex-col gap-3">
      <PageHeader
        title="Logs"
        description={
          <span className="inline-flex items-center gap-2">
            Live proxy event stream.
            <ConnectionIndicator connected={connected} />
          </span>
        }
        actions={
          <>
            <Input
              placeholder="Search IP, key, model…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-28 text-xs md:w-48"
            />
            <LevelSelect value={level} onChange={handleLevelChange} />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setPaused(!paused)}
              title={paused ? "Resume" : "Pause"}
            >
              {paused ? (
                <>
                  <Play className="size-3" />
                  <span className="hidden sm:inline">Resume</span>
                </>
              ) : (
                <>
                  <Pause className="size-3" />
                  <span className="hidden sm:inline">Pause</span>
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={clear}
              title="Clear"
            >
              <Trash2 className="size-3" />
              <span className="hidden sm:inline">Clear</span>
            </Button>
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onClose}
                aria-label="Close logs dock"
              >
                <X className="size-4" />
              </Button>
            )}
          </>
        }
      />

      {/* Pause & filter banner */}
      {(paused || requestIdFilter) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {paused && (
            <div className="flex shrink-0 items-center gap-2 rounded-md bg-basalt-warning/10 px-3 py-1.5 text-xs text-basalt-warning">
              <Pause className="size-3" />
              Paused — new events are being buffered
            </div>
          )}
          {requestIdFilter && (
            <div className="flex shrink-0 items-center gap-2 rounded-md bg-basalt-info/10 px-3 py-1.5 text-xs text-basalt-info">
              <span>Filtered by request: <code className="font-mono">{requestIdFilter}</code></span>
              {onClearRequestIdFilter && (
                <Button
                  variant="ghost" size="sm"
                  onClick={onClearRequestIdFilter}
                  className="hover:underline ml-1 font-medium"
                >
                  Clear filter
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 flex flex-col @min-[42rem]/logs:flex-row gap-3">
        <section aria-label="Log events" className="relative min-h-0 min-w-0 flex-1 flex flex-col">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto"
          >
            {groups.length === 0 ? (
              <LayerCard padding="none">
                <LayerCard.Empty
                  title={connected ? "Waiting for log events..." : "Connecting to log stream..."}
                />
              </LayerCard>
            ) : (
              <div className="space-y-1 pb-2">
                {groups.map((group) => (
                  <div key={group.key} data-group-key={group.key}>
                    <LogItem events={group.events} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* FAB — scroll to top (newest) */}
          {showFab && (
            <Button
              variant="default" size="icon"
              onClick={scrollToTop}
              className="absolute bottom-4 right-4 flex items-center justify-center size-10 rounded-full bg-basalt-primary text-basalt-primary-foreground shadow-lg hover:bg-basalt-primary/90 transition-all hover:scale-105 active:scale-95"
              title="Back to latest"
            >
              <Rocket className="size-4" />
            </Button>
          )}

          {/* Footer status */}
          <div className="flex shrink-0 items-center justify-between pt-2 text-meta">
            <span>
              {filteredCount} events
              {search && ` (filtered from ${events.length})`}
            </span>
            <span>{relativeTime(events[events.length - 1]?.ts ?? Date.now())}</span>
          </div>
        </section>
        <LogsStats events={events} />
      </div>
    </div>
  );
}
