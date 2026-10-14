/**
 * The v1 sign-in check's three deployment settings (`notes/hosted-auth.md`), shared by the CI
 * stack that stores them for production and the Worker that reads them. Production (`v2`)
 * requires all three. Only production reaches v1's database, so the check is off on other
 * deployed stages.
 */
import { Schema, SchemaTransformation } from "effect";

/** v1's production WorkOS API key in the Agents vault ("Work OS API Key Prod"). A reference only. */
export const v1WorkosKeyReference = "op://Agents/svyzpaqa3tfi27ckajfyjwp66a/credential";

/** An instant written as an ISO 8601 UTC timestamp, such as 2026-10-08T00:00:00Z. */
export const CheckSince = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/u),
).pipe(Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString));

const storedBy =
  "and run `bun run ci:deploy`, which stores it in the GitHub production environment that " +
  "`.github/workflows/deploy.yml` passes to the Worker";

/** What to set when production has no v1 WorkOS key. */
export const missingV1WorkosKey =
  "V1_WORKOS_API_KEY is required on the production stage (v2): add " +
  `\`V1_WORKOS_API_KEY=${v1WorkosKeyReference}\` to .env.ci.op ${storedBy}.`;

/** What to set when production has no cutoff, or one that does not parse. */
export const missingV1MembershipCheckSince =
  "V1_MEMBERSHIP_CHECK_SINCE is required on the production stage (v2): set it in .env.ci.op to " +
  "the ISO 8601 UTC instant the v1 sign-in check ships, the deploy time of the merge that turns " +
  `it on (for example \`V1_MEMBERSHIP_CHECK_SINCE=2026-10-09T17:00:00Z\`), ${storedBy}.`;

/** What to set when production does not name v1's database. */
export const missingV1PlanetscaleDatabase =
  "V1_PLANETSCALE_DATABASE_NAME is required on the production stage (v2): set it in .env.ci.op " +
  "to v1's PlanetScale database (`V1_PLANETSCALE_DATABASE_NAME=executor`), on which the deploy " +
  `creates a role that inherits only \`pg_read_all_data\`, ${storedBy}.`;
