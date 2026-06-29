import type { ConnectionName, Owner } from "@executor-js/sdk/shared";
import { connectionIdentifier } from "@executor-js/react/lib/connection-name";

// ---------------------------------------------------------------------------
// v2 connection-create defaults for the GraphQL plugin. v1's HTTP-credentials
// editor (header/query secret slots bound per source per scope) is gone: a
// connection IS the credential, applied to the integration's auth template.
// ---------------------------------------------------------------------------

/** Deterministic connection name for a GraphQL integration + owner. Keeps a
 *  single owner-scoped credential per integration so re-adding overwrites
 *  rather than accumulating duplicates. */
export const graphqlConnectionName = (slug: string, owner: Owner): ConnectionName =>
  connectionIdentifier(`${slug} ${owner}`);
