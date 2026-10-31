/** Hosted commands keep each request's product authorization and reviewed account destination. */
import { Effect } from "effect";
import type { AccountScope, AppId, OAuthClientSelection } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { IdentityConsentSelection } from "@executor-js/ui/contracts/identity-consent";
import { identityRequests } from "@executor-js/ui/contracts/identity-requests";
import { HostedClient } from "./api.ts";
import { refreshResourceDirectory } from "./resource-access.ts";
import { refreshAppLinks } from "./app-accounts.ts";

export const identityConsentAtoms = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly scope: AccountScope;
  readonly requirement: string;
}) => {
  const prepare = identityRequests(key, (target) =>
    Effect.gen(function* () {
      const client = yield* HostedClient;
      const request = {
        params: {
          organization: key.organization,
          app: target.app,
          requirement: target.requirement,
        },
        payload: {},
      };
      return yield* target.scope === "app"
        ? client.appAccounts.appConnect(request)
        : client.appAccounts.userConnect(request);
    }),
  );
  return {
    plan: HostedClient.runtime.fn((input: IdentityConsentSelection & { readonly method: string }) =>
      Effect.gen(function* () {
        const { connection, ...selection } = yield* prepare(input);
        return yield* (yield* HostedClient).accounts.planOAuth({
          params: { organization: key.organization, connection },
          payload: { ...selection, method: input.method },
        });
      }),
    ),
    reuse: HostedClient.runtime.fn(
      (
        input: IdentityConsentSelection & {
          readonly method: string;
          readonly sourceAccount: NonNullable<IdentityConsentSelection["sourceAccount"]>;
        },
        get,
      ) =>
        Effect.gen(function* () {
          const { connection, additionalConnections } = yield* prepare(input);
          const result = yield* (yield* HostedClient).accounts.reuseOAuth({
            params: { organization: key.organization, connection },
            payload: { additionalConnections, method: input.method, account: input.sourceAccount },
          });
          if (result.status === "completed") {
            refreshResourceDirectory(get, key.organization);
            refreshAppLinks(get, { organization: key.organization, app: key.app });
          }
          return result;
        }),
    ),
    start: HostedClient.runtime.fn(
      (
        input: IdentityConsentSelection & {
          readonly method: string;
          readonly client?: OAuthClientSelection | undefined;
        },
      ) =>
        Effect.gen(function* () {
          const { connection, ...selection } = yield* prepare(input);
          const signIn = yield* (yield* HostedClient).accounts.startOAuth({
            params: { organization: key.organization, connection },
            payload: {
              ...selection,
              method: input.method,
              ...(input.client === undefined ? {} : { client: input.client }),
            },
          });
          return { ...signIn, connection };
        }),
    ),
  };
};
