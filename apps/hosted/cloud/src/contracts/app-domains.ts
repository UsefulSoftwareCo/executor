/** Public zone configuration crosses the Alchemy-to-Worker boundary as one parsed JSON value. */
import { Schema } from "effect";

/** Cloudflare identifiers and the authoritative suffix owned by the shared stack. */
export const AppDomainZoneSettings = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  domain: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)),
});
