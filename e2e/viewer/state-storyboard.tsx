import { useEffect, useState } from "react";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { UIStateReport, type ViewRect } from "../state-model.ts";

type Report = typeof UIStateReport.Type;
type State = Report["states"][number];
type Rect = typeof ViewRect.Type;
type StateImage =
  | { kind: "direct" | "transition"; screenshot: string }
  | { kind: "representative"; screenshot: string; sourceIndex: number }
  | { kind: "missing"; screenshot: null };
const representativeKey = (state: State) =>
  JSON.stringify({
    ...state.view,
    landmarks: state.view.landmarks.map(({ key, label, role }) => ({ key, label, role })),
  });
const stateImages = (states: readonly State[]): StateImage[] => {
  // Match semantics exactly, then apply the same geometry tolerance as layout highlights.
  // Input contents and image contents are deliberately absent from the diagnostics.
  const representatives = new Map<
    string,
    { screenshot: string; sourceIndex: number; state: State }[]
  >();
  states.forEach((state, sourceIndex) => {
    if (state.captureStatus !== "captured" || state.screenshot === null) return;
    const key = representativeKey(state);
    const candidates = representatives.get(key) ?? [];
    candidates.push({ screenshot: state.screenshot, sourceIndex, state });
    representatives.set(key, candidates);
  });
  return states.map((state, index) => {
    if (state.screenshot !== null)
      return {
        kind: state.captureStatus === "captured" ? "direct" : "transition",
        screenshot: state.screenshot,
      };
    const source = representatives
      .get(representativeKey(state))
      ?.filter((candidate) => changesBetween(state, candidate.state).length === 0)
      .toSorted((a, b) => Math.abs(a.sourceIndex - index) - Math.abs(b.sourceIndex - index))[0];
    return source
      ? { kind: "representative", screenshot: source.screenshot, sourceIndex: source.sourceIndex }
      : { kind: "missing", screenshot: null };
  });
};
const imageLabel = (image: StateImage) => {
  switch (image.kind) {
    case "direct":
      return "Direct screenshot";
    case "transition":
      return "In transition";
    case "representative":
      return `Representative · state ${image.sourceIndex + 1}`;
    case "missing":
      return "No image";
  }
};
type Change = {
  key: string;
  label: string;
  kind: "moved" | "resized" | "moved and resized" | "appeared" | "disappeared";
  before: Rect | null;
  after: Rect | null;
  dx: number;
  dy: number;
};
const button =
  "rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 disabled:opacity-40 aria-pressed:bg-[var(--selected)]";
const title = (state: State) => {
  const base = state.view.headings[0] ?? state.view.statuses.find(Boolean) ?? "Starting page";
  if (state.view.alerts.length) return `${base} · error`;
  if (state.view.controls.some((control) => control.disabled) && state.view.statuses.some(Boolean))
    return `${base} · loading`;
  if (state.view.controls.some((control) => control.edited)) return `${base} · edited`;
  return base;
};
const compatible = (a: State, b: State) =>
  JSON.stringify(a.view.viewport) === JSON.stringify(b.view.viewport);
const changesBetween = (previous: State, current: State): Change[] => {
  const before = new Map(previous.view.landmarks.map((item) => [item.key, item]));
  const after = new Map(current.view.landmarks.map((item) => [item.key, item]));
  const changes: Change[] = [];
  for (const [key, item] of before) {
    const next = after.get(key);
    if (!next) {
      changes.push({
        key,
        label: item.label,
        kind: "disappeared",
        before: item.rect,
        after: null,
        dx: 0,
        dy: 0,
      });
      continue;
    }
    const dx = next.rect.x - item.rect.x,
      dy = next.rect.y - item.rect.y;
    const moved = Math.abs(dx) > 2 || Math.abs(dy) > 2;
    const resized =
      Math.abs(next.rect.width - item.rect.width) > 2 ||
      Math.abs(next.rect.height - item.rect.height) > 2;
    if (moved || resized)
      changes.push({
        key,
        label: item.label,
        kind: moved && resized ? "moved and resized" : moved ? "moved" : "resized",
        before: item.rect,
        after: next.rect,
        dx,
        dy,
      });
  }
  for (const [key, item] of after)
    if (!before.has(key))
      changes.push({
        key,
        label: item.label,
        kind: "appeared",
        before: null,
        after: item.rect,
        dx: 0,
        dy: 0,
      });
  return changes;
};

function Movement({
  state,
  changes,
  selected,
}: {
  state: State;
  changes: readonly Change[];
  selected: string | null;
}) {
  return (
    <svg
      aria-label="Layout changes"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${state.view.viewport.width} ${state.view.viewport.height}`}
    >
      {changes
        .filter((change) => selected === null || change.key === selected)
        .map((change) => (
          <g key={change.key}>
            <title>
              {change.label}: {change.kind}
            </title>
            {change.before && (
              <rect
                {...change.before}
                fill="#f97316"
                fillOpacity="0.06"
                stroke="#f97316"
                strokeWidth="2"
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {change.after && (
              <rect
                {...change.after}
                fill="#06b6d4"
                fillOpacity="0.06"
                stroke="#06b6d4"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {change.before && change.after && (change.dx || change.dy) ? (
              <line
                x1={change.before.x + change.before.width / 2}
                y1={change.before.y + change.before.height / 2}
                x2={change.after.x + change.after.width / 2}
                y2={change.after.y + change.after.height / 2}
                stroke="#f97316"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </g>
        ))}
    </svg>
  );
}

function Frame({
  state,
  image,
  previous,
  overlay,
  mix,
  changes,
  selected,
  asset,
}: {
  state: State;
  image: StateImage;
  previous?: State | undefined;
  overlay: boolean;
  mix: number;
  changes: readonly Change[];
  selected: string | null;
  asset: (file: string) => string;
}) {
  return (
    <div
      className="relative w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)]"
      style={{ aspectRatio: `${state.view.viewport.width}/${state.view.viewport.height}` }}
    >
      {overlay && previous?.screenshot && (
        <img
          className="absolute inset-0 h-full w-full max-h-none! object-fill!"
          src={asset(previous.screenshot)}
          alt="Previous state"
        />
      )}
      {image.screenshot ? (
        <img
          key={image.screenshot}
          className="absolute inset-0 h-full w-full max-h-none! object-contain!"
          style={{ opacity: overlay ? mix : 1 }}
          src={asset(image.screenshot)}
          alt={`State: ${title(state)} · ${imageLabel(image)}`}
        />
      ) : (
        <div className="absolute inset-0 grid place-content-center gap-2 p-6 text-center text-sm text-[var(--muted)]">
          <strong>No image for this occurrence</strong>
          <span>
            {state.captureStatus === "capture-failed"
              ? "The browser capture failed."
              : "No screenshot was retained. Its observed state is still available in the evidence."}
          </span>
        </div>
      )}
      {image.kind === "direct" && changes.length > 0 && (
        <Movement state={state} changes={changes} selected={selected} />
      )}
    </div>
  );
}

/** Step through observed states, with explicit provenance for transition and representative images. */
export function StateStoryboard({
  href,
  journey,
  journeys,
}: {
  href: string;
  journey: string;
  journeys: readonly { id: string; title: string }[];
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<"frame" | "overlay" | "split">("frame");
  const [mix, setMix] = useState(0.5);
  const [highlight, setHighlight] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [reference, setReference] = useState<number | null>(null);
  useEffect(
    () =>
      Effect.runCallback(
        Effect.scoped(
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient;
            const response = yield* http.get(new URL(href, location.href));
            if (response.status !== 200)
              return yield* Effect.fail(new Error("State evidence unavailable"));
            return yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(UIStateReport)),
            );
          }),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.match({
            onFailure: () => setFailed(true),
            onSuccess: (value) => {
              setReport(value);
              setIndex(
                Math.max(
                  0,
                  value.states.findIndex((state) => state.screenshot !== null),
                ),
              );
            },
          }),
        ),
      ),
    [href],
  );
  if (failed)
    return (
      <p role="alert" className="p-5">
        Storyboard could not be loaded.
      </p>
    );
  if (!report) return <p className="p-5">Loading storyboard…</p>;
  const current = report.states[index];
  if (!current) return <p className="p-5">No UI states were observed.</p>;
  const images = stateImages(report.states);
  const currentImage = images[index];
  if (!currentImage) throw new Error("Missing state image information");
  const references = report.states.flatMap((state, at) =>
    at < index && state.captureStatus === "captured" && state.screenshot !== null
      ? [{ state, at, image: { kind: "direct" as const, screenshot: state.screenshot } }]
      : [],
  );
  const comparison = references.find((item) => item.at === reference) ?? references.at(-1);
  const previous = comparison?.state;
  const asset = (file: string) => new URL(file, new URL(href, location.href)).href;
  const comparable = previous !== undefined && compatible(previous, current);
  const canCompare = comparable && currentImage.kind === "direct";
  const modeShown = canCompare ? mode : "frame";
  const changes = canCompare ? changesBetween(previous, current) : [];
  const shownChanges = highlight ? changes : [];
  const choose = (next: number) => {
    setIndex(Math.max(0, Math.min(report.states.length - 1, next)));
    setSelected(null);
    setReference(null);
  };
  const shifts = comparison
    ? report.states.slice(comparison.at + 1, index + 1).flatMap((state) => state.shifts)
    : current.shifts;
  const afterInput = shifts.filter((shift) => shift.hadRecentInput).length;
  return (
    <section
      aria-label="UI storyboard"
      tabIndex={0}
      className="space-y-4 p-4 outline-none sm:p-5"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("input,select,textarea,[contenteditable=true]")
        )
          return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          choose(index + 1);
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          choose(index - 1);
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button className={button} disabled={index === 0} onClick={() => choose(index - 1)}>
            ← Previous state
          </button>
          <span className="min-w-12 text-center text-xs tabular-nums" aria-live="polite">
            {index + 1} / {report.states.length}
          </span>
          <button
            className={button}
            disabled={index === report.states.length - 1}
            onClick={() => choose(index + 1)}
          >
            Next state →
          </button>
        </div>
        <label className="flex min-w-0 max-w-full items-center gap-2 text-xs text-[var(--muted)]">
          Journey
          <select
            className="min-w-0 max-w-80 flex-1 truncate rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text)]"
            aria-label="Storyboard journey"
            value={journey}
            onChange={(event) => {
              location.hash = `test=${event.target.value}`;
            }}
          >
            {journeys.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mb-1! text-lg font-semibold" data-testid="state-title">
            {title(current)}
          </h2>
          <p className="m-0 text-xs text-[var(--muted)]">
            <code>{current.view.route}</code> · {Math.round(current.durationMs)} ms in capture run ·{" "}
            {imageLabel(currentImage)}
          </p>
        </div>
        <div className="flex gap-1" aria-label="Comparison mode">
          {(["frame", "overlay", "split"] as const).map((value) => (
            <button
              className={button}
              key={value}
              aria-pressed={modeShown === value}
              disabled={value !== "frame" && !canCompare}
              onClick={() => setMode(value)}
            >
              {value === "frame"
                ? "Frame"
                : value === "overlay"
                  ? "Overlay previous"
                  : "Side by side"}
            </button>
          ))}
        </div>
      </div>
      {modeShown === "overlay" && (
        <label className="flex items-center gap-3 text-xs">
          Previous
          <input
            aria-label="Overlay blend"
            className="min-w-0 flex-1 accent-cyan-500"
            type="range"
            min="0"
            max="100"
            value={mix * 100}
            onChange={(event) => setMix(event.currentTarget.valueAsNumber / 100)}
          />
          Current
        </label>
      )}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0">
          {modeShown === "split" && previous && comparison ? (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-2 text-xs text-[var(--muted)]">Previous</p>
                <Frame
                  state={previous}
                  image={comparison.image}
                  overlay={false}
                  mix={1}
                  changes={[]}
                  selected={null}
                  asset={asset}
                />
              </div>
              <div>
                <p className="mb-2 text-xs text-[var(--muted)]">Current</p>
                <Frame
                  state={current}
                  image={currentImage}
                  overlay={false}
                  mix={1}
                  changes={shownChanges}
                  selected={selected}
                  asset={asset}
                />
              </div>
            </div>
          ) : (
            <Frame
              state={current}
              image={currentImage}
              previous={previous}
              overlay={modeShown === "overlay"}
              mix={mix}
              changes={shownChanges}
              selected={selected}
              asset={asset}
            />
          )}
          <p className="mt-2 text-xs text-[var(--muted)]">
            ← → to step · Same viewport and scroll position required for comparison.
          </p>
        </div>
        <div className="space-y-3 text-xs">
          <label className="block space-y-1 text-[var(--muted)]">
            Compare with
            <select
              aria-label="Comparison reference"
              className="block w-full min-w-0 truncate rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text)]"
              disabled={references.length === 0}
              value={comparison?.at ?? ""}
              onChange={(event) => {
                const choice = references.find((item) => String(item.at) === event.target.value);
                if (choice) {
                  setReference(choice.at);
                  setSelected(null);
                }
              }}
            >
              {references.length === 0 && <option value="">No earlier captured frame</option>}
              {references.map((item) => (
                <option key={item.at} value={item.at}>
                  State {item.at + 1}: {title(item.state)}
                </option>
              ))}
            </select>
          </label>
          {comparison && comparison.at !== index - 1 && (
            <p className="text-[var(--muted)]">
              Comparing with state {comparison.at + 1}. All observations remain in the strip.
            </p>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={highlight}
              disabled={!canCompare}
              onChange={(event) => setHighlight(event.target.checked)}
            />
            Highlight layout changes
          </label>
          <div className="flex gap-3">
            <span className="text-orange-500">▧ Previous</span>
            <span className="text-cyan-500">▧ Current</span>
          </div>
          {!previous ? (
            <p className="text-[var(--muted)]">Select the next state to compare layouts.</p>
          ) : !canCompare ? (
            <p className="text-[var(--muted)]">
              {!comparable
                ? "Viewport or scroll position changed."
                : "Layout outlines require direct screenshots matched to both observations."}{" "}
              Geometry comparison is unavailable.
            </p>
          ) : (
            <>
              <div className="flex justify-between">
                <strong>{changes.length} element changes</strong>
                {selected && (
                  <button className="underline" onClick={() => setSelected(null)}>
                    Show all
                  </button>
                )}
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {changes.map((change) => (
                  <button
                    className="block w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-left hover:bg-[var(--hover)] aria-pressed:bg-[var(--selected)]"
                    key={change.key}
                    aria-pressed={selected === change.key}
                    onClick={() => {
                      setSelected(selected === change.key ? null : change.key);
                      setHighlight(true);
                    }}
                  >
                    <span className="block truncate font-medium">{change.label}</span>
                    <span className="text-[var(--muted)]">
                      {change.kind}
                      {change.dx || change.dy ? ` · ${change.dx}px x, ${change.dy}px y` : ""}
                    </span>
                  </button>
                ))}
                {changes.length === 0 && (
                  <p className="text-[var(--muted)]">Matched elements stayed in place.</p>
                )}
              </div>
            </>
          )}
          <div className="border-t border-[var(--border)] pt-3">
            <strong>{shifts.length} browser layout-shift events</strong>
            <p className="mt-1 text-[var(--muted)]">
              {afterInput} after recent input · included here, not filtered as CLS would be.
            </p>
          </div>
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2" aria-label="State frames">
        {report.states.map((state, i) => {
          const image = images[i];
          if (!image) throw new Error("Missing state image information");
          return (
            <button
              key={i}
              className="w-32 shrink-0 overflow-hidden rounded-md border-2 border-transparent bg-[var(--canvas)] text-left aria-current:border-cyan-500"
              aria-label={`State ${i + 1}: ${title(state)}`}
              aria-current={i === index ? "step" : undefined}
              onClick={() => choose(i)}
            >
              {image.screenshot ? (
                <img
                  loading="lazy"
                  className="aspect-[3/2] w-full max-h-none! object-contain!"
                  src={asset(image.screenshot)}
                  alt=""
                />
              ) : (
                <div className="grid aspect-[3/2] place-items-center text-xs text-[var(--muted)]">
                  No image
                </div>
              )}
              <span className="block truncate px-2 py-1 text-[11px]">
                {i + 1}. {title(state)}
              </span>
              {(image.kind === "transition" || image.kind === "representative") && (
                <span className="block px-2 pb-1 text-[10px] text-[var(--muted)]">
                  {imageLabel(image)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <details className="rounded border border-[var(--border)] p-3 text-xs">
        <summary>Capture details and state signals</summary>
        {currentImage.kind === "transition" && (
          <p>
            This image was retained without a confirmed layout match. Layout outlines are
            unavailable.
          </p>
        )}
        {currentImage.kind === "representative" && (
          <p>
            Using an image from{" "}
            <button className="underline" onClick={() => choose(currentImage.sourceIndex)}>
              state {currentImage.sourceIndex + 1}
            </button>
            , which has the same observed controls and a layout within 2px. Field values and imagery
            may differ.
          </p>
        )}
        <p>
          Controlled capture: API requests pause for at least {report.capture.requestHoldMs}ms and
          until pending snapshots finish. These durations are not performance measurements.
        </p>
        <p>
          Elements are matched by semantic labels and occurrence. Movement over 2px is highlighted
          for review; it is not automatically a bug.
        </p>
        <pre>{current.atoms.join("\n") || "No atom status change before this state"}</pre>
        <p>
          Capture outcome: {current.captureStatus}. {current.commits} commits since prior state ·{" "}
          {current.triggers}
        </p>
      </details>
    </section>
  );
}
