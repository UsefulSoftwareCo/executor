import { dashboardHttpClient } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import {
  AccountConnectApi,
  ConnectionGrant,
  type ConnectionOAuthStart,
  type ConnectionSubmission,
} from "@executor-js/local-server/account-connections";
import { HttpUrl } from "@executor-js/sdk";
import { Data, Effect, Schema } from "effect";
import { Atom, AtomHttpApi } from "effect/reactivity";

export class ConnectionClient extends AtomHttpApi.Service<ConnectionClient>()("ConnectionClient", {
  api: AccountConnectApi,
  httpClient: dashboardHttpClient,
}) {}
export const ConnectionEntry = Schema.Struct({
  ...ConnectionGrant.fields,
  callbackUrl: Schema.optional(Schema.RedactedFromValue(HttpUrl)),
});
export type ConnectionEntry = typeof ConnectionEntry.Type;
export const connectionEntryAtom = Atom.make<ConnectionEntry | undefined>(undefined).pipe(
  Atom.keepAlive,
);
const connectionCompletionAtom = ConnectionClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      const entry = get(connectionEntryAtom);
      if (entry === undefined || entry.callbackUrl === undefined) return undefined;
      const client = yield* ConnectionClient;
      return yield* client.accountConnect
        .completeOAuth({ payload: { ...entry, callbackUrl: entry.callbackUrl } })
        .pipe(Effect.result);
    }),
  )
  .pipe(Atom.keepAlive);
export const connectionDetailsAtom = ConnectionClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      const entry = get(connectionEntryAtom);
      if (entry === undefined) return undefined;
      const completion = yield* get.result(connectionCompletionAtom);
      const client = yield* ConnectionClient;
      const connection = yield* client.accountConnect.read({ payload: entry });
      return { connection, completion };
    }),
  )
  .pipe(Atom.keepAlive);
const reloadConnection = (get: Atom.FnContext | Atom.AtomContext) =>
  Effect.sync(() => get.registry.refresh(connectionDetailsAtom));
export const submitConnectionAtom = ConnectionClient.runtime.fn(
  (payload: typeof ConnectionSubmission.Type, get) =>
    Effect.flatMap(ConnectionClient, (client) => client.accountConnect.submit({ payload })).pipe(
      Effect.tapErrorTag("AccountConnectionTargetChanged", () => reloadConnection(get)),
    ),
);
export const cancelConnectionAtom = ConnectionClient.mutation("accountConnect", "cancel");
class ConnectionSetupKey extends Data.Class<ConnectionGrant & { readonly method: string }> {}
const connectionSetup = Atom.family((key: ConnectionSetupKey) =>
  ConnectionClient.runtime
    .atom((get) =>
      Effect.flatMap(ConnectionClient, (client) =>
        client.accountConnect.oauthSetup({ payload: key }),
      ).pipe(
        Effect.tapErrorTag("AccountConnectionTargetChanged", () => reloadConnection(get)),
        Effect.catchTag(["HttpClientError", "SchemaError"], Effect.die),
      ),
    )
    .pipe(Atom.setIdleTTL("5 minutes"), revalidated),
);
export const connectionOAuthSetupAtom = (key: ConnectionGrant & { readonly method: string }) =>
  connectionSetup(new ConnectionSetupKey(key));
export const startConnectionOAuthAtom = ConnectionClient.runtime.fn(
  (payload: typeof ConnectionOAuthStart.Type, get) =>
    Effect.flatMap(ConnectionClient, (client) =>
      client.accountConnect.startOAuth({ payload }),
    ).pipe(Effect.tapErrorTag("AccountConnectionTargetChanged", () => reloadConnection(get))),
);
