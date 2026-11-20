import type { App } from "@executor-js/sdk";
import { roundedPath, type WorkflowLayout } from "@executor-js/workflow-graph/layout";
import { HugeiconsIcon } from "@hugeicons/react";
import { MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/button.tsx";
import { cn } from "../lib/utils.ts";
import { Box, Card } from "./workflow-diagram-cards.tsx";

/**
 * A laid-out workflow: boxes underneath, then the connecting lines and option labels, then the
 * cards. It fits the panel's width by default, down to a size that stays readable and scrolls
 * sideways past that; the zoom controls step from there.
 */

const ZOOM_STEP = 0.15;
const MIN_FIT = 0.75;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.5;

export function WorkflowCanvas({
  app,
  layout,
  input,
  selected,
  onSelect,
  onOpenWorkflow,
}: {
  readonly app: App;
  readonly layout: WorkflowLayout;
  readonly input: ReadonlyArray<string>;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly onOpenWorkflow: (name: string, step: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number>();
  const [zoom, setZoom] = useState<number>();
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = available ? Math.max(MIN_FIT, Math.min(1, available / layout.width)) : 1;
  const scale = zoom ?? fit;
  // Boxes and cards in reading order, so Tab follows the drawing; z-index keeps boxes underneath.
  const items = useMemo(
    () =>
      [
        ...layout.boxes.map((box) => ({ kind: "box" as const, box, x: box.x, y: box.y })),
        ...layout.cards.map((card) => ({ kind: "card" as const, card, x: card.x, y: card.y })),
      ].sort((a, b) => a.y - b.y || a.x - b.x),
    [layout],
  );
  return (
    <div className="relative min-w-0 bg-muted bg-[radial-gradient(circle_at_1px_1px,var(--border)_1px,transparent_0)] bg-size-[18px_18px]">
      <div ref={frame} className="max-h-[560px] overflow-auto px-4 py-7 [scrollbar-gutter:stable]">
        <div
          className="mx-auto"
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            className="relative origin-top-left"
            style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
          >
            <Edges layout={layout} />
            {layout.labels.map((label, index) => (
              <span
                // Labels have no identity of their own; their order is fixed for one layout.
                key={index}
                className={cn(
                  "pointer-events-none absolute z-[2] -translate-x-1/2 rounded-full border bg-background px-2 text-[11px] leading-[18px] whitespace-nowrap",
                  label.failure && "border-transparent bg-transparent font-medium text-destructive",
                )}
                style={{ left: label.x, top: label.y }}
              >
                {label.text}
              </span>
            ))}
            {items.map((item) =>
              item.kind === "box" ? (
                <Box
                  key={item.box.id}
                  box={item.box}
                  selected={selected === item.box.id}
                  onSelect={onSelect}
                />
              ) : (
                <Card
                  key={item.card.id}
                  app={app}
                  card={item.card}
                  input={input}
                  selected={selected === item.card.id}
                  onSelect={onSelect}
                  onOpenWorkflow={onOpenWorkflow}
                />
              ),
            )}
          </div>
        </div>
      </div>
      <div className="absolute bottom-3 left-3 flex overflow-hidden rounded-md border bg-background">
        <Button
          variant="ghost"
          size="xs"
          className="rounded-none"
          aria-pressed={zoom === undefined}
          onClick={() => setZoom(undefined)}
        >
          Fit
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-none border-l"
          aria-label="Zoom out"
          disabled={scale <= MIN_ZOOM}
          onClick={() => setZoom(Math.max(MIN_ZOOM, scale - ZOOM_STEP))}
        >
          <HugeiconsIcon icon={MinusSignIcon} strokeWidth={2} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-none border-l"
          aria-label="Zoom in"
          disabled={scale >= MAX_ZOOM}
          onClick={() => setZoom(Math.min(MAX_ZOOM, scale + ZOOM_STEP))}
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function Edges({ layout }: { readonly layout: WorkflowLayout }) {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[1] overflow-visible"
      width={layout.width}
      height={layout.height}
    >
      <defs>
        <marker
          id="workflow-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 .5L7.5 4 0 7.5z" className="fill-muted-foreground/80" />
        </marker>
        <marker
          id="workflow-arrow-failure"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 .5L7.5 4 0 7.5z" className="fill-destructive/70" />
        </marker>
      </defs>
      {layout.edges.map((edge, index) => (
        <path
          // An edge is identified by its ends and option; two can share both, so order breaks ties.
          key={`${edge.from}:${edge.to}:${edge.arm?.index}:${index}`}
          d={roundedPath(edge.points, 8)}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeDasharray={edge.failure ? "4 4" : undefined}
          className={edge.failure ? "stroke-destructive/70" : "stroke-muted-foreground/80"}
          markerEnd={
            edge.to === null
              ? undefined
              : edge.failure
                ? "url(#workflow-arrow-failure)"
                : "url(#workflow-arrow)"
          }
        />
      ))}
    </svg>
  );
}
