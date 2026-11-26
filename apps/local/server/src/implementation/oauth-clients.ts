import {
  OAuthAutomaticClient,
  OAuthClientReference,
  type AccountConnection,
  type Executor,
  type OAuthClientChoice,
  type OAuthClientSelection,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";

export const connectOptions = (
  executor: Executor,
  input: Parameters<Executor["accountConnections"]["oauthSetup"]>[0],
) =>
  Effect.gen(function* () {
    const setup = yield* executor.accountConnections.oauthSetup(input);
    const clients =
      setup.grant === "client_credentials"
        ? []
        : (yield* executor.oauthClients.list({
            owner: input.owner,
            issuer: setup.issuer,
          })).filter((client) => client.source === "manual");
    return { ...setup, clients };
  });

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
