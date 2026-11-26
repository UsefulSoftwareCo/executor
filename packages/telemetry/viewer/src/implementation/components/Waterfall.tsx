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
  logsComplete: boolean;
  partial: boolean;
}

const ROW_HEIGHT = 26;
const LABEL_WIDTH = 440;
const AXIS_HEIGHT = 26;
const TICK_COUNT = 5;
const INDENT = 16;
const MIN_BAR_WIDTH_PX = 3;
const MIN_VIEW_SPAN = 0.0001;
const DEPTH_GUIDE =
  "linear-gradient(to right, transparent 5px, rgb(255 255 255 / 0.05) 5px, rgb(255 255 255 / 0.05) 6px, transparent 6px)";

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
  partial,
}: WaterfallProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View>({ start: 0, end: 1 });
  const isZoomed = view.start > 0.0005 || view.end < 0.9995;

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

  const spansById = useMemo(() => new Map(spans.map((s) => [s.spanId, s])), [spans]);

  const links = useMemo(() => {
    const count = spans.length;
    const first = new Map<string, number>();
    const same = new Int32Array(count).fill(-1);
    const last = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const s = spans[i]!;
      const at = first.get(s.spanId);
      if (at === undefined) {
        first.set(s.spanId, i);
        last[i] = i;
      } else {
        same[last[at]!] = i;
        last[at] = i;
      }
    }
    const parent = new Int32Array(count).fill(-1);
    for (let i = 0; i < count; i++) {
      const s = spans[i]!;
      if (s.parentSpanId) parent[i] = first.get(s.parentSpanId) ?? -1;
    }
    return { first, same, parent };
  }, [spans]);

  const { childCounts, descendantCounts } = useMemo(() => {
    const { first, same, parent } = links;
    const counts = new Map<string, number>();
    const waiting = new Int32Array(spans.length);
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]!;
      if (s.parentSpanId) counts.set(s.parentSpanId, (counts.get(s.parentSpanId) ?? 0) + 1);
      const up = parent[i]!;
      if (up !== -1) waiting[up]!++;
    }
    const totals = new Float64Array(spans.length);
    const ready: number[] = [];
    for (const at of first.values()) if (waiting[at] === 0) ready.push(at);
    for (let at = ready.pop(); at !== undefined; at = ready.pop()) {
      for (let i = at; i !== -1; i = same[i]!) {
        const up = parent[i]!;
        if (up === -1) continue;
        totals[up] = totals[up]! + 1 + totals[at]!;
        if (--waiting[up]! === 0) ready.push(up);
      }
    }
    const descendants = new Map<string, number>();
    for (const [id, at] of first) descendants.set(id, totals[at]!);
    return { childCounts: counts, descendantCounts: descendants };
  }, [spans, links]);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

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

  const visibleSpans = useMemo(() => {
    if (collapsed.size === 0) return spans;
    const { first, parent } = links;
    const state = new Uint8Array(spans.length);
    for (const id of collapsed) {
      const at = first.get(id);
      if (at !== undefined) state[at] = 1;
    }
    const path: number[] = [];
    const covered = (start: number) => {
      let answer = 2;
      for (let at = start; at !== -1; at = parent[at]!) {
        if (state[at] !== 0) {
          answer = state[at] === 1 ? 1 : 2;
          break;
        }
        state[at] = 3;
        path.push(at);
      }
      for (const at of path) state[at] = answer;
      path.length = 0;
      return answer === 1;
    };
    return spans.filter((s, i) => {
      if (!s.parentSpanId) return true;
      const up = parent[i]!;
      return up === -1 ? !collapsed.has(s.parentSpanId) : !covered(up);
    });
  }, [spans, links, collapsed]);

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

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect) return;
      const barColumnLeft = rect.left + LABEL_WIDTH;
      const barColumnWidth = rect.width - LABEL_WIDTH;
      if (barColumnWidth <= 0) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const span = view.end - view.start;
        panBy((e.deltaX / barColumnWidth) * span);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        const anchor = (e.clientX - barColumnLeft) / barColumnWidth;
        const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        zoomAt(Math.max(0, Math.min(1, anchor)), factor);
      }
    },
    [view, panBy, zoomAt],
  );

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

  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
    const t = i / TICK_COUNT;
    const absFraction = view.start + t * viewSpan;
    return { pct: t * 100, ms: absFraction * dur };
  });

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

      <div className="relative w-full" style={{ height: totalHeight }}>
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
            <div
              key={span.spanId}
              className={`absolute left-0 right-0 flex items-stretch cursor-pointer border-b border-white/[0.03] ${
                sel ? "bg-accent/10" : "hover:bg-white/[0.03]"
              }`}
              style={{ top: virtual.start, height: ROW_HEIGHT }}
              role="row"
              onClick={() => onSelectSpan(span.spanId)}
            >
              <div
                className="shrink-0 flex items-center gap-1.5 overflow-hidden border-r border-white/5 pr-2 relative"
                style={{ width: LABEL_WIDTH, paddingLeft: labelIndent }}
              >
                {span.depth > 0 && (
                  <div
                    className="absolute top-0 bottom-0 pointer-events-none"
                    style={{
                      left: 8,
                      width: span.depth * INDENT,
                      backgroundImage: DEPTH_GUIDE,
                      backgroundSize: `${INDENT}px 100%`,
                      backgroundRepeat: "repeat-x",
                    }}
                  />
                )}
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
                    title={`${isCollapsed ? "Expand" : "Collapse"} ${dc} descendant${dc === 1 ? "" : "s"}${partial ? " shown" : ""}`}
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
                  const parent = span.parentSpanId ? spansById.get(span.parentSpanId) : null;
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
