import { usePageUrl } from "@executor-js/dashboard-start/page";
import type { AccountOAuthProps, OAuthSubmission } from "@executor-js/ui/contracts/credentials";
import type { FailureProps } from "@executor-js/ui/contracts/dashboard";
import { useState } from "react";
import type { AccountId, AccountScope } from "@executor-js/sdk";
import type { IdentityConsentSelection } from "@executor-js/ui/contracts/identity-consent";
import { IdentityConsent } from "@executor-js/ui/dashboard/identity-consent";
import { identityConsentAtoms } from "../../contracts/identity-consent.ts";
import { overviewAtom } from "../../contracts/api.ts";
import { useAtomSet } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { ComponentType, ReactNode } from "react";
import {
  OAuthClientUnavailable,
  OAuthSetupFailed,
  oauthClientEntryReasons,
  type Account,
  type AppId,
  type Provider,
  type OAuthStartResult,
} from "@executor-js/sdk";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import type { ConnectionGrant } from "@executor-js/local-server/account-connections";
import { OAuthFields as SharedFields, OAuthSetup } from "@executor-js/ui/dashboard/oauth-fields";
import { oauthSetupAtom } from "../../contracts/oauth.ts";
import type { appConnectionAtoms } from "../../contracts/app-connections.ts";
import {
  startConnectionOAuthAtom,
  connectionOAuthSetupAtom,
} from "../../contracts/account-connections.ts";
import { openConnectionOAuth } from "../account-connections.ts";
import { openOAuth } from "../oauth.ts";
import { ConnectionLinkFailure, Failure } from "../components/common.tsx";

type FieldsProps = AccountOAuthProps & {
  readonly provider: Provider;
  readonly account?: Account;
  /** Where the sign-in goes once saved; the shared form shows it above Connect. */
  readonly access?: ReactNode;
};

/** A sign-in for an app requirement on its app page; the browser returns to that app. */
export function AppOAuthFields({
  app,
  scope,
  requirement,
  initialAccount,
  atoms,
  onSaved,
  ...props
}: FieldsProps & {
  readonly app: AppId;
  readonly scope: AccountScope;
  readonly requirement: string;
  readonly initialAccount?: AccountId | undefined;
  readonly atoms: ReturnType<typeof appConnectionAtoms>;
  readonly onSaved: (account: Account) => void;
}) {
  const start = useAtomSet(atoms.startOAuth, { mode: "promiseExit" });
  const [identityAtoms] = useState(() => identityConsentAtoms({ app, scope, requirement }));
  const plan = useAtomSet(identityAtoms.plan, { mode: "promiseExit" });
  const reuse = useAtomSet(identityAtoms.reuse, { mode: "promiseExit" });
  const authorize = useAtomSet(identityAtoms.start, { mode: "promiseExit" });
  const reconnect = props.account !== undefined;
  const fields = (selection: IdentityConsentSelection) => (
    <Fields
      {...props}
      query={oauthSetupAtom({ provider: props.provider.id, method: props.method })}
      Failure={Failure}
      start={(client) =>
        reconnect
          ? start({ method: props.method, ...client })
          : authorize({ ...selection, method: props.method, ...client })
      }
      onSaved={onSaved}
      open={(authorizationUrl) => openOAuth(authorizationUrl, { app, reconnect })}
    />
  );
  if (reconnect) return fields({});
  return (
    <IdentityConsent
      query={overviewAtom}
      Failure={Failure}
      provider={props.provider}
      method={props.method}
      app={app}
      initialAccount={initialAccount}
      disabled={props.disabled}
      onPendingChange={props.onPendingChange}
      plan={plan}
      reuse={reuse}
      start={(selection) => authorize({ method: props.method, ...selection })}
      onSaved={onSaved}
      onAuthorized={(value) => {
        if (value.status === "completed") onSaved(value.account);
        else Effect.runSync(openOAuth(value.authorizationUrl, { app, reconnect: false }));
      }}
    >
      {(selection) => fields(selection)}
    </IdentityConsent>
  );
}

/** A sign-in on an agent's connection link page, which keeps its grant across the redirect. */
export function LinkOAuthFields({
  grant,
  onSaved,
  ...props
}: FieldsProps & {
  readonly grant: ConnectionGrant;
  readonly onSaved: (account: Account) => void;
}) {
  const start = useAtomSet(startConnectionOAuthAtom, { mode: "promiseExit" });
  return (
    <Fields
      {...props}
      query={connectionOAuthSetupAtom({ ...grant, method: props.method })}
      Failure={ConnectionLinkFailure}
      start={(client) => start({ ...grant, method: props.method, ...client })}
      onSaved={onSaved}
      open={(authorizationUrl) => openConnectionOAuth(authorizationUrl, grant)}
    />
  );
}

function Fields<E, S extends OAuthStartResult = OAuthStartResult>({
  provider,
  account,
  onSaved,
  onPendingChange,
  access,
  disabled,
  query,
  Failure,
  start,
  open,
}: FieldsProps & {
  readonly query: Parameters<typeof OAuthSetup>[0]["query"];
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly start: (client: OAuthSubmission) => Promise<Exit.Exit<S, E>>;
  readonly onSaved: (account: Account, started: S) => void;
  readonly open: (authorizationUrl: string, started: S) => Effect.Effect<void>;
}) {
  const page = usePageUrl();
  return (
    <OAuthSetup<Atom.Failure<typeof query>> query={query}>
      {({ setup, action, refresh }) => (
        <SharedFields<S, E>
          providerName={provider.definition.name}
          {...(account ? { account } : {})}
          Failure={Failure}
          setup={setup}
          setupAction={action}
          access={access}
          disabled={disabled}
          onPendingChange={onPendingChange}
          redirectUri={new URL(OAuthCallbackPath, page.origin).href}
          requiresClient={(cause) => {
            const failure = Cause.findErrorOption(cause);
            const required =
              Option.isSome(failure) &&
              (Schema.is(OAuthClientUnavailable)(failure.value) ||
                (Schema.is(OAuthSetupFailed)(failure.value) &&
                  oauthClientEntryReasons.has(failure.value.reason)));
            if (required) refresh();
            return required;
          }}
          start={start}
          onAuthorized={(value) => {
            refresh();
            if (value.status === "completed") {
              onSaved(value.account, value);
              return "done";
            }
            Effect.runSync(open(value.authorizationUrl, value));
            return "navigating";
          }}
        />
      )}
    </OAuthSetup>
  );
}
