import { Effect, Schema } from "effect";
import { indented, safeText } from "./failure-text.ts";

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

export const noPageErrors = (
  errors: ReadonlyArray<string>,
  expectation = "The page raises no errors",
): Effect.Effect<void, PageErrorsRaised> =>
  errors.length === 0
    ? Effect.void
    : Effect.fail(new PageErrorsRaised({ expectation, errors: errors.map(safeText) }));
