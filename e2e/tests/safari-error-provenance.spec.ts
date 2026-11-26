import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { Browser } from "../support/browser.ts";
import {
  awaitSentryWholeEnvironment,
  captureThroughPage,
  sentryEventsWholeEnvironment,
  type SentryEvent,
} from "../support/browser-observability.ts";
import { WebKitLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const docsPage = "/docs/mcp";
const mentions = (event: SentryEvent, text: string) =>
  event.exception?.values.some((value) => value.value.includes(text)) === true;

layer(WebKitLive, { excludeTestServices: true })("Safari error provenance", (it) => {
  it.effect(scenarios.safariErrorProvenance.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const pageErrors: Array<string> = [];
        yield* browser.use("Record uncaught page errors", (page) => {
          page.on("pageerror", (error) => pageErrors.push(error.message));
          return Promise.resolve();
        });
        yield* browser.use("Open the documentation", (page) => page.goto(docsPage));
        yield* browser.use("The documentation is rendered", (page) =>
          page.getByRole("heading", { level: 1 }).first().waitFor(),
        );

        const run = randomUUID().slice(0, 8);
        const bridge = `messageHandlers-${run}`,
          compiledListener = `compiled-listener-${run}`,
          inlineListener = `inline-compiled-listener-${run}`,
          compiledTimer = `compiled-timer-${run}`;
        yield* browser.use("Register an evaluated focus listener", (page) =>
          page.evaluate(
            `document.addEventListener("focusin", function caret() {
              window.webkit[${JSON.stringify(bridge)}].postMessage({});
            }, { once: true })`,
          ),
        );
        yield* browser.use("Register an evaluated compiled listener", (page) =>
          page.evaluate(
            `document.addEventListener("focusin", new Function(${JSON.stringify(
              `throw new Error(${JSON.stringify(compiledListener)})`,
            )}), { once: true })`,
          ),
        );
        yield* browser.use("Run an injected script with compiled callbacks", (page) =>
          page.addScriptTag({
            content: `document.addEventListener("click", new Function(${JSON.stringify(
              `throw new Error(${JSON.stringify(inlineListener)})`,
            )}), { once: true });
            setTimeout(new Function(${JSON.stringify(
              `throw new Error(${JSON.stringify(compiledTimer)})`,
            )}), 0);`,
          }),
        );
        yield* browser.use("Move keyboard focus", (page) => page.keyboard.press("Tab"));
        yield* browser.use("Click the page", (page) =>
          page.getByRole("heading", { level: 1 }).first().click(),
        );
        const raised = [bridge, compiledListener, inlineListener, compiledTimer];
        const unobserved = () =>
          raised.filter((text) => !pageErrors.some((message) => message.includes(text)));
        yield* Effect.sync(unobserved).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (missing) => missing.length === 0,
          }),
          Effect.timeoutOption("10 seconds"),
        );
        expect(unobserved()).toEqual([]);

        const sentinel = `docs-sentinel-${run}`;
        yield* captureThroughPage(sentinel);
        const [reported] = yield* awaitSentryWholeEnvironment((event) => mentions(event, sentinel));
        expect(reported?.tags?.surface).toBe("docs");
        const delivered = (yield* sentryEventsWholeEnvironment)
          .filter((event) => raised.some((text) => mentions(event, text)))
          .map((event) => event.exception?.values.map((value) => value.value));
        yield* evidence.json("foreign-failures.json", { raised, delivered });
        expect(delivered).toEqual([]);
      }),
    ),
  );
});
