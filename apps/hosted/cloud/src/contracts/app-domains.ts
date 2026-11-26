import { Schema } from "effect";

export const AppDomainZoneSettings = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  domain: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u)),
});
