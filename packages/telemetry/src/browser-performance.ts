/** Native page measurements. Observers and reporting fibers belong to the browser Layer. */
import { Effect, FiberSet, Option, Schedule, Schema } from "effect";
import { browserRequestTiming } from "./browser-request-timing.ts";
import { traceLinks } from "./trace-context.ts";

const layoutShift = Schema.decodeUnknownOption(
  Schema.Struct({ value: Schema.Number, hadRecentInput: Schema.Boolean }),
);
const eventTiming = Schema.decodeUnknownOption(
  Schema.Struct({
    interactionId: Schema.Number,
    processingStart: Schema.Number,
    processingEnd: Schema.Number,
  }),
);
const eventDurationThreshold = 104;

/** Collect page measurements without making them parents of unrelated API calls. */
export const observeBrowserPerformance = Effect.gen(function* () {
  const clock = window.performance;
  if (clock === undefined || typeof PerformanceObserver === "undefined") {
    return {
      flush: Effect.void,
      pause: Effect.void,
      resume: Effect.void,
      hide: Effect.void,
      restore: Effect.void,
      navigation: (_path: string) => Effect.void,
    };
  }

  let pagePath = window.location.pathname;
  const observers = new Map<string, PerformanceObserver>();
  const supported = new Set<string>();
  let path = pagePath;
  let generation = 0;
  // Buffered startup entries can predate acquisition of this Layer.
  let since = 0;
  let pageStart = 0;
  let active = document.visibilityState !== "hidden";
  let firstHidden = active ? Infinity : 0;
  let connected = true;
  let paint: number | undefined;
  let largestPaint: number | undefined;
  let lastPaint: number | undefined;
  let lastLargestPaint: number | undefined;
  let largestPaintFinished = false;
  let cls = 0;
  let lastCls: number | undefined;
  let shiftWindowStart = 0;
  let shiftWindowEnd = 0;
  let shiftWindowValue = 0;
  let longTasks = { count: 0, duration: 0, blocking: 0, max: 0 };
  let interactions = { count: 0, duration: 0, inputDelay: 0, processing: 0 };
  const run = yield* FiberSet.makeRuntime();
  const report = (name: string, attributes: Readonly<Record<string, string | number | boolean>>) =>
    Effect.logInfo(name).pipe(
      Effect.annotateLogs(attributes),
      Effect.withSpan(name, {
        root: true,
        attributes,
        links: traceLinks(
          {
            traceId: attributes["executor.trace_id"],
            spanId: attributes["executor.span_id"],
            sampled:
              attributes["executor.trace_sampled"] === undefined
                ? undefined
                : attributes["executor.trace_sampled"] === 1,
          },
          "request-timing",
        ),
      }),
    );

  const record = (entries: readonly PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.startTime < pageStart) continue;
      switch (entry.entryType) {
        case "resource": {
          const attributes = browserRequestTiming(entry, window.location.origin);
          if (attributes !== undefined) run(report("ui.request.timing", attributes));
          break;
        }
        case "paint":
          if (entry.name === "first-contentful-paint" && entry.startTime < firstHidden) {
            paint = entry.startTime;
          }
          break;
        case "largest-contentful-paint":
          if (!largestPaintFinished && entry.startTime < firstHidden) {
            largestPaint = entry.startTime;
          }
          break;
        case "layout-shift": {
          const parsed = layoutShift(entry);
          if (!active || Option.isNone(parsed) || parsed.value.hadRecentInput) break;
          const value = parsed.value.value;
          if (!Number.isFinite(value) || value < 0) break;
          // CLS is the largest session window: gaps under one second, length under five.
          if (
            shiftWindowValue > 0 &&
            entry.startTime - shiftWindowEnd < 1_000 &&
            entry.startTime - shiftWindowStart < 5_000
          ) {
            shiftWindowValue += value;
          } else {
            shiftWindowStart = entry.startTime;
            shiftWindowValue = value;
          }
          shiftWindowEnd = entry.startTime;
          cls = Math.max(cls, shiftWindowValue);
          break;
        }
        case "longtask":
          if (active) {
            longTasks.count += 1;
            longTasks.duration += entry.duration;
            longTasks.blocking += Math.max(0, entry.duration - 50);
            longTasks.max = Math.max(longTasks.max, entry.duration);
          }
          break;
        case "event": {
          const parsed = eventTiming(entry);
          if (!active || Option.isNone(parsed) || parsed.value.interactionId === 0) break;
          interactions.count += 1;
          interactions.duration = Math.max(interactions.duration, entry.duration);
          interactions.inputDelay = Math.max(
            interactions.inputDelay,
            parsed.value.processingStart - entry.startTime,
          );
          interactions.processing = Math.max(
            interactions.processing,
            parsed.value.processingEnd - parsed.value.processingStart,
          );
          break;
        }
      }
    }
  };
  const drain = () => {
    for (const observer of observers.values()) record(observer.takeRecords());
  };
  const disconnect = () => {
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
  };
  const observe = (buffered: boolean) => {
    for (const type of [
      "paint",
      "largest-contentful-paint",
      "layout-shift",
      "longtask",
      "event",
      "resource",
    ]) {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
      const observer = new PerformanceObserver((list) => record(list.getEntries()));
      try {
        observer.observe({
          type,
          buffered,
          ...(type === "event" ? { durationThreshold: eventDurationThreshold } : {}),
        });
        supported.add(type);
        observers.set(type, observer);
      } catch {
        // A browser can advertise an entry type but reject its observer options.
        observer.disconnect();
      }
    }
  };
  observe(true);

  const flush = Effect.gen(function* () {
    drain();
    const common = {
      "browser.page.time_origin_ms": clock.timeOrigin,
      "browser.page.restore_count": generation,
    };
    const measurements: { name: string; attributes: Record<string, string | number | boolean> }[] =
      [];
    const vital = (name: string, value: number, unit: string) => {
      measurements.push({
        name: "ui.performance.vital",
        attributes: {
          ...common,
          "url.path": pagePath,
          "browser.vital.name": name,
          "browser.vital.value": value,
          "browser.vital.unit": unit,
        },
      });
    };
    if (paint !== undefined && paint !== lastPaint) {
      vital("FCP", paint, "ms");
      lastPaint = paint;
    }
    if (largestPaint !== undefined && largestPaint !== lastLargestPaint) {
      vital("LCP", largestPaint, "ms");
      lastLargestPaint = largestPaint;
    }
    if (
      supported.has("layout-shift") &&
      (paint !== undefined || generation > 0) &&
      cls !== lastCls
    ) {
      vital("CLS", cls, "1");
      lastCls = cls;
    }
    const now = clock.now();
    const window = { ...common, "url.path": path, "browser.observation.duration_ms": now - since };
    if (longTasks.count > 0) {
      measurements.push({
        name: "ui.performance.long-tasks",
        attributes: {
          ...window,
          "browser.long_task.count": longTasks.count,
          "browser.long_task.duration_ms": longTasks.duration,
          "browser.long_task.blocking_ms": longTasks.blocking,
          "browser.long_task.max_duration_ms": longTasks.max,
        },
      });
    }
    if (interactions.count > 0) {
      measurements.push({
        name: "ui.performance.interactions",
        attributes: {
          ...window,
          "browser.interaction.slow_event_count": interactions.count,
          "browser.interaction.max_duration_ms": interactions.duration,
          "browser.interaction.max_input_delay_ms": interactions.inputDelay,
          "browser.interaction.max_processing_ms": interactions.processing,
          "browser.interaction.duration_threshold_ms": eventDurationThreshold,
        },
      });
    }
    since = now;
    longTasks = { count: 0, duration: 0, blocking: 0, max: 0 };
    interactions = { count: 0, duration: 0, inputDelay: 0, processing: 0 };
    yield* Effect.forEach(measurements, (measurement) =>
      report(measurement.name, measurement.attributes),
    );
  });
  const stopLargestPaint = () => {
    drain();
    largestPaintFinished = true;
    observers.get("largest-contentful-paint")?.disconnect();
    observers.delete("largest-contentful-paint");
  };
  window.addEventListener("keydown", stopLargestPaint, { capture: true });
  window.addEventListener("pointerdown", stopLargestPaint, { capture: true });
  yield* Effect.addFinalizer(() =>
    flush.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          disconnect();
          window.removeEventListener("keydown", stopLargestPaint, { capture: true });
          window.removeEventListener("pointerdown", stopLargestPaint, { capture: true });
        }),
      ),
    ),
  );
  yield* report("ui.performance.support", {
    "browser.performance.paint": supported.has("paint"),
    "browser.performance.largest_contentful_paint": supported.has("largest-contentful-paint"),
    "browser.performance.layout_shift": supported.has("layout-shift"),
    "browser.performance.long_task": supported.has("longtask"),
    "browser.performance.event_timing": supported.has("event"),
  });
  yield* flush.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);

  return {
    flush,
    pause: Effect.sync(() => {
      drain();
      firstHidden = Math.min(firstHidden, clock.now());
      stopLargestPaint();
      active = false;
    }),
    resume: Effect.sync(() => {
      // Discard background entries before counting the next foreground interval.
      drain();
      active = connected;
      since = clock.now();
    }),
    hide: Effect.sync(() => {
      drain();
      connected = false;
      active = false;
      disconnect();
    }),
    restore: Effect.sync(() => {
      disconnect();
      generation += 1;
      pageStart = clock.now();
      pagePath = window.location.pathname;
      since = pageStart;
      paint = lastPaint = largestPaint = lastLargestPaint = undefined;
      largestPaintFinished = false;
      cls = shiftWindowStart = shiftWindowEnd = shiftWindowValue = 0;
      lastCls = undefined;
      connected = true;
      active = document.visibilityState !== "hidden";
      firstHidden = active ? Infinity : pageStart;
      longTasks = { count: 0, duration: 0, blocking: 0, max: 0 };
      interactions = { count: 0, duration: 0, inputDelay: 0, processing: 0 };
      // Buffered paint entries belong to the original navigation, not this restoration.
      observe(false);
    }),
    navigation: (nextPath: string) =>
      flush.pipe(
        Effect.andThen(
          Effect.sync(() => {
            path = nextPath;
          }),
        ),
      ),
  };
});
