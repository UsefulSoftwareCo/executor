import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { Schema } from "effect";
import { OnboardingEntry } from "./onboarding.ts";

export const CloudEntryPage = Schema.Struct({
  kind: Schema.Literal("page"),
  path: Schema.Literals(["/login", "/login/sso", "/create", "/"]),
  session: BrowserSession,
  onboarding: Schema.NullOr(OnboardingEntry),
  passkeyEnrollment: Schema.Boolean,
});
export type CloudEntryPage = typeof CloudEntryPage.Type;
export const CloudEntry = Schema.Union([
  CloudEntryPage,
  Schema.Struct({ kind: Schema.Literal("redirect"), location: Schema.String }),
]);
export type CloudEntry = typeof CloudEntry.Type;
