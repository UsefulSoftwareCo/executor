// ---------------------------------------------------------------------------
// The artifact gallery's preview slot.
//
// An artifact is a live component, so the grid needs something to show for it.
// Three things can be shown, and this component picks the best one available:
//
//   1. an IMAGE — a raster snapshot taken after a viewer opened the artifact
//      and it settled with real data. The real thing, pixels and all.
//   2. a LAYOUT — sanitized markup from the create-time smoke render, which is
//      the artifact's true composition in its loading state (cards, tables,
//      chart frames, skeletons) with no data in it. Every artifact has one from
//      the moment it is saved.
//   3. a SCHEMATIC — the deterministic figure below, derived from the id.
//
// The fallback chain is strict and total: image, else layout, else schematic.
// Nothing here can fail to render something, which is what lets every producer
// of 1 and 2 fail open.
//
// ## Why the layout markup is inserted directly, and not into an iframe
//
// An iframe with `srcdoc` is the reflex for "render HTML I did not write", and
// it is the wrong tool here on both axes:
//
//   - It does not inherit the console's stylesheet. The markup's entire visual
//     layer is Tailwind classes plus theme tokens, and a srcdoc document has
//     neither — so every preview would need the compiled stylesheet and the
//     Geist woff2 inlined into it, per card, or it would render as unstyled
//     black-on-white text. Nine cards would each pay that.
//   - The security it buys is against a threat this markup does not carry.
//
// What is actually being inserted is not arbitrary HTML. It is OUR OWN server
// render, produced by React's server renderer inside a QuickJS sandbox from
// code that already passed the create-time guards, then reduced by
// `sanitizeArtifactPreviewMarkup` to an ALLOWLIST: known-inert elements, known
// attributes, no `script`, no `style` element, no `img`, no `iframe`, no
// handler, no external reference of any kind, ids namespaced so a preview
// cannot collide with the console document. The sanitizer is the boundary, and
// it is written not to trust the renderer's output either — see its header.
//
// So direct insertion is the correct trade: the preview inherits the console's
// fonts, tokens and dark mode for free, costs one DOM subtree instead of one
// document, and is inert by allowlist rather than by container. The container
// still does its share — `pointer-events-none`, `aria-hidden`, `contain`, and a
// transform scale — so the preview cannot be clicked, focused, read by a screen
// reader, or paint outside its box.
//
// The schematic remains for everything with no preview yet: deliberately
// abstract hairline geometry in the grayscale ramp, the same vocabulary as the
// marketing site's graph-paper illustrations, because a placeholder that
// imitated a screenshot would be lying about what it knows. It is derived from
// `artifactId`, so a given artifact always draws the same figure and the eye
// can use the shape as a weak landmark.
// ---------------------------------------------------------------------------

import type { ArtifactPreview as ArtifactPreviewValue } from "@executor-js/sdk/shared";

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
 * The width the stored markup is laid out at before being scaled to fit.
 *
 * The markup was rendered by a server renderer with no viewport, so it has no
 * intrinsic width; laying it out at a desktop-ish width and scaling down is
 * what makes a card look like a small screenshot of the artifact rather than a
 * cramped mobile rendering of it. The card is 16:10, so the height follows.
 */
const LAYOUT_WIDTH = 880;
const LAYOUT_HEIGHT = Math.round((LAYOUT_WIDTH * 10) / 16);

/**
 * The artifact's real loading-state markup, scaled into the card.
 *
 * `dangerouslySetInnerHTML` is the right call here and the sanitizer is why —
 * see this file's header for the full argument. In short: the markup is our own
 * sandboxed server render reduced to an allowlist of inert elements and
 * attributes, with no script, style element, image, frame, handler or external
 * reference able to survive. The wrapper adds containment on top: it cannot be
 * clicked or focused (`pointer-events-none`, no tabbable descendants survive
 * sanitizing), it is invisible to assistive tech (`aria-hidden`), and `contain`
 * plus `overflow-hidden` stop it painting or laying out beyond its box.
 */
function LayoutPreview(props: { readonly markup: string }) {
  return (
    <div
      data-slot="artifact-preview"
      data-preview-kind="layout"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 select-none overflow-hidden [contain:strict]"
    >
      <div
        // Scaled from the top-left so the artifact's header — the part that
        // identifies it — is always what the card shows, rather than its
        // middle.
        style={{
          width: LAYOUT_WIDTH,
          height: LAYOUT_HEIGHT,
          transform: `scale(${1 / 2.75})`,
          transformOrigin: "top left",
        }}
        // eslint-disable-next-line react/no-danger -- allowlist-sanitized SSR output; see the module header
        dangerouslySetInnerHTML={{ __html: props.markup }}
      />
    </div>
  );
}

/** A raster snapshot of a settled render — the artifact as it really looked. */
function ImagePreview(props: { readonly src: string }) {
  return (
    <img
      data-slot="artifact-preview"
      data-preview-kind="image"
      src={props.src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="pointer-events-none absolute inset-0 size-full select-none object-cover object-top"
    />
  );
}

/**
 * What the gallery draws for an artifact.
 *
 * Strict fallback chain — image, else layout, else schematic — so there is
 * always something to show and every producer upstream can fail open.
 *
 * Decorative by construction in all three cases, so it is hidden from assistive
 * technology and from the accessibility tree the e2e locators read: the card's
 * link already carries the artifact's name.
 */
export function ArtifactPreview(props: {
  readonly artifactId: string;
  readonly preview?: ArtifactPreviewValue | null;
  readonly className?: string;
}) {
  const kind = artifactPreviewKind(props.preview);
  if (kind === "image" && props.preview?.kind === "image") {
    return <ImagePreview src={props.preview.src} />;
  }
  if (kind === "layout" && props.preview?.kind === "layout") {
    return <LayoutPreview markup={props.preview.markup} />;
  }
  return <ArtifactSchematic artifactId={props.artifactId} className={props.className} />;
}

/**
 * Which of the three previews an artifact gets.
 *
 * Exported so the fallback chain is testable as a pure function rather than
 * only through a rendered tree: "image beats layout beats schematic, and an
 * empty one of either is not a preview" is the contract, and it is the part
 * that would silently regress.
 */
export const artifactPreviewKind = (
  preview: ArtifactPreviewValue | null | undefined,
): "image" | "layout" | "schematic" => {
  if (preview?.kind === "image" && preview.src !== "") return "image";
  if (preview?.kind === "layout" && preview.markup !== "") return "layout";
  return "schematic";
};

/**
 * The fallback figure, for an artifact with no captured preview.
 *
 * Exported so the fallback is testable on its own terms, and so the gallery's
 * empty-ish states can draw it deliberately.
 */
export function ArtifactSchematic(props: {
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
