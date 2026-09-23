import type { OAuthSubmission } from "@executor-js/ui/contracts/credentials";
import { useAtomSet } from "@effect/atom-react";
import type { Atom } from "effect/unstable/reactivity";
import { Cause, Effect, Option, Schema } from "effect";
import {
  OAuthClientUnavailable,
  OAuthSetupFailed,
  type Account,
  type Provider,
  type AccountConnectionId,
  type OAuthStartResult,
} from "@executor-js/sdk";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import type { ConnectionGrant } from "@executor-js/local-server/account-connections";
import { OAuthFields as SharedFields, OAuthSetup } from "@executor-js/ui/dashboard/oauth-fields";
import { startOAuthAtom, oauthSetupAtom, type OAuthAppReturn } from "../../contracts/oauth.ts";
import { reconnectAccountAtom } from "../../contracts/accounts.ts";
import {
  startConnectionOAuthAtom,
  connectionOAuthSetupAtom,
} from "../../contracts/account-connections.ts";
import { openConnectionOAuth } from "../account-connections.ts";
import { openOAuth } from "../oauth.ts";
import { Failure } from "../components/common.tsx";

/** Local owns agent handoff grants, reconnect behavior, and the browser return intent. */
export function OAuthFields({
  provider,
  method,
  account,
  connection,
  onSaved,
  returnTo,
  onPendingChange,
  disabled = false,
}: {
  readonly provider: Provider;
  readonly method: string;
  readonly account?: Account;
  readonly connection?: ConnectionGrant;
  readonly onSaved: (account: Account) => void;
  readonly returnTo?: Omit<typeof OAuthAppReturn.Type, "connection">;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly disabled?: boolean;
}) {
  const start = useAtomSet(startOAuthAtom, { mode: "promiseExit" });
  const startConnection = useAtomSet(startConnectionOAuthAtom, { mode: "promiseExit" });
  const reconnect = useAtomSet(reconnectAccountAtom, { mode: "promiseExit" });
  type OAuthError = Effect.Error<
    Awaited<ReturnType<typeof start | typeof startConnection | typeof reconnect>>
  >;
  const query = connection
    ? connectionOAuthSetupAtom({ ...connection, method })
    : oauthSetupAtom({ provider: provider.id, method });
  return (
    <OAuthSetup<Atom.Failure<typeof query>> query={query}>
      {({ setup, action, refresh }) => (
        <SharedFields<OAuthStartResult & { readonly connection?: AccountConnectionId }, OAuthError>
          providerName={provider.definition.name}
          {...(account ? { account } : {})}
          Failure={Failure}
          setup={setup}
          setupAction={action}
          disabled={disabled}
          {...(onPendingChange ? { onPendingChange } : {})}
          redirectUri={new URL(OAuthCallbackPath, window.location.origin).href}
          requiresClient={(cause) => {
            const failure = Cause.findErrorOption(cause);
            const required =
              Option.isSome(failure) &&
              (Schema.is(OAuthClientUnavailable)(failure.value) ||
                (Schema.is(OAuthSetupFailed)(failure.value) &&
                  failure.value.reason === "invalid_client"));
            if (required) refresh();
            return required;
          }}
          start={({ label, ...client }: OAuthSubmission) =>
            connection
              ? startConnection({ payload: { ...connection, method, label, ...client } })
              : account
                ? reconnect({ params: { account: account.id }, payload: client })
                : start({ payload: { provider: provider.id, method, label, ...client } })
          }
          onAuthorized={(value) => {
            refresh();
            if (value.status === "completed") {
              onSaved(value.account);
              return;
            }
            if (connection) Effect.runSync(openConnectionOAuth(value.authorizationUrl, connection));
            else if (value.connection !== undefined)
              Effect.runSync(
                openOAuth(value.authorizationUrl, value.connection, account?.id, returnTo),
              );
          }}
        />
      )}
    </OAuthSetup>
  );
}
