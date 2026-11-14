import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDuration, serviceColor, statusColor } from "../format.ts";
import type { TraceSpanItem } from "../../contracts/api.ts";

interface WaterfallProps {
  spans: ReadonlyArray<TraceSpanItem>;
  traceStartMs: number;
  traceDurationMs: number;
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string | null) => void;
  logs: ReadonlyArray<{ spanId: string | null }>;
  /** False while the trace has log pages that are not loaded, so counts are lower bounds. */
  logsComplete: boolean;
}

const ROW_HEIGHT = 26;
const LABEL_WIDTH = 440;
const AXIS_HEIGHT = 26;
const TICK_COUNT = 5;
const INDENT = 16;
const MIN_BAR_WIDTH_PX = 3;
const MIN_VIEW_SPAN = 0.0001; // max zoom: 10000x

function formatAxisTime(ms: number, totalMs: number): string {
  if (totalMs >= 60_000) {
    const s = ms / 1000;
    if (s >= 60) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${s.toFixed(1)}s`;
  }
  if (totalMs >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (totalMs >= 10) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(2)}ms`;
}

type View = { start: number; end: number };

export function Waterfall({
  spans,
  traceStartMs,
  traceDurationMs,
  selectedSpanId,
  onSelectSpan,
  logs,
  logsComplete,
}: WaterfallProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // View window in fractional units of total trace duration: [0..1]
  const [view, setView] = useState<View>({ start: 0, end: 1 });
  const isZoomed = view.start > 0.0005 || view.end < 0.9995;

  // Reset view when the trace changes
  useEffect(() => {
    setView({ start: 0, end: 1 });
  }, [spans]);

  const logCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of logs) {
      if (log.spanId) counts.set(log.spanId, (counts.get(log.spanId) ?? 0) + 1);
    }
    return counts;
  }, [logs]);

  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of spans) {
      if (s.parentSpanId) counts.set(s.parentSpanId, (counts.get(s.parentSpanId) ?? 0) + 1);
    }
    return counts;
  }, [spans]);

  // Descendant counts including self (recursive count) for collapse tooltips
  const descendantCounts = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const s of spans) {
      if (s.parentSpanId) {
        const arr = kids.get(s.parentSpanId) ?? [];
        arr.push(s.spanId);
        kids.set(s.parentSpanId, arr);
      }
    }
    const out = new Map<string, number>();
    const count = (id: string): number => {
      const cached = out.get(id);
      if (cached !== undefined) return cached;
      let total = 0;
      for (const child of kids.get(id) ?? []) total += 1 + count(child);
      out.set(id, total);
      return total;
    };
    for (const s of spans) count(s.spanId);
    return out;
  }, [spans]);

  // Collapsed span ids: their descendants are hidden
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Reset collapse state when the trace changes
  useEffect(() => {
    setCollapsed(new Set());
  }, [spans]);

  const toggleCollapse = useCallback((spanId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }, []);

  // Visible spans: filter out descendants of any collapsed ancestor
  const visibleSpans = useMemo(() => {
    if (collapsed.size === 0) return spans;
    // Build parent map for efficient ancestry walks
    const parentMap = new Map<string, string | null>();
    for (const s of spans) parentMap.set(s.spanId, s.parentSpanId ?? null);
    const hiddenCache = new Map<string, boolean>();
    const isHidden = (id: string | null): boolean => {
      if (!id) return false;
      const cached = hiddenCache.get(id);
      if (cached !== undefined) return cached;
      let cur: string | null = id;
      while (cur) {
        const parent: string | null = parentMap.get(cur) ?? null;
        if (parent && collapsed.has(parent)) {
          hiddenCache.set(id, true);
          return true;
        }
        cur = parent;
      }
      hiddenCache.set(id, false);
      return false;
    };
    return spans.filter((s) => !isHidden(s.spanId));
  }, [spans, collapsed]);

  // oxlint-disable-next-line react/incompatible-library -- this build does not run the React Compiler
  const virtualizer = useVirtualizer({
    count: visibleSpans.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });

  useEffect(() => {
    if (!selectedSpanId) return;
    const idx = visibleSpans.findIndex((s) => s.spanId === selectedSpanId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedSpanId, visibleSpans, virtualizer]);

  /** Zoom at a fractional anchor (0..1 within the current view) by a factor (<1 zooms in, >1 zooms out) */
  const zoomAt = useCallback((anchorInView: number, factor: number) => {
    setView((v) => {
      const span = v.end - v.start;
      const anchorAbs = v.start + anchorInView * span;
      let newSpan = Math.max(MIN_VIEW_SPAN, Math.min(1, span * factor));
      let newStart = anchorAbs - anchorInView * newSpan;
      let newEnd = newStart + newSpan;
      if (newStart < 0) {
        newStart = 0;
        newEnd = newSpan;
      }
      if (newEnd > 1) {
        newEnd = 1;
        newStart = 1 - newSpan;
      }
      return { start: newStart, end: newEnd };
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Zoom keyboard controls
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomAt(0.5, 1 / 1.5);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        zoomAt(0.5, 1.5);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setView({ start: 0, end: 1 });
        return;
      }

      if (!visibleSpans.length) return;
      const idx = selectedSpanId ? visibleSpans.findIndex((s) => s.spanId === selectedSpanId) : -1;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        onSelectSpan(visibleSpans[Math.min(idx + 1, visibleSpans.length - 1)]!.spanId);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        onSelectSpan(visibleSpans[Math.max(idx - 1, 0)]!.spanId);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onSelectSpan(null);
      }
    },
    [visibleSpans, selectedSpanId, onSelectSpan, zoomAt],
  );

  const panBy = useCallback((deltaFraction: number) => {
    setView((v) => {
      const span = v.end - v.start;
      let newStart = v.start + deltaFraction;
      if (newStart < 0) newStart = 0;
      if (newStart + span > 1) newStart = 1 - span;
      return { start: newStart, end: newStart + span };
    });
  }, []);

  // Wheel: zoom with meta/ctrl/alt or pinch, pan on horizontal scroll
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect) return;
      const barColumnLeft = rect.left + LABEL_WIDTH;
      const barColumnWidth = rect.width - LABEL_WIDTH;
      if (barColumnWidth <= 0) return;
      // Horizontal scroll → pan
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const span = view.end - view.start;
        panBy((e.deltaX / barColumnWidth) * span);
        return;
      }
      // Zoom: ctrlKey is set by browsers for trackpad pinch; meta/alt as explicit modifiers
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        const anchor = (e.clientX - barColumnLeft) / barColumnWidth;
        const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        zoomAt(Math.max(0, Math.min(1, anchor)), factor);
      }
      // Plain vertical scroll falls through to scroll the row list
    },
    [view, panBy, zoomAt],
  );

  // Drag to pan on empty timeline area (middle-click or click in gaps)
  const dragStart = useRef<{ x: number; viewStart: number; moved: boolean } | null>(null);
  const handleTimelineMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    dragStart.current = { x: e.clientX, viewStart: view.start, moved: false };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragStart.current || !timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const barWidth = rect.width - LABEL_WIDTH;
      if (barWidth <= 0) return;
      const span = view.end - view.start;
      const dx = e.clientX - dragStart.current.x;
      if (Math.abs(dx) > 2) dragStart.current.moved = true;
      const deltaFraction = -(dx / barWidth) * span;
      setView((v) => {
        const currentSpan = v.end - v.start;
        let newStart = dragStart.current!.viewStart + deltaFraction;
        if (newStart < 0) newStart = 0;
        if (newStart + currentSpan > 1) newStart = 1 - currentSpan;
        return { start: newStart, end: newStart + currentSpan };
      });
    };
    const onUp = () => {
      dragStart.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [view]);

  if (!spans.length) {
    return (
      <div className="flex items-center justify-center p-16 text-zinc-500 flex-1">
        <p className="text-sm">No spans</p>
      </div>
    );
  }

  const dur = Math.max(traceDurationMs, 1);
  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const viewSpan = view.end - view.start;

  // Ticks in view coordinates (positioned at 0%..100% within the timeline column)
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
    const t = i / TICK_COUNT;
    const absFraction = view.start + t * viewSpan;
    return { pct: t * 100, ms: absFraction * dur };
  });

  /** Convert absolute trace-fraction to visible percent within the timeline column */
  const toViewPct = (absFraction: number) => ((absFraction - view.start) / viewSpan) * 100;

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-auto min-w-0 outline-none"
      tabIndex={0}
      role="application"
      aria-label="Trace waterfall (use arrow keys to navigate spans)"
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
    >
      {/* Time axis — sticky; also acts as drag-to-pan handle */}
      <div
        ref={timelineRef}
        className="sticky top-0 z-20 flex bg-zinc-950 border-b border-white/10 select-none"
        style={{ height: AXIS_HEIGHT, cursor: isZoomed ? "grab" : "default" }}
        role="presentation"
        onMouseDown={handleTimelineMouseDown}
      >
        <div
          className="shrink-0 border-r border-white/10 flex items-center justify-between px-2 text-sm text-zinc-600"
          style={{ width: LABEL_WIDTH }}
        >
          <span className="tabular-nums">{isZoomed && `${(1 / viewSpan).toFixed(1)}×`}</span>
          {isZoomed && (
            <button
              className="text-sm text-zinc-500 hover:text-zinc-200 cursor-pointer bg-transparent border-none px-1.5 py-0.5 rounded"
              onClick={() => setView({ start: 0, end: 1 })}
              title="Reset zoom (0)"
            >
              Reset
            </button>
          )}
        </div>
        <div className="flex-1 relative">
          {ticks.map((t, i) => {
            const last = i === ticks.length - 1;
            return (
              <div key={t.ms} className="absolute top-0 bottom-0" style={{ left: `${t.pct}%` }}>
                <div className="absolute top-0 bottom-0 border-l border-white/5" />
                <span
                  className="absolute bottom-1 text-sm tabular-nums text-zinc-600 whitespace-nowrap"
                  style={
                    i === 0
                      ? { left: 6 }
                      : last
                        ? { right: 6, left: "auto" }
                        : { left: "50%", transform: "translateX(-50%)" }
                  }
                >
                  {formatAxisTime(t.ms, dur)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Rows */}
      <div className="relative w-full" style={{ height: totalHeight }}>
        {/* Full-height gridlines aligned with view ticks */}
        <div
          className="absolute pointer-events-none"
          style={{ left: LABEL_WIDTH, right: 0, top: 0, bottom: 0 }}
        >
          {ticks.slice(1, -1).map((t) => (
            <div
              key={t.ms}
              className="absolute top-0 bottom-0 border-l border-white/5"
              style={{ left: `${t.pct}%` }}
            />
          ))}
        </div>

        {items.map((virtual) => {
          const span = visibleSpans[virtual.index]!;
          const spanStartFrac = (span.startTime.getTime() - traceStartMs) / dur;
          const spanEndFrac = spanStartFrac + span.durationMs / dur;

          // Clip to visible window
          const isVisible = spanEndFrac > view.start && spanStartFrac < view.end;
          const barLeftPct = Math.max(0, toViewPct(Math.max(spanStartFrac, view.start)));
          const barRightPct = Math.min(100, toViewPct(Math.min(spanEndFrac, view.end)));
          const barWPct = Math.max(0, barRightPct - barLeftPct);
          const clippedLeft = spanStartFrac < view.start;
          const clippedRight = spanEndFrac > view.end;

          const sel = span.spanId === selectedSpanId;
          const lc = logCounts.get(span.spanId) ?? 0;
          const cc = childCounts.get(span.spanId) ?? 0;
          const dc = descendantCounts.get(span.spanId) ?? 0;
          const isCollapsed = collapsed.has(span.spanId);
          const sc = serviceColor(span.serviceName);
          const isErr = span.status === "error";
          const barColor = isErr ? statusColor("error") : sc;
          const showDuration = span.durationMs >= 1 && isVisible;
          const labelIndent = 8 + span.depth * INDENT;

          return (
            // Keyboard activation lives on the parent scroll container
            // (role="application" with arrow/j/k handlers); rows are
            // just visual mouse targets. A per-row onKeyDown would be
            // unreachable because tabIndex isn't set and the parent
            // owns focus.
            // react-doctor-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={span.spanId}
              className={`absolute left-0 right-0 flex items-stretch cursor-pointer border-b border-white/[0.03] ${
                sel ? "bg-accent/10" : "hover:bg-white/[0.03]"
              }`}
              style={{ top: virtual.start, height: ROW_HEIGHT }}
              role="row"
              onClick={() => onSelectSpan(span.spanId)}
            >
              {/* Label column */}
              <div
                className="shrink-0 flex items-center gap-1.5 overflow-hidden border-r border-white/5 pr-2 relative"
                style={{ width: LABEL_WIDTH, paddingLeft: labelIndent }}
              >
                {Array.from({ length: span.depth }, (_, i) => (
                  <div
                    key={`${span.spanId}-depth-${i}`}
                    className="absolute top-0 bottom-0 border-l border-white/5 pointer-events-none"
                    style={{ left: 8 + i * INDENT + 5 }}
                  />
                ))}
                {span.depth > 0 && (
                  <div
                    className="absolute pointer-events-none border-white/10"
                    style={{
                      left: 8 + (span.depth - 1) * INDENT + 5,
                      top: 0,
                      width: INDENT - 5,
                      height: ROW_HEIGHT / 2,
                      borderBottom: "1px solid",
                      borderLeft: "1px solid",
                    }}
                  />
                )}

                {cc > 0 ? (
                  <button
                    type="button"
                    className="shrink-0 text-sm tabular-nums rounded px-1 border border-white/10 text-zinc-400 bg-zinc-900 relative z-10 leading-none py-0.5 cursor-pointer hover:text-zinc-200 hover:border-white/20 flex items-center gap-0.5"
                    title={`${isCollapsed ? "Expand" : "Collapse"} ${dc} descendant${dc === 1 ? "" : "s"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(span.spanId);
                    }}
                  >
                    <span>{isCollapsed ? dc : cc}</span>
                    <span className="text-zinc-500" aria-hidden>
                      {isCollapsed ? "›" : "⌄"}
                    </span>
                  </button>
                ) : (
                  <span
                    className="shrink-0 size-1.5 rounded-full relative z-10"
                    style={{ backgroundColor: barColor }}
                  />
                )}

                <p
                  className={`whitespace-nowrap overflow-hidden text-ellipsis text-sm min-w-0 relative z-10 ${
                    sel ? "text-zinc-50 font-medium" : "text-zinc-200"
                  }`}
                  title={span.operationName}
                >
                  {span.operationName}
                </p>

                {(() => {
                  const parent = span.parentSpanId
                    ? spans.find((s) => s.spanId === span.parentSpanId)
                    : null;
                  const differsFromParent = !parent || parent.serviceName !== span.serviceName;
                  return differsFromParent && span.depth > 0 ? (
                    <span
                      className="text-sm text-zinc-600 shrink-0 truncate max-w-28 relative z-10"
                      title={span.serviceName}
                    >
                      {span.serviceName}
                    </span>
                  ) : null;
                })()}

                <div className="ml-auto shrink-0 flex items-center gap-1.5 relative z-10">
                  {isErr && <span className="text-sm text-red-400 font-medium">!</span>}
                  {lc > 0 && (
                    <span
                      className="text-sm text-zinc-600 tabular-nums"
                      title={
                        logsComplete
                          ? `${lc} log${lc === 1 ? "" : "s"}`
                          : `${lc} log${lc === 1 ? "" : "s"} loaded so far; this trace has more logs`
                      }
                    >
                      {lc}
                      {logsComplete ? "" : "+"}L
                    </span>
                  )}
                </div>
              </div>

              {/* Bar column — rendered only if span intersects the view */}
              <div className="flex-1 relative">
                {isVisible && (
                  <>
                    <div
                      data-span-bar="true"
                      className={`absolute top-1/2 -translate-y-1/2 h-3 rounded-sm ${span.isRunning ? "animate-bar-pulse" : ""}`}
                      style={{
                        left: `${barLeftPct}%`,
                        width: `${barWPct}%`,
                        minWidth: MIN_BAR_WIDTH_PX,
                        backgroundColor: barColor,
                        opacity: sel ? 1 : 0.85,
                        borderTopLeftRadius: clippedLeft ? 0 : undefined,
                        borderBottomLeftRadius: clippedLeft ? 0 : undefined,
                        borderTopRightRadius: clippedRight ? 0 : undefined,
                        borderBottomRightRadius: clippedRight ? 0 : undefined,
                      }}
                    />
                    {showDuration &&
                      (() => {
                        // Placement strategy:
                        // - If bar is wide enough, render the label INSIDE the bar, right-aligned, white.
                        // - Else if the bar is in the right portion of the screen, render LEFT of the bar.
                        // - Otherwise, render RIGHT of the bar.
                        const barRightPct = barLeftPct + barWPct;
                        const insideBar = barWPct >= 12;
                        const placeLeft = !insideBar && barRightPct > 70;
                        const label = formatDuration(span.durationMs);
                        if (insideBar) {
                          return (
                            <span
                              className="absolute top-1/2 -translate-y-1/2 text-sm tabular-nums text-white/90 whitespace-nowrap pointer-events-none pr-1.5 text-right"
                              style={{ left: `${barLeftPct}%`, width: `${barWPct}%` }}
                            >
                              {label}
                            </span>
                          );
                        }
                        if (placeLeft) {
                          return (
                            <span
                              className="absolute top-1/2 -translate-y-1/2 text-sm tabular-nums text-zinc-500 whitespace-nowrap pointer-events-none pr-1.5 text-right"
                              style={{ right: `${100 - barLeftPct}%` }}
                            >
                              {label}
                            </span>
                          );
                        }
                        return (
                          <span
                            className="absolute top-1/2 -translate-y-1/2 text-sm tabular-nums text-zinc-500 whitespace-nowrap pointer-events-none pl-1.5"
                            style={{ left: `${barRightPct}%` }}
                          >
                            {label}
                          </span>
                        );
                      })()}
                  </>
                )}
                {/* Off-screen indicator arrows */}
                {!isVisible && spanEndFrac <= view.start && (
                  <span className="absolute top-1/2 -translate-y-1/2 left-1 text-sm text-zinc-700">
                    ‹
                  </span>
                )}
                {!isVisible && spanStartFrac >= view.end && (
                  <span className="absolute top-1/2 -translate-y-1/2 right-1 text-sm text-zinc-700">
                    ›
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
