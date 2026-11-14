/** The errors a page raised, as a scenario that expects none reports them. */
import { Effect, Schema } from "effect";
import { indented, safeText } from "./failure-text.ts";

/** A scenario expected a page to raise no errors; each one is listed, masked. */
export class PageErrorsRaised extends Schema.TaggedError<PageErrorsRaised>()("PageErrorsRaised", {
  expectation: Schema.String,
  errors: Schema.Array(Schema.String),
}) {
  get message() {
    const count = this.errors.length === 1 ? "1 error" : `${this.errors.length} errors`;
    return `${this.expectation}, but the page raised ${count}:\n${this.errors
      .map((error, index) => `  ${index + 1}. ${indented(error, "     ")}`)
      .join("\n")}`;
  }
}

/**
 * Fails when a scenario's collected page or console errors are not empty, with every message in
 * the failure (and so in the job log, the Vitest message and `result.json`), masked by
 * `failure-text.ts`. `expect(errors).toEqual([])` shows only how many there were.
 */
export const noPageErrors = (
  errors: ReadonlyArray<string>,
  expectation = "The page raises no errors",
): Effect.Effect<void, PageErrorsRaised> =>
  errors.length === 0
    ? Effect.void
    : Effect.fail(new PageErrorsRaised({ expectation, errors: errors.map(safeText) }));
