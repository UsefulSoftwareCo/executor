import type { HostedError } from "../../contracts/errors.ts";
import type { AccountSubmission, OAuthSubmission } from "@executor-js/ui/contracts/credentials";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import {
  OAuthClientInput,
  OAuthClientNotFound,
  oauthClientEntryReasons,
  type Account,
  type AppId,
  type HttpUrl,
  type OAuthClientId,
  type OAuthClientSelection,
  type Provider,
} from "@executor-js/sdk";
import type {
  HostedAccountConnection,
  HostedOAuthSignIn,
  HostedOAuthStartResult,
} from "@executor-js/hosted-server";
import { Link } from "@tanstack/react-router";
import { AtomRegistry } from "effect/reactivity";
import { Cause, Effect, Match, Option, Exit, Schema } from "effect";
import { createContext, useContext, useEffect, useRef } from "react";
import { Button } from "@executor-js/ui/components/button";
import { OAuthFields, OAuthSetup } from "@executor-js/ui/dashboard/oauth-fields";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { AccountForm } from "@executor-js/ui/dashboard/account-form";
import {
  InteractiveSignIn,
  type InteractivePrompt,
  type InteractiveState,
} from "@executor-js/ui/dashboard/interactive-sign-in";
import { accountToNameAtom, checkCredentialsAtom } from "../../contracts/accounts.ts";
import {
  oauthSetupAtom,
  startOAuthAtom,
  submitConnectionAtom,
  PendingOAuth,
  type OAuthReturn,
} from "../../contracts/apps.ts";
import {
  cancelInteractiveConnectionAtom,
  interactiveConnectionStatusAtom,
  startInteractiveConnectionAtom,
  submitInteractiveConnectionAtom,
} from "../../contracts/interactive-accounts.ts";
import { useOrganizationDetails, useOrganizationRoute } from "../components/organization.tsx";
import {
  oauthClientsAtom,
  registerOAuthClientAtom,
  updateOAuthClientAtom,
} from "../../contracts/oauth-clients.ts";

export const OAuthReturnContext = createContext<OAuthReturn | undefined>(undefined);

export function openAccountOAuth(pending: typeof PendingOAuth.Type, authorizationUrl: string) {
  sessionStorage.setItem("executor:hosted:oauth", JSON.stringify(pending));
  window.location.assign(authorizationUrl);
}

export function ConnectionFields({
  connection,
  onSaved,
  initialMethod,
  manualClient,
  editClient,
  onPendingChange,
}: {
  readonly connection: HostedAccountConnection;
  readonly onSaved: (account: Account) => void;
  readonly initialMethod?: string | undefined;
  readonly manualClient?: boolean | undefined;
  readonly editClient?: OAuthClientId | undefined;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const params = { organization, connection: connection.id };
  const submit = useAtomSet(submitConnectionAtom(params), { mode: "promiseExit" });
  const startOAuth = useAtomSet(startOAuthAtom(params), { mode: "promiseExit" });
  const cancel = useAtomSet(cancelInteractiveConnectionAtom(params), { mode: "promiseExit" });
  const start = useAtomSet(startInteractiveConnectionAtom(params), { mode: "promiseExit" });
  const started = useRef(false);
  const interactive = {
    start: (input: { readonly method: string }) => {
      started.current = true;
      return start(input);
    },
    status: useAtomSet(interactiveConnectionStatusAtom(params), { mode: "promiseExit" }),
    submit: useAtomSet(submitInteractiveConnectionAtom(params), { mode: "promiseExit" }),
    cancel: () => Promise.resolve(),
    leave: () => (started.current ? cancel() : Promise.resolve()),
  };
  if (connection.state.status !== "pending")
    return (
      <>
        <p className="text-sm">
          {connection.state.status === "completed"
            ? "Account connected."
            : "This connection has expired. Start a new connection from the app."}
        </p>
        <Button asChild variant="outline">
          <Link
            to="/org/$organizationSlug/apps/$appId"
            params={{ organizationSlug, appId: connection.target.app }}
            search={{ view: "accounts" }}
          >
            Back to app
          </Link>
        </Button>
      </>
    );
  return (
    <HostedAccountForm
      provider={connection.provider}
      app={connection.checkable ? connection.target.app : undefined}
      {...(connection.reconnectAccount ? { account: connection.reconnectAccount } : {})}
      redirectUri={connection.redirectUri}
      initialMethod={initialMethod}
      manualClient={manualClient}
      editClient={editClient}
      submit={submit}
      start={startOAuth}
      interactive={interactive}
      onSaved={onSaved}
      {...(onPendingChange ? { onPendingChange } : {})}
      onAuthorized={(value) =>
        openAccountOAuth(
          {
            organization,
            organizationSlug,
            connection: connection.id,
            app: connection.target.app,
            redirectUri: value.redirectUri,
            ...(connection.reconnectAccount ? { reconnect: true } : {}),
            manualClient: value.manualClient,
            ...(value.registeredClient ? { registeredClient: value.registeredClient } : {}),
          },
          value.authorizationUrl,
        )
      }
    />
  );
}

export interface HostedInteractiveActions {
  readonly start: (input: {
    readonly method: string;
  }) => Promise<Exit.Exit<InteractivePrompt, HostedError>>;
  readonly status: () => Promise<Exit.Exit<InteractiveState<Account>, HostedError>>;
  readonly submit: (input: {
    readonly value: string;
  }) => Promise<Exit.Exit<InteractiveState<Account>, HostedError>>;
  readonly cancel: () => Promise<unknown>;
  readonly leave?: (() => Promise<unknown>) | undefined;
}

export function HostedAccountForm<A extends HostedOAuthSignIn>({
  provider,
  account,
  redirectUri,
  initialMethod,
  manualClient,
  editClient,
  submit,
  start,
  onSaved,
  onAuthorized,
  onPendingChange,
  app,
  interactive,
}: {
  readonly interactive?: HostedInteractiveActions | undefined;
  readonly provider: Provider;
  readonly app?: AppId | null | undefined;
  readonly account?: Account;
  readonly redirectUri: string;
  readonly initialMethod?: string | undefined;
  readonly manualClient?: boolean | undefined;
  readonly editClient?: OAuthClientId | undefined;
  readonly submit: (input: AccountSubmission) => Promise<Exit.Exit<Account, HostedError>>;
  readonly start: (input: {
    readonly method: string;
    readonly client?: OAuthClientSelection;
    readonly chooseAgain?: true;
  }) => Promise<
    Exit.Exit<A | Extract<HostedOAuthStartResult, { status: "completed" }>, HostedError>
  >;
  readonly onSaved: (account: Account) => void;
  readonly onAuthorized: (
    value: A & { readonly manualClient: boolean; readonly registeredClient?: OAuthClientId },
  ) => void;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const { organization } = useOrganizationRoute();
  const requestName = useAtomSet(accountToNameAtom);
  const checkCredentials = useAtomSet(checkCredentialsAtom, { mode: "promiseExit" });
  const role = useOrganizationDetails()?.role;
  const steps = useRef<Promise<unknown>>(Promise.resolve());
  const inOrder = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = steps.current.then(run, run);
    steps.current = next.catch(() => undefined);
    return next;
  };
  const orderedSubmit = (input: AccountSubmission) => inOrder(() => submit(input));
  const leave = useRef(interactive?.leave);
  useEffect(() => {
    leave.current = interactive?.leave;
  });
  useEffect(
    () => () => {
      const run = leave.current;
      if (run) void inOrder(run);
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the queue lives as long as the form
    [],
  );
  const admin = role !== undefined && role !== "member";
  const registry = useContext(RegistryContext);
  const register = useAtomSet(registerOAuthClientAtom(organization), { mode: "promiseExit" });
  const registered = useRef<{
    readonly issuer: string;
    readonly clientId: string;
    readonly id: OAuthClientId;
  }>(undefined);
  const saved = (value: Account) => {
    if (!account)
      requestName({ organization, account: value.id, saved: { account: value, provider } });
    onSaved(value);
  };
  const savedClient = (
    input: OAuthSubmission,
    issuer: typeof HttpUrl.Type | undefined,
  ): Promise<Exit.Exit<OAuthClientId | undefined, HostedError>> => {
    const entered = input.client;
    if (entered === undefined || !Schema.is(OAuthClientInput)(entered))
      return Promise.resolve(Exit.succeed(undefined));
    const { update } = input;
    if (update !== undefined)
      return Effect.runPromiseExit(
        Effect.gen(function* () {
          const directory = yield* AtomRegistry.getResult(
            registry,
            oauthClientsAtom(organization),
            { suspendOnWaiting: true },
          );
          const current = directory.clients.find((entry) => entry.client.id === update);
          if (current === undefined) return yield* new OAuthClientNotFound({ client: update });
          const mutation = updateOAuthClientAtom({ organization, client: update });
          registry.set(mutation, {
            ...(entered.clientId === current.client.clientId ? {} : { clientId: entered.clientId }),
            ...(entered.clientSecret ? { clientSecret: entered.clientSecret } : {}),
            audience: current.access.audience,
            revision: current.access.revision,
          });
          const saved = yield* AtomRegistry.getResult(registry, mutation, {
            suspendOnWaiting: true,
          });
          return saved.client.id;
        }),
      );
    if (input.register !== true || issuer === undefined)
      return Promise.resolve(Exit.succeed(undefined));
    const retried = registered.current;
    if (retried?.issuer === issuer && retried.clientId === entered.clientId)
      return savedClient({ ...input, register: false, update: retried.id }, issuer);
    return register({
      issuer,
      clientId: entered.clientId,
      ...(entered.clientSecret ? { clientSecret: entered.clientSecret } : {}),
      audience: { kind: "everyone" },
    }).then((exit) =>
      Exit.map(exit, (saved) => {
        registered.current = { issuer, clientId: entered.clientId, id: saved.client.id };
        return saved.client.id;
      }),
    );
  };
  return (
    <AccountForm
      provider={provider}
      {...(account ? { account } : {})}
      initialMethod={initialMethod}
      Failure={HostedFailure}
      submitLabel={account ? "Save credentials" : "Connect account"}
      submit={orderedSubmit}
      {...(app === undefined || app === null
        ? {}
        : {
            check: {
              app,
              run: (input: AccountSubmission) =>
                checkCredentials({ organization, app, provider: provider.id, ...input }),
            },
          })}
      onSaved={saved}
      {...(onPendingChange ? { onPendingChange } : {})}
      {...(interactive
        ? {
            interactive: ({ method, label, disabled, onPendingChange }) => (
              <InteractiveSignIn<Account, HostedError>
                label={label}
                disabled={disabled}
                onPendingChange={onPendingChange}
                Failure={HostedFailure}
                start={() => inOrder(() => interactive.start({ method }))}
                status={() => inOrder(interactive.status)}
                submit={(value) => inOrder(() => interactive.submit({ value }))}
                cancel={() => void inOrder(interactive.cancel)}
                onSaved={saved}
              />
            ),
          }
        : {})}
      oauth={({ method, disabled, clientGuide, onPendingChange, access }) => (
        <OAuthSetup query={oauthSetupAtom({ organization, provider: provider.id, method })}>
          {({ setup, action, refresh }) => (
            <OAuthFields
              providerName={provider.definition.name}
              clientGuide={clientGuide}
              Failure={HostedFailure}
              setup={setup}
              setupAction={action}
              access={access}
              disabled={disabled}
              manualClient={manualClient}
              editClient={admin ? editClient : undefined}
              registerClient={admin}
              {...(account ? { account } : {})}
              redirectUri={redirectUri}
              onPendingChange={onPendingChange}
              requiresClient={(cause) => {
                const required = Option.exists(Cause.findErrorOption(cause), (error) =>
                  Match.value(error).pipe(
                    Match.tag("OAuthClientUnavailable", () => true),
                    Match.tag("OAuthSetupFailed", (error) =>
                      oauthClientEntryReasons.has(error.reason),
                    ),
                    Match.orElse(() => false),
                  ),
                );
                if (required) refresh();
                return required;
              }}
              start={async (input: OAuthSubmission) => {
                const saved = await savedClient(
                  input,
                  setup !== "unresolved" && setup.grant === "authorization_code"
                    ? setup.issuer
                    : undefined,
                );
                if (Exit.isFailure(saved)) return Exit.failCause(saved.cause);
                const registeredClient = saved.value;
                if (registeredClient !== undefined) refresh();
                const exit = await inOrder(() =>
                  start({
                    method,
                    ...(registeredClient !== undefined
                      ? { client: { id: registeredClient } }
                      : input.client !== undefined
                        ? { client: input.client }
                        : {}),
                    ...(input.chooseAgain === true ? { chooseAgain: true } : {}),
                  }),
                );
                return Exit.map(exit, (value) => ({
                  ...value,
                  manualClient:
                    registeredClient === undefined &&
                    input.client !== undefined &&
                    Schema.is(OAuthClientInput)(input.client),
                  ...(registeredClient !== undefined ? { registeredClient } : {}),
                }));
              }}
              onAuthorized={(value) => {
                refresh();
                if (value.status !== "completed") {
                  onAuthorized(value);
                  return "navigating";
                }
                saved(value.account);
                return "done";
              }}
            />
          )}
        </OAuthSetup>
      )}
    />
  );
}
