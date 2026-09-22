import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { Schema } from "effect";
import { OnboardingEntry } from "./onboarding.ts";

/** Private document data contains display identity and setup metadata, never session credentials. */
export const CloudEntryPage = Schema.Struct({
  kind: Schema.Literal("page"),
  path: Schema.Literals(["/login", "/create", "/"]),
  session: BrowserSession,
  onboarding: Schema.NullOr(OnboardingEntry),
});
export type CloudEntryPage = typeof CloudEntryPage.Type;
/** The server selects a document or a validated internal return destination before rendering. */
export const CloudEntry = Schema.Union([
  CloudEntryPage,
  Schema.Struct({ kind: Schema.Literal("redirect"), location: Schema.String }),
]);
export type CloudEntry = typeof CloudEntry.Type;
