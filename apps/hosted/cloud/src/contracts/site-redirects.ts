import { Schema } from "effect";

/** Cloudflare Workers Static Assets limits for a deployed _redirects file. */
export const siteRedirectLimits = { static: 2_000, dynamic: 100 } as const;

/** Reject a site build that Cloudflare would refuse to publish. */
export class SiteRedirectLimitExceeded extends Schema.TaggedError<SiteRedirectLimitExceeded>()(
  "SiteRedirectLimitExceeded",
  { kind: Schema.Literals(["static", "dynamic"]), count: Schema.Int, limit: Schema.Int },
) {}
