import type {
  Connection,
  OAuthClientSlug,
  OAuthClientSummary,
  Owner,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// OAuth client (registered app) usage — which connections a given app backs.
//
// Connections that were minted through an OAuth flow carry the slug of the app
// that minted them (`oauthClient`) plus that app's owner (`oauthClientOwner`).
// Removing an app NEVER cascades into its connections — an orphaned connection
// keeps its stored slug and surfaces a reconnect prompt at its next token
// refresh — so the remove flow only WARNS, using this map to list what breaks.
// ---------------------------------------------------------------------------

/** owner+slug key — a connection can reference either a personal or workspace
 *  app with the same slug, so owner is part of the key. */
const oauthClientUsageKey = (owner: Owner | null | undefined, slug: OAuthClientSlug): string =>
  `${owner ?? "org"}\0${String(slug)}`;

/** Build an owner+slug → connections map so each app can show what it backs.
 *  Static connections (null `oauthClient`) are skipped. */
export function buildUsageMap(
  connections: readonly Connection[],
): ReadonlyMap<string, readonly Connection[]> {
  const map = new Map<string, Connection[]>();
  for (const connection of connections) {
    const slug = connection.oauthClient;
    if (slug == null) continue;
    const key = oauthClientUsageKey(connection.oauthClientOwner, slug);
    const existing = map.get(key);
    if (existing) existing.push(connection);
    else map.set(key, [connection]);
  }
  return map;
}

/** Connections backing one app, or an empty array. */
export function connectionsUsingClient(
  usage: ReadonlyMap<string, readonly Connection[]>,
  client: Pick<OAuthClientSummary, "owner" | "slug">,
): readonly Connection[] {
  return usage.get(oauthClientUsageKey(client.owner, client.slug)) ?? [];
}
