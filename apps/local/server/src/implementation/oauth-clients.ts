/**
 * Local has one person, so every client is theirs: a browser sign-in client they enter is kept
 * once its sign-in succeeds, and automatic clients are registered under the connection's owner.
 */
import {
  OAuthAutomaticClient,
  OAuthClientReference,
  type AccountConnection,
  type Executor,
  type OAuthClientChoice,
  type OAuthClientSelection,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";

/** The method's setup and the entered clients kept for the server it signs in at. */
export const connectOptions = (
  executor: Executor,
  input: Parameters<Executor["accountConnections"]["oauthSetup"]>[0],
) =>
  Effect.gen(function* () {
    const setup = yield* executor.accountConnections.oauthSetup(input);
    // Automatic clients are offered as the automatic choice; machine clients are never kept.
    const clients =
      setup.grant === "client_credentials"
        ? []
        : (yield* executor.oauthClients.list({
            owner: input.owner,
            issuer: setup.issuer,
          })).filter((client) => client.source === "manual");
    return { ...setup, clients };
  });

/**
 * The client a connection names. Without a choice, the SDK signs in automatically, or a reconnect
 * keeps its account's client. An entered browser client is kept once its sign-in succeeds.
 */
export const connectionClient = (
  connection: AccountConnection,
  input: { readonly method: string; readonly client?: OAuthClientSelection | undefined },
) =>
  Effect.sync((): OAuthClientChoice | undefined => {
    const selected = input.client;
    if (
      selected === undefined ||
      Schema.is(OAuthAutomaticClient)(selected) ||
      Schema.is(OAuthClientReference)(selected)
    )
      return selected;
    const method = Object.hasOwn(connection.provider.definition.auth, input.method)
      ? connection.provider.definition.auth[input.method]
      : undefined;
    const machine = method?.type === "oauth2" && method.grant === "client_credentials";
    return { ...selected, ...(machine ? {} : { save: true }) };
  });
