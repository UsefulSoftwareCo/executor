import type { HostedError } from "../../contracts/errors.ts";
import type { AccountSubmission, OAuthSubmission } from "@executor-js/ui/contracts/credentials";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import { useAtomSet } from "@effect/atom-react";
import { AccountConnectionId, type Account, type Provider } from "@executor-js/sdk";
import type {
  HostedAccountConnection,
  HostedOAuthSignIn,
  HostedOAuthStartResult,
} from "@executor-js/hosted-server";
import { Link, useNavigate } from "@tanstack/react-router";
import { Cause, Match, Option, Exit, Schema } from "effect";
import { useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { OAuthFields, OAuthSetup } from "@executor-js/ui/dashboard/oauth-fields";
import { ProviderIcon } from "@executor-js/ui/dashboard/common";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { AccountForm } from "@executor-js/ui/dashboard/account-form";
import {
  connectionAtom,
  oauthSetupAtom,
  startOAuthAtom,
  submitConnectionAtom,
  PendingOAuth,
} from "../../contracts/apps.ts";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Retain only the return context; OAuth state and credentials remain owned by the server. */
export function openAccountOAuth(pending: typeof PendingOAuth.Type, authorizationUrl: string) {
  sessionStorage.setItem("executor:hosted:oauth", JSON.stringify(pending));
  window.location.assign(authorizationUrl);
}

/** Standalone connection links remain available for agent handoffs and reconnects. */
export function ConnectAccountPage({
  connectionId,
  client,
}: {
  readonly connectionId: string;
  readonly client?: "change" | undefined;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const [pending] = useState(() =>
    Schema.decodeUnknownOption(Schema.fromJsonString(PendingOAuth))(
      sessionStorage.getItem("executor:hosted:oauth"),
    ),
  );
  const label =
    Option.isSome(pending) && pending.value.connection === connectionId
      ? pending.value.label
      : undefined;
  return (
    <section className="mx-auto w-full max-w-xl p-6 max-[740px]:p-4">
      <QueryView
        query={connectionAtom({ organization, connection: AccountConnectionId.make(connectionId) })}
        Failure={HostedFailure}
        pending={<DetailSkeleton label="Loading account setup" />}
      >
        {(connection) => (
          <>
            {connection.target ? (
              <Link
                className="mb-6 inline-flex text-sm text-muted-foreground"
                to="/org/$organizationSlug/apps/$appId"
                params={{ organizationSlug, appId: connection.target.app }}
                search={{ view: "accounts" }}
              >
                ← {connection.target.name}
              </Link>
            ) : connection.reconnectAccount ? (
              <Link
                className="mb-6 inline-flex text-sm text-muted-foreground"
                to="/org/$organizationSlug/accounts/$accountId"
                params={{ organizationSlug, accountId: connection.reconnectAccount.id }}
              >
                ← Account
              </Link>
            ) : (
              <Link
                className="mb-6 inline-flex text-sm text-muted-foreground"
                to="/org/$organizationSlug/accounts"
                params={{ organizationSlug }}
              >
                ← Accounts
              </Link>
            )}
            <div className="mb-4 flex items-center gap-3">
              <ProviderIcon
                name={connection.provider.definition.name}
                url={providerDisplayUrl(connection.provider.definition)}
                large
              />
              <h1 className="text-xl font-semibold">
                {connection.reconnectAccount ? "Reconnect" : "Connect"}{" "}
                {connection.provider.definition.name}
              </h1>
            </div>
            <ConnectionFields
              key={connectionId}
              connection={connection}
              manualClient={client === "change"}
              initialLabel={label}
              onSaved={(account) => {
                void navigate(
                  connection.target
                    ? {
                        to: "/org/$organizationSlug/apps/$appId",
                        params: { organizationSlug, appId: connection.target.app },
                        search: { view: "accounts" },
                      }
                    : {
                        to: "/org/$organizationSlug/accounts/$accountId",
                        params: { organizationSlug, accountId: account.id },
                      },
                );
              }}
            />
          </>
        )}
      </QueryView>
    </section>
  );
}

/** The same credential fields serve an in-app dialog and a standalone connection link. */
export function ConnectionFields({
  connection,
  onSaved,
  initialMethod,
  initialLabel,
  manualClient,
  onPendingChange,
}: {
  readonly connection: HostedAccountConnection;
  readonly onSaved: (account: Account) => void;
  readonly initialMethod?: string | undefined;
  readonly initialLabel?: string | undefined;
  readonly manualClient?: boolean | undefined;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const params = { organization, connection: connection.id };
  const submit = useAtomSet(submitConnectionAtom(params), { mode: "promiseExit" });
  const startOAuth = useAtomSet(startOAuthAtom(params), { mode: "promiseExit" });
  if (connection.state.status !== "pending")
    return (
      <>
        <p className="text-sm">
          {connection.state.status === "completed"
            ? "Account connected."
            : "This connection has expired. Start a new connection from the app."}
        </p>
        {connection.target && (
          <Button asChild variant="outline">
            <Link
              to="/org/$organizationSlug/apps/$appId"
              params={{ organizationSlug, appId: connection.target.app }}
              search={{ view: "accounts" }}
            >
              Back to app
            </Link>
          </Button>
        )}
      </>
    );
  return (
    <HostedAccountForm
      provider={connection.provider}
      {...(connection.reconnectAccount ? { account: connection.reconnectAccount } : {})}
      redirectUri={connection.redirectUri}
      initialMethod={initialMethod}
      initialLabel={initialLabel}
      manualClient={manualClient}
      submit={submit}
      start={startOAuth}
      onSaved={onSaved}
      {...(onPendingChange ? { onPendingChange } : {})}
      onAuthorized={(value) =>
        openAccountOAuth(
          {
            organization,
            organizationSlug,
            connection: connection.id,
            app: connection.target?.app ?? null,
            redirectUri: value.redirectUri,
            label: value.label,
            manualClient: value.manualClient,
          },
          value.authorizationUrl,
        )
      }
    />
  );
}

/** Render known provider metadata; the caller owns creating or resuming the connection attempt. */
export function HostedAccountForm<A extends HostedOAuthSignIn>({
  provider,
  account,
  redirectUri,
  initialMethod,
  initialLabel,
  manualClient,
  submit,
  start,
  onSaved,
  onAuthorized,
  onPendingChange,
}: {
  readonly provider: Provider;
  readonly account?: Account;
  readonly redirectUri: string;
  readonly initialMethod?: string | undefined;
  readonly initialLabel?: string | undefined;
  readonly manualClient?: boolean | undefined;
  readonly submit: (input: AccountSubmission) => Promise<Exit.Exit<Account, HostedError>>;
  readonly start: (
    input: OAuthSubmission & { readonly method: string },
  ) => Promise<
    Exit.Exit<A | Extract<HostedOAuthStartResult, { status: "completed" }>, HostedError>
  >;
  readonly onSaved: (account: Account) => void;
  readonly onAuthorized: (
    value: A & { readonly label: string; readonly manualClient: boolean },
  ) => void;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const { organization } = useOrganizationRoute();
  return (
    <AccountForm
      provider={provider}
      {...(account ? { account } : {})}
      initialMethod={initialMethod}
      initialLabel={initialLabel}
      Failure={HostedFailure}
      submitLabel={account ? "Save credentials" : "Connect account"}
      submit={submit}
      onSaved={onSaved}
      {...(onPendingChange ? { onPendingChange } : {})}
      oauth={({ method, disabled, onPendingChange }) => (
        <OAuthSetup query={oauthSetupAtom({ organization, provider: provider.id, method })}>
          {({ setup, blocked, refresh }) => (
            <OAuthFields
              providerName={provider.definition.name}
              Failure={HostedFailure}
              setup={setup}
              disabled={disabled || blocked}
              manualClient={manualClient}
              initialLabel={initialLabel}
              {...(account ? { account } : {})}
              redirectUri={redirectUri}
              onPendingChange={onPendingChange}
              requiresClient={(cause) => {
                const required = Option.exists(Cause.findErrorOption(cause), (error) =>
                  Match.value(error).pipe(
                    Match.tag("OAuthClientUnavailable", () => true),
                    Match.tag("OAuthSetupFailed", (error) => error.reason === "invalid_client"),
                    Match.orElse(() => false),
                  ),
                );
                if (required) refresh();
                return required;
              }}
              start={(input: OAuthSubmission) =>
                start({ method, ...input }).then((exit) =>
                  Exit.map(exit, (value) => ({
                    ...value,
                    label: input.label,
                    manualClient: input.client !== undefined,
                  })),
                )
              }
              onAuthorized={(value) => {
                refresh();
                if (value.status === "completed") onSaved(value.account);
                else onAuthorized(value);
              }}
            />
          )}
        </OAuthSetup>
      )}
    />
  );
}
