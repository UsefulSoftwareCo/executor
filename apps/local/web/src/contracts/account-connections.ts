/** Typed browser handoff. Submitted credentials remain redacted in mutation state. */
import { AccountConnectApi, ConnectionGrant } from "@executor-js/local-server/account-connections";
import { HttpUrl } from "@executor-js/sdk";
import { Data, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";

/** Only a connection grant authenticates these calls; no dashboard session is needed. */
export class ConnectionClient extends AtomHttpApi.Service<ConnectionClient>()("ConnectionClient", {
  api: AccountConnectApi,
  httpClient: FetchHttpClient.layer,
}) {}
/** OAuth callback URLs exist in memory only and are removed from the address bar at startup. */
export const ConnectionEntry = Schema.Struct({
  ...ConnectionGrant.fields,
  callbackUrl: Schema.optional(Schema.RedactedFromValue(HttpUrl)),
});
export type ConnectionEntry = typeof ConnectionEntry.Type;
/** Bootstrap capability for this document, never a global Executor API key. */
export const connectionEntryAtom = Atom.make<ConnectionEntry | undefined>(undefined).pipe(
  Atom.keepAlive,
);
/** Complete once per document, including React remounts, then load public request metadata. */
export const connectionDetailsAtom = ConnectionClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      const entry = get(connectionEntryAtom);
      if (entry === undefined) return undefined;
      const client = yield* ConnectionClient;
      const completion =
        entry.callbackUrl === undefined
          ? undefined
          : yield* client.accountConnect
              .completeOAuth({ payload: { ...entry, callbackUrl: entry.callbackUrl } })
              .pipe(Effect.result);
      const connection = yield* client.accountConnect.read({ payload: entry });
      return { connection, completion };
    }),
  )
  .pipe(Atom.keepAlive);
/** Idempotent saves return account metadata only. */
export const submitConnectionAtom = ConnectionClient.mutation("accountConnect", "submit");
/** Cancellation closes the same request observed by the agent. */
export const cancelConnectionAtom = ConnectionClient.mutation("accountConnect", "cancel");
class ConnectionSetupKey extends Data.Class<ConnectionGrant & { readonly method: string }> {}
const connectionSetup = Atom.family((key: ConnectionSetupKey) =>
  ConnectionClient.query("accountConnect", "oauthSetup", { payload: key }).pipe(
    Atom.setIdleTTL("5 minutes"),
    Atom.refreshOnWindowFocus,
  ),
);
/** Setup metadata is limited to the exact connection grant supplied by this page. */
export const connectionOAuthSetupAtom = (key: ConnectionGrant & { readonly method: string }) =>
  connectionSetup(new ConnectionSetupKey(key));
/** Start provider consent with the host's fixed redirect URI. */
export const startConnectionOAuthAtom = ConnectionClient.mutation("accountConnect", "startOAuth");
