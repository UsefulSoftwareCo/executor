/** Transport contracts for the shared account dialog. The UI owns presentation and polling. */
import type { Account, AccountConnection, AccountConnectionId } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { HostedClient } from "./api.ts";
import type { HostedError } from "./errors.ts";
import { acknowledgeInteractiveConnection } from "./apps.ts";

class ConnectionKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly connection: AccountConnectionId;
}> {}
type Key = ConstructorParameters<typeof ConnectionKey>[0];

/** Build the same actions for a dialog that creates its pending request lazily. */
export function interactiveConnectionActions(
  organization: OrganizationReference,
  connection: (get: Atom.FnContext) => Effect.Effect<AccountConnection, HostedError, HostedClient>,
  saved: (get: Atom.FnContext, connection: AccountConnectionId, account: Account) => void,
  cancelled?: (get: Atom.FnContext) => void,
) {
  const progress = (step: "status" | "submit", value: string | undefined, get: Atom.FnContext) =>
    Effect.gen(function* () {
      const pending = yield* connection(get);
      const client = yield* HostedClient;
      const params = { organization, connection: pending.id };
      const result = yield* step === "status"
        ? client.accounts.interactiveStatus({ params })
        : client.accounts.submitInteractive({ params, payload: { value: value ?? "" } });
      if (result.state === "connected") saved(get, pending.id, result.account);
      return result;
    });
  return {
    start: HostedClient.runtime.fn((payload: { readonly method: string }, get) =>
      Effect.gen(function* () {
        const pending = yield* connection(get);
        const client = yield* HostedClient;
        return yield* client.accounts.startInteractive({
          params: { organization, connection: pending.id },
          payload,
        });
      }),
    ),
    status: HostedClient.runtime.fn((_: void, get) => progress("status", undefined, get)),
    submit: HostedClient.runtime.fn((payload: { readonly value: string }, get) =>
      progress("submit", payload.value, get),
    ),
    cancel: HostedClient.runtime.fn((_: void, get) =>
      Effect.gen(function* () {
        const pending = yield* connection(get);
        const client = yield* HostedClient;
        yield* client.accounts.cancelInteractive({
          params: { organization, connection: pending.id },
        });
        cancelled?.(get);
      }),
    ),
  };
}

const actions = Atom.family((key: ConnectionKey) =>
  interactiveConnectionActions(
    key.organization,
    () => Effect.flatMap(HostedClient, (client) => client.accounts.connection({ params: key })),
    (get, _connection, account) => acknowledgeInteractiveConnection(get, key, account),
  ),
);
/** { method } -> { url?, code?, paste?, expiresAt?, message? }. */
export const startInteractiveConnectionAtom = (key: Key) => actions(new ConnectionKey(key)).start;
/** void -> waiting | connected with Account | failed with message. Invoke when polling is due. */
export const interactiveConnectionStatusAtom = (key: Key) => actions(new ConnectionKey(key)).status;
/** { value } -> the same progress union as status. */
export const submitInteractiveConnectionAtom = (key: Key) => actions(new ConnectionKey(key)).submit;
/** void -> void. Closing the dialog cancels its server-held session. */
export const cancelInteractiveConnectionAtom = (key: Key) => actions(new ConnectionKey(key)).cancel;
