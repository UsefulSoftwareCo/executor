// ---------------------------------------------------------------------------
// The artifact gallery's preview slot.
//
// An artifact is a live component, and there are no stored screenshots, so the
// grid needs something to show. The honest options were:
//
//   (a) mini-render each card's real component in the shell;
//   (b) derive a deterministic schematic from the artifact's identity;
//   (c) capture a screenshot when the artifact is saved.
//
// (a) is not available from here at any price: `@executor-js/mcp-apps-shell`
// depends on THIS package for its component barrel, so the shell can only be
// reached through the `ArtifactRendererProvider` loader seam that every app root
// registers — and `artifacts.list` deliberately omits `code`, which is the one
// thing a render needs. A grid of N previews would mean N extra `artifacts.get`
// round trips for the heavy column the summary exists to avoid, N loader seams,
// and 2N nested iframes. Rendering with a never-settling tool transport (the
// trick `smoke-render.ts` already uses) removes the metered executions but none
// of the rest.
//
// So this is (b): a schematic, not a screenshot. It is deliberately abstract —
// hairline geometry in the grayscale ramp, the same vocabulary as the marketing
// site's graph-paper and trace-waterfall illustrations — because a placeholder
// that imitated a real screenshot would be lying about what it knows. It reads
// as "an interface lives here", which is exactly what the list knows.
//
// Everything is derived from `artifactId`, so a given artifact always draws the
// same figure: the grid is stable across reloads and reorders, and the eye can
// use the shape as a weak landmark rather than re-reading every title.
//
// This component is the seam for (c). When artifacts carry a captured preview
// image, `ArtifactPreview` grows a `src` prop and renders the real thing here,
// falling back to the schematic while the capture is missing or still pending.
// Nothing else in the page has to change.
// ---------------------------------------------------------------------------

import { cn } from "../lib/utils";

/** FNV-1a over the id — a stable, well-mixed seed from an opaque string. */
const seedFrom = (value: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

/**
 * mulberry32 — a tiny deterministic PRNG.
 *
 * `Math.random` would reshuffle every card on every render; the schematic is
 * only useful as a landmark if it is a pure function of the artifact's id.
 */
const sequenceFrom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Pick a value in `[min, max)` from the sequence, rounded to whole units. */
const between = (next: () => number, min: number, max: number): number =>
  Math.round(min + next() * (max - min));

// The frame the schematics are drawn in. 16:10, matching the card's preview box.
const WIDTH = 320;
const HEIGHT = 200;

// Content inset. The chrome bar sits at the top; body layouts own everything
// below `BODY_TOP`.
const PAD = 20;
const BODY_TOP = 56;

/** Rounded blocks read as UI; every layout builds out of this one primitive. */
function Block(props: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly className?: string;
}) {
  return (
    <rect
      x={props.x}
      y={props.y}
      width={props.width}
      height={props.height}
      rx={2}
      className={cn("fill-muted-foreground/20", props.className)}
    />
  );
}

/**
 * The header every artifact has: a title bar and a couple of controls.
 *
 * Keeping it constant across layouts is what makes the four body figures read
 * as variations of one interface rather than four unrelated drawings.
 */
function Chrome(props: { readonly next: () => number }) {
  const titleWidth = between(props.next, 64, 120);
  return (
    <>
      <Block x={PAD} y={22} width={titleWidth} height={9} className="fill-muted-foreground/35" />
      <Block x={WIDTH - PAD - 44} y={23} width={20} height={7} />
      <Block x={WIDTH - PAD - 20} y={23} width={20} height={7} />
    </>
  );
}

/** A bar chart: the shape of a metrics artifact. */
function BarsFigure(props: { readonly next: () => number }) {
  const { next } = props;
  const count = between(next, 6, 9);
  const span = WIDTH - PAD * 2;
  const gap = 6;
  const barWidth = (span - gap * (count - 1)) / count;
  const floor = HEIGHT - PAD - 14;
  const maxHeight = floor - BODY_TOP - 4;

  return (
    <>
      {Array.from({ length: count }, (_, index) => {
        const height = between(next, Math.round(maxHeight * 0.25), maxHeight);
        return (
          <Block
            key={index}
            x={PAD + index * (barWidth + gap)}
            y={floor - height}
            width={barWidth}
            height={height}
            className={index % 3 === 0 ? "fill-muted-foreground/35" : undefined}
          />
        );
      })}
      <line
        x1={PAD}
        y1={floor + 5}
        x2={WIDTH - PAD}
        y2={floor + 5}
        className="stroke-border"
        strokeWidth={1}
      />
    </>
  );
}

/** A table: the shape of a list or report artifact. */
function RowsFigure(props: { readonly next: () => number }) {
  const { next } = props;
  const rows = between(next, 4, 6);
  const rowHeight = (HEIGHT - PAD - BODY_TOP) / rows;

  return (
    <>
      {Array.from({ length: rows }, (_, index) => {
        const y = BODY_TOP + index * rowHeight;
        const leadWidth = between(next, 70, 130);
        const tailWidth = between(next, 24, 44);
        return (
          <g key={index}>
            <Block
              x={PAD}
              y={y}
              width={leadWidth}
              height={8}
              className={index === 0 ? "fill-muted-foreground/35" : undefined}
            />
            <Block x={WIDTH - PAD - tailWidth} y={y} width={tailWidth} height={8} />
            {index < rows - 1 ? (
              <line
                x1={PAD}
                y1={y + rowHeight - 7}
                x2={WIDTH - PAD}
                y2={y + rowHeight - 7}
                className="stroke-border"
                strokeWidth={1}
              />
            ) : null}
          </g>
        );
      })}
    </>
  );
}

/** A tile grid: the shape of a stat or summary dashboard. */
function TilesFigure(props: { readonly next: () => number }) {
  const { next } = props;
  const columns = 2;
  const rows = 2;
  const gap = 12;
  const tileWidth = (WIDTH - PAD * 2 - gap * (columns - 1)) / columns;
  const tileHeight = (HEIGHT - PAD - BODY_TOP - gap * (rows - 1)) / rows;

  return (
    <>
      {Array.from({ length: columns * rows }, (_, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = PAD + column * (tileWidth + gap);
        const y = BODY_TOP + row * (tileHeight + gap);
        const valueWidth = between(next, 28, 54);
        return (
          <g key={index}>
            <rect
              x={x}
              y={y}
              width={tileWidth}
              height={tileHeight}
              rx={4}
              className="fill-transparent stroke-border"
              strokeWidth={1}
            />
            <Block x={x + 12} y={y + 14} width={between(next, 30, 46)} height={6} />
            <Block
              x={x + 12}
              y={y + 28}
              width={valueWidth}
              height={11}
              className="fill-muted-foreground/35"
            />
          </g>
        );
      })}
    </>
  );
}

/** A list beside a panel: the shape of a detail or explorer artifact. */
function SplitFigure(props: { readonly next: () => number }) {
  const { next } = props;
  const railWidth = 96;
  const panelX = PAD + railWidth + 14;
  const panelWidth = WIDTH - PAD - panelX;
  const panelHeight = HEIGHT - PAD - BODY_TOP;
  const points = Array.from({ length: 7 }, (_, index) => {
    const x = panelX + 12 + (index * (panelWidth - 24)) / 6;
    const y = BODY_TOP + panelHeight - 16 - between(next, 6, panelHeight - 40);
    return `${x},${y}`;
  }).join(" ");

  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <Block
          key={index}
          x={PAD}
          y={BODY_TOP + index * 22}
          width={between(next, 52, railWidth)}
          height={8}
          className={index === 0 ? "fill-muted-foreground/35" : undefined}
        />
      ))}
      <rect
        x={panelX}
        y={BODY_TOP}
        width={panelWidth}
        height={panelHeight}
        rx={4}
        className="fill-transparent stroke-border"
        strokeWidth={1}
      />
      <polyline
        points={points}
        className="fill-none stroke-muted-foreground/50"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </>
  );
}

const FIGURES = [BarsFigure, RowsFigure, TilesFigure, SplitFigure] as const;

/** The figure names, in the order `FIGURES` holds them. */
export const ARTIFACT_PREVIEW_FIGURES = ["bars", "rows", "tiles", "split"] as const;

export type ArtifactPreviewFigure = (typeof ARTIFACT_PREVIEW_FIGURES)[number];

/**
 * Which schematic an artifact draws.
 *
 * Exported so the choice is testable as a pure function: determinism is this
 * component's contract, not an implementation detail.
 */
export const artifactPreviewFigure = (artifactId: string): ArtifactPreviewFigure =>
  ARTIFACT_PREVIEW_FIGURES[seedFrom(artifactId) % ARTIFACT_PREVIEW_FIGURES.length] ?? "bars";

/**
 * A deterministic schematic standing in for the artifact's rendered output.
 *
 * Decorative by construction, so it is hidden from assistive technology and
 * from the accessibility tree the e2e locators read: the card's link already
 * carries the artifact's name.
 */
export function ArtifactPreview(props: {
  readonly artifactId: string;
  readonly className?: string;
}) {
  const seed = seedFrom(props.artifactId);
  const next = sequenceFrom(seed);
  const Figure = FIGURES[seed % FIGURES.length] ?? BarsFigure;
  // Unique per artifact: two schematics on one page must not share a pattern id.
  const gridId = `artifact-preview-grid-${seed.toString(36)}`;

  return (
    <svg
      data-slot="artifact-preview"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      className={cn("size-full", props.className)}
    >
      <defs>
        {/* The graph-paper field, at the same restraint as the marketing hero. */}
        <pattern id={gridId} width={16} height={16} patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" className="fill-none stroke-border" strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={WIDTH} height={HEIGHT} className="fill-transparent" />
      <rect width={WIDTH} height={HEIGHT} fill={`url(#${gridId})`} opacity={0.5} />
      <Chrome next={next} />
      <Figure next={next} />
    </svg>
  );
}
