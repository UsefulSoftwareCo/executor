import { Effect, Option, Schema } from "effect";

import type { BetterAuthHandle } from "./better-auth";

// ---------------------------------------------------------------------------
// Human names for the credentials a request can arrive on — the API key's
// name, the MCP OAuth client's registered name — so the tool call log says
// "Claude Code" or "jean-mcp" rather than an opaque id.
//
// Looked up AFTER authentication succeeded, through Better Auth's own adapter
// (the same path `member-directory.ts` reads through), and only ever as audit
// metadata: a failed or slow lookup yields `null` and never fails the request.
// Cached briefly because an MCP client authenticates on every POST; a renamed
// key shows its new name within the TTL, which is all an audit label needs.
// ---------------------------------------------------------------------------

const TTL_MS = 5 * 60_000;
/** Bounded: entries are only created for credentials that already
 *  authenticated, but a cache with no ceiling is still a cache that grows. */
const MAX_ENTRIES = 500;

const NamedRow = Schema.Struct({ name: Schema.NullishOr(Schema.String) });
const decodeNamedRow = Schema.decodeUnknownOption(NamedRow);

export interface CredentialNames {
  /** The API key's name, by the key's own id. */
  readonly apiKeyName: (id: string) => Effect.Effect<string | null>;
  /** The OAuth client's registered `client_name`, by its client id. */
  readonly oauthClientName: (clientId: string) => Effect.Effect<string | null>;
}

export const makeCredentialNames = (auth: BetterAuthHandle["auth"]): CredentialNames => {
  const cache = new Map<string, { readonly name: string | null; readonly at: number }>();

  const lookup = (model: string, field: string, value: string): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const key = `${model}:${value}`;
      const hit = cache.get(key);
      if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.name;
      const { adapter } = yield* Effect.promise(() => auth.$context);
      const row = yield* Effect.tryPromise({
        try: () => adapter.findOne({ model, where: [{ field, value }] }),
        catch: () => "credential name lookup failed",
      });
      const name = Option.match(decodeNamedRow(row), {
        onNone: () => null,
        onSome: (decoded) => decoded.name ?? null,
      });
      if (cache.size >= MAX_ENTRIES) cache.clear();
      cache.set(key, { name, at: Date.now() });
      return name;
    }).pipe(
      // Audit metadata only: a lookup that fails leaves the label empty and
      // the request exactly as authenticated as it already was.
      Effect.orElseSucceed(() => null),
    );

  return {
    apiKeyName: (id) => lookup("apikey", "id", id),
    oauthClientName: (clientId) => lookup("oauthApplication", "clientId", clientId),
  };
};
