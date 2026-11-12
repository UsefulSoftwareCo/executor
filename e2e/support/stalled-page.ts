/**
 * What a released-image page could not load, reported when a step waiting on it fails. A page
 * whose scripts did not load keeps the form it was served with, and a click on that form does
 * nothing; the browser's reason for each failed request, such as `net::ERR_NETWORK_CHANGED`,
 * says why. See `release-networks.ts`.
 */
import { Console, Effect } from "effect";
import type { Page } from "playwright";
import { driver } from "./platform.ts";

/** Start recording `page`'s failed requests; the result reports them if `step` fails. */
export const stalledPageReport = (page: Page) => {
  const failed: string[] = [];
  page.on("requestfailed", (request) =>
    failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`),
  );
  return <A, E, R>(step: Effect.Effect<A, E, R>) =>
    step.pipe(
      Effect.tapError(() =>
        driver("read the stalled page", () =>
          page.evaluate(() => ({ url: location.href, readyState: document.readyState })),
        ).pipe(
          Effect.flatMap((state) =>
            Console.error(
              `The page stalled at ${state.url} (${state.readyState}); failed requests:\n${failed.join("\n") || "none"}`,
            ),
          ),
          Effect.ignore,
        ),
      ),
    );
};
