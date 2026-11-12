/** How an invocation of an app that reads its host's API is bound to one revision of it. */
import { Schema } from "effect";

/**
 * The host API revision an invocation's app cache belongs to, and the URLs its document is served
 * at. The runner fills that cache only through a network that refuses a document from one of
 * `documents` whose SHA-256 is not `revision`, so the cache never holds another revision's API
 * under this one's name, whichever of the caller and the API deploys first. A facet's network is
 * bound the same way, so a database call is checked as an app Worker's call is.
 */
export const HostApiCheck = Schema.Struct({
  revision: Schema.NonEmptyString,
  documents: Schema.Array(Schema.NonEmptyString),
});
export type HostApiCheck = typeof HostApiCheck.Type;
