import { Effect, Schema } from "effect";
import { Browser } from "./browser.ts";
import { Evidence } from "./evidence.ts";

const Rect = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]);
const Recorded = Schema.Struct({
  marks: Schema.Array(
    Schema.Struct({ name: Schema.String, resize: Schema.Boolean, at: Schema.Number }),
  ),
  entries: Schema.Array(
    Schema.Struct({
      at: Schema.Number,
      value: Schema.Number,
      hadRecentInput: Schema.Boolean,
      sources: Schema.Array(
        Schema.Struct({ node: Schema.NullOr(Schema.String), previous: Rect, current: Rect }),
      ),
    }),
  ),
});

declare global {
  interface Window {
    executorLayoutShifts?: typeof Recorded.Encoded;
    executorLayoutMark?: (name: string, resize: boolean) => void;
  }
}

/** Waits two frames, so the browser has reported the shifts of everything already rendered. */
const painted = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/**
 * Records every layout shift the browser reports in the current document, including those within
 * 500ms of input that CLS leaves out, and files each under the named journey phase it fell in.
 * Shifts reported before the first phase belong to `load`. A viewport change lays the whole page
 * out again, so `resize` files its own shifts under a phase that `unstable` leaves out.
 */
export const observeLayoutShifts = Effect.gen(function* () {
  const browser = yield* Browser;
  const evidence = yield* Evidence;
  yield* browser.use("Observe the browser's layout shifts", (page) =>
    page.evaluate(() => {
      type Box = [number, number, number, number];
      const marks: { name: string; resize: boolean; at: number }[] = [];
      const entries: {
        at: number;
        value: number;
        hadRecentInput: boolean;
        sources: { node: string | null; previous: Box; current: Box }[];
      }[] = [];
      window.executorLayoutShifts = { marks, entries };
      const describe = (node: unknown) => {
        const element =
          node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
        if (element === null) return null;
        const label =
          element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 48) ?? "";
        return `${element.tagName.toLowerCase()} "${label}"`;
      };
      const rect = (box: DOMRectReadOnly): Box => [box.x, box.y, box.width, box.height];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            !("value" in entry) ||
            typeof entry.value !== "number" ||
            !("hadRecentInput" in entry) ||
            typeof entry.hadRecentInput !== "boolean"
          )
            continue;
          const items: readonly unknown[] =
            "sources" in entry && Array.isArray(entry.sources) ? entry.sources : [];
          entries.push({
            at: entry.startTime,
            value: entry.value,
            hadRecentInput: entry.hadRecentInput,
            sources: items.flatMap((source) =>
              typeof source === "object" &&
              source !== null &&
              "previousRect" in source &&
              source.previousRect instanceof DOMRectReadOnly &&
              "currentRect" in source &&
              source.currentRect instanceof DOMRectReadOnly
                ? [
                    {
                      node: describe("node" in source ? source.node : null),
                      previous: rect(source.previousRect),
                      current: rect(source.currentRect),
                    },
                  ]
                : [],
            ),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
      window.executorLayoutMark = (name, resize) => {
        marks.push({ name, resize, at: performance.now() });
      };
    }),
  );
  const mark = (name: string, resize: boolean) =>
    browser.use(`Layout phase: ${name}`, (page) =>
      page.evaluate(
        ([name, resize]) => {
          window.executorLayoutMark?.(name, resize);
        },
        [name, resize] as const,
      ),
    );
  const read = browser
    .use("Read the browser's layout shifts", (page) =>
      page.evaluate(painted).then(() => page.evaluate(() => window.executorLayoutShifts)),
    )
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Recorded)));
  return {
    /** Starts a phase; later shifts belong to it until the next one starts. */
    phase: (name: string) => mark(name, false),
    /** Changes the viewport inside a phase of its own, then starts `next`. */
    resize: (size: { readonly width: number; readonly height: number }, next: string) =>
      Effect.gen(function* () {
        yield* mark(`Resize to ${size.width}x${size.height}`, true);
        yield* browser.use(`Resize to ${size.width}x${size.height}`, (page) =>
          page.setViewportSize(size).then(() => page.evaluate(painted)),
        );
        yield* mark(next, false);
      }),
    /**
     * Saves every shift with its phase as `name`, and returns the ones outside viewport changes.
     * Each phase is listed with its shift count and scores, with and without recent input.
     */
    unstable: (name: string) =>
      Effect.gen(function* () {
        const { marks, entries } = yield* read;
        const phaseAt = (at: number) => marks.findLast((mark) => mark.at <= at);
        const phases = [{ name: "load", resize: false }, ...marks].map((mark) => {
          const shifts = entries.filter(
            (entry) => (phaseAt(entry.at)?.name ?? "load") === mark.name,
          );
          const score = (recent: boolean) =>
            shifts
              .filter((entry) => entry.hadRecentInput === recent)
              .reduce((total, entry) => total + entry.value, 0);
          return {
            phase: mark.name,
            resize: mark.resize,
            shifts: shifts.length,
            withRecentInput: shifts.filter((entry) => entry.hadRecentInput).length,
            score: score(false),
            recentInputScore: score(true),
          };
        });
        const filed = entries.map((entry) => ({
          phase: phaseAt(entry.at)?.name ?? "load",
          resize: phaseAt(entry.at)?.resize ?? false,
          ...entry,
        }));
        yield* evidence.json(name, { phases, shifts: filed });
        return filed.filter((entry) => !entry.resize);
      }),
  };
});
