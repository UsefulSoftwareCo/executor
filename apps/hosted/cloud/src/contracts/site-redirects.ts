import { Schema } from "effect";

export const siteRedirectLimits = { static: 2_000, dynamic: 100 } as const;

export class SiteRedirectLimitExceeded extends Schema.TaggedError<SiteRedirectLimitExceeded>()(
  "SiteRedirectLimitExceeded",
  { kind: Schema.Literals(["static", "dynamic"]), count: Schema.Int, limit: Schema.Int },
) {}
