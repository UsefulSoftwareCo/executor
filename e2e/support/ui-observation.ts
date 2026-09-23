import { Clock, Deferred, Effect, Option, Queue, Schema, Scope, Schedule } from "effect";
import type { ConsoleMessage, Frame, Page, Route, Request, Response } from "playwright";
import { UIObservation, type UIFrameCapture, type UIFrameImage } from "../state-model.ts";
import type { Evidence } from "./evidence.ts";
import { driver, type Target, type DriverFailed } from "./platform.ts";

type Work =
  | { kind: "capture"; event: typeof UIObservation.Type; sequence: number }
  | { kind: "fence"; done: Deferred.Deferred<void> };

/** Own direct screenshots and optional request holds; ordinary runs acquire neither. */
export const captureUIObservations = (
  page: Page,
  evidence: typeof Evidence.Service,
  scope: Scope.Scope,
  target: typeof Target.Service,
) =>
  Effect.gen(function* () {
    if (!target.observeUI) return { settle: Effect.void };
    const events: (typeof UIObservation.Type)[] = [];
    const frames: (typeof UIFrameCapture.Type)[] = [];
    const holds: { path: string; heldMs: number; status: "released" | "cancelled" | "failed" }[] =
      [];
    const pending = new Set<Request>();
    const failures: DriverFailed[] = [];
    const queue = yield* Queue.unbounded<Work>();
    let invalid = 0,
      sequence = 0,
      navigationSequence = 0;
    let latest: number | null = null;
    const requestHoldMs = 600;
    const onApplication = () => URL.parse(page.url())?.origin === target.metadata.origin;
    let settlePhase = "idle";
    const cancelled = new AbortController();
    const fence = Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      yield* Queue.offer(queue, { kind: "fence", done });
      yield* Deferred.await(done);
    }).pipe(Effect.timeout("15 seconds"), Effect.orDie);
    const painted = driver("wait for browser frames", () =>
      page.evaluate(() => {
        // Re-sample bounds so CSS-only motion cannot leave stale geometry on a screenshot.
        window.dispatchEvent(new Event("executor-ui-observation-sample"));
        return new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }),
    );
    const settle = Effect.gen(function* () {
      while (true) {
        if (!onApplication()) {
          yield* fence;
          return;
        }
        settlePhase = "requests";
        while (pending.size > 0 && onApplication()) yield* Effect.sleep("10 millis");
        if (!onApplication()) {
          yield* fence;
          return;
        }
        settlePhase = "browser frames";
        yield* painted.pipe(Effect.retry({ times: 2, schedule: Schedule.spaced("50 millis") }));
        const expected = latest;
        settlePhase = "capture queue";
        yield* fence;
        // A view can arrive behind the fence while an earlier screenshot is in flight.
        // Drain that view too before the test's next interaction can replace it.
        if (
          pending.size === 0 &&
          latest === expected &&
          (latest === null || frames.some((frame) => frame.at === latest))
        )
          return;
      }
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.tapError(() =>
        evidence.json("ui-capture-timeout.json", {
          phase: settlePhase,
          onApplication: onApplication(),
          latest,
          pending: [...pending].map((request) => new URL(request.url()).pathname),
          recentFrames: frames.slice(-5),
        }),
      ),
      Effect.orDie,
    );
    const capture = (work: Extract<Work, { kind: "capture" }>) =>
      Effect.gen(function* () {
        let image: typeof UIFrameImage.Type = { status: "superseded", screenshot: null };
        if (latest === work.event.at && onApplication()) {
          const navigation = navigationSequence;
          const result = yield* Effect.gen(function* () {
            yield* painted;
            // Once capture starts, keep the transition even if another view arrives.
            // A navigation still invalidates work belonging to the departing document.
            if (navigationSequence !== navigation || !onApplication()) return null;
            const bytes = yield* driver("capture observed UI state", () =>
              page.screenshot({ type: "png", caret: "hide", timeout: 5000 }),
            );
            // The pixels remain useful even if navigation or another view interrupts validation.
            const validation = yield* painted.pipe(Effect.option);
            return {
              bytes,
              matched: Option.isSome(validation) && latest === work.event.at && onApplication(),
            };
          }).pipe(
            Effect.match({
              onFailure: () => ({ failed: true, capture: null }),
              onSuccess: (capture) => ({ failed: false, capture }),
            }),
          );
          if (result.failed) image = { status: "capture-failed", screenshot: null };
          else if (result.capture !== null) {
            const screenshot = `ui-frame-${work.sequence}.png`;
            yield* evidence.attach(screenshot, "image/png", result.capture.bytes);
            image = {
              status: result.capture.matched ? "captured" : "in-transition",
              screenshot,
            };
          }
        }
        frames.push({
          at: work.event.at,
          completedAt: yield* Clock.currentTimeMillis,
          ...image,
        });
      });
    yield* Effect.forkIn(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((work) =>
            work.kind === "fence" ? Deferred.succeed(work.done, undefined) : capture(work),
          ),
        ),
      ),
      scope,
    );
    const prefix = "executor-ui-observation:";
    const receive = (message: ConsoleMessage) => {
      const text = message.text();
      if (!text.startsWith(prefix)) return;
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(UIObservation))(
        text.slice(prefix.length),
      );
      if (Option.isNone(decoded)) {
        invalid++;
        return;
      }
      const event = decoded.value;
      events.push(event);
      if (event.kind === "view") {
        latest = event.at;
        Queue.offerUnsafe(queue, { kind: "capture", event, sequence: sequence++ });
      }
    };
    const navigated = (frame: Frame) => {
      if (frame === page.mainFrame()) {
        navigationSequence++;
        latest = null;
      }
    };
    const pattern = `${target.metadata.origin}/api/**`;
    const hold = (route: Route) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const request = route.request();
          // Page-owned keepalive telemetry can outlive the document that sent it.
          // It never changes the UI, so it must not hold the next document's capture.
          // Send it normally; only UI requests participate in controlled loading.
          if (new URL(request.url()).pathname.startsWith("/api/telemetry/")) {
            yield* driver("send background telemetry", () => route.continue());
            return;
          }
          pending.add(request);
          const started = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(requestHoldMs);
          yield* fence;
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          // A navigation or unmount may cancel the browser's request while it is held.
          const status = yield* driver("release observed request", () => route.continue()).pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.succeed("released" as const),
              onFailure: (error) =>
                Effect.gen(function* () {
                  yield* Effect.sleep("10 millis");
                  pending.delete(request);
                  if (request.failure() !== null || page.isClosed()) return "cancelled" as const;
                  failures.push(error);
                  return "failed" as const;
                }),
            }),
          );
          holds.push({
            path: new URL(request.url()).pathname.replace(
              /\/org(?:anizations)?\/[^/]+/,
              "/org/:organization",
            ),
            heldMs: elapsed,
            status,
          });
        }),
        { signal: cancelled.signal },
      );
    const response = (response: Response) => pending.delete(response.request());
    const failed = (request: Request) => pending.delete(request);
    const requested = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        // Requests from a departing document no longer gate the next document's UI.
        pending.clear();
        latest = null;
      }
    };
    page.on("request", requested);
    page.on("response", response);
    page.on("requestfailed", failed);
    page.on("requestfinished", failed);
    page.on("console", receive);
    page.on("framenavigated", navigated);
    yield* driver("hold requests for state capture", () => page.context().route(pattern, hold));
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        // Drain in-flight handlers while the capture worker is still alive.
        yield* driver("finish state capture routing", () =>
          page.context().unrouteAll({ behavior: "wait" }),
        ).pipe(Effect.orDie);
        yield* painted.pipe(Effect.ignore);
        yield* fence;
        page.off("console", receive);
        page.off("framenavigated", navigated);
        yield* fence;
        yield* evidence.json("ui-observations.json", events);
        yield* evidence.json("ui-captures.json", { requestHoldMs, holds, frames });
        cancelled.abort();
        if (failures[0]) yield* Effect.die(failures[0]);
        if (invalid > 0) yield* Effect.die(new Error("Invalid UI observation protocol"));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            page.off("console", receive);
            page.off("framenavigated", navigated);
            page.off("response", response);
            page.off("requestfailed", failed);
            page.off("requestfinished", failed);
            page.off("request", requested);
            cancelled.abort();
          }),
        ),
      ),
    );
    return { settle };
  });
