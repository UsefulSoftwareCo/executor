import { Console, Effect } from "effect";
import type { Page } from "playwright";
import { driver } from "./platform.ts";

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
