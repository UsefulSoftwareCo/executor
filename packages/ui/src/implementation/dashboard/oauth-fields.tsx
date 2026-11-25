import { useEffect, useState } from "react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cause, Exit, Option, Redacted } from "effect";
import {
  OAuthSetupFailed,
  type Account,
  type OAuthClientId,
  type OAuthConnectOptions,
} from "@executor-js/sdk";
import type { OAuthSubmission } from "../../contracts/credentials.ts";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { CopyButton } from "./code.tsx";
import { AsyncResult } from "effect/reactivity";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { undeclaredError } from "@executor-js/utils/connection-failure";
import { ErrorNotice } from "./error-notice.tsx";
import { OAuthClientOrigin, sharesClientId } from "./oauth-client-origin.tsx";
import { useQuery } from "./context.tsx";
import { SetupHelp } from "./markdown.tsx";

export function OAuthSetup<E extends UserFacingError>({
  query,
  children,
}: {
  readonly query: Query<OAuthConnectOptions, E>;
  readonly children: (state: {
    readonly setup: OAuthConnectOptions | "unresolved";
    readonly action: ReactNode;
    readonly refresh: () => void;
  }) => ReactNode;
}) {
  const { result, data, refresh } = useQuery(query);
  const failed = AsyncResult.isFailure(result);
  const loading = Option.isNone(data);
  const action = failed ? (
    <ErrorNotice
      error={Option.getOrElse(Cause.findErrorOption(result.cause), () =>
        undeclaredError(result.cause),
      )}
      context="While preparing account sign-in."
      retry={refresh}
      retrying={result.waiting}
    />
  ) : loading ? (
    <Skeleton
      role="status"
      aria-label="Preparing connection"
      className="absolute inset-0 motion-reduce:animate-none"
    />
  ) : undefined;
  return (
    <div className="flex flex-col gap-4">
      {children({
        setup: Option.isSome(data) ? data.value : "unresolved",
        action,
        refresh,
      })}
    </div>
  );
}

type ClientChoice =
  | { readonly kind: "current" }
  | { readonly kind: "registered"; readonly id: OAuthClientId }
  | { readonly kind: "automatic" }
  | { readonly kind: "manual" };

const choiceKey = (choice: ClientChoice) =>
  choice.kind === "registered" ? `client:${choice.id}` : choice.kind;

const clientChoices = (
  options: OAuthConnectOptions | "unresolved",
  reconnect: boolean,
): ReadonlyArray<ClientChoice> => {
  if (options === "unresolved") return [];
  const current: ReadonlyArray<ClientChoice> = reconnect ? [{ kind: "current" }] : [];
  if (options.grant === "client_credentials") return [...current, { kind: "manual" }];
  return [
    ...current,
    ...options.clients.map((client) => ({ kind: "registered" as const, id: client.id })),
    ...(options.mode === "automatic" ? [{ kind: "automatic" as const }] : []),
    { kind: "manual" },
  ];
};

export function OAuthFields<A, E>({
  providerName,
  account,
  redirectUri,
  start,
  onAuthorized,
  requiresClient,
  Failure,
  access,
  onPendingChange,
  manualClient = false,
  setup: options,
  setupAction,
  registerClient = false,
  editClient,
  clientGuide,
  disabled = false,
}: {
  readonly providerName: string;
  readonly clientGuide?: string | undefined;
  readonly account?: Pick<Account, "label">;
  readonly redirectUri: string;
  readonly start: (input: OAuthSubmission) => Promise<Exit.Exit<A, E>>;
  readonly onAuthorized: (value: NoInfer<A>) => "navigating" | "done";
  readonly requiresClient: (cause: Cause.Cause<NoInfer<E>>) => boolean;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly access?: ReactNode;
  readonly disabled?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly manualClient?: boolean | undefined;
  readonly setup: OAuthConnectOptions | "unresolved";
  readonly setupAction?: ReactNode;
  readonly registerClient?: boolean;
  readonly editClient?: OAuthClientId | undefined;
}) {
  const choices = clientChoices(options, account !== undefined);
  const editing =
    editClient === undefined || options === "unresolved"
      ? undefined
      : options.clients.find((client) => client.id === editClient);
  const [picked, setPicked] = useState<ClientChoice | undefined>(
    manualClient || editClient !== undefined ? { kind: "manual" } : undefined,
  );
  const choice =
    (picked === undefined
      ? undefined
      : choices.find((offered) => choiceKey(offered) === choiceKey(picked))) ?? choices[0];
  const setup = options;
  const machine = setup !== "unresolved" && setup.grant === "client_credentials";
  const missing =
    registerClient &&
    !machine &&
    choices.length > 0 &&
    choices.every((offered) => offered.kind === "manual");
  const manual = choice?.kind === "manual";
  const updating = manual && editing !== undefined;
  const userScopes =
    setup !== "unresolved" && setup.grant === "authorization_code" ? (setup.userScopes ?? []) : [];
  const requested = setup === "unresolved" ? 0 : setup.scopes.length + userScopes.length;
  const method = setup === "unresolved" ? "none" : setup.tokenEndpointAuthMethod;
  const acceptsSecret = method !== "none";
  const needsSecret = method !== undefined && method !== "none";
  const details = needsSecret
    ? "client ID and secret"
    : acceptsSecret
      ? "client ID (and secret, if it has one)"
      : "client ID";
  const refusal =
    setup !== "unresolved" && setup.operatorScopeRefusal !== undefined
      ? new OAuthSetupFailed({
          reason: "operator_scope_refused",
          operatorScopes: setup.operatorScopeRefusal,
        })
      : undefined;
  const guidance = machine
    ? `Create an OAuth client in ${providerName}’s developer settings${setup.scopes.length > 0 ? " with the permissions under Advanced" : ""}, then enter its ${details}.`
    : setup !== "unresolved" && setup.mode === "client-required"
      ? `Executor can’t set up sign-in for ${providerName} automatically. Create an OAuth app there with this redirect URL, then enter its ${details}.`
      : `Use an OAuth app in ${providerName} that allows this redirect URL, and enter its ${details}.`;
  const [enteredClientId, setClientId] = useState<string>();
  const clientId = enteredClientId ?? (updating ? editing.clientId : "");
  const [clientSecret, setClientSecret] = useState("");
  const [shared, setShared] = useState(!manualClient);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const blocked =
    disabled ||
    setupAction !== undefined ||
    choice === undefined ||
    pending ||
    (manual && (!clientId.trim() || (needsSecret && !updating && !clientSecret.trim())));
  const label = (offered: ClientChoice): ReactNode => {
    switch (offered.kind) {
      case "current":
        return machine ? "Current client credentials" : "Current client";
      case "registered": {
        const client =
          options === "unresolved"
            ? undefined
            : options.clients.find((stored) => stored.id === offered.id);
        if (client === undefined)
          return <span className="truncate font-mono text-xs">{offered.id}</span>;
        return (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-mono text-xs">{client.clientId}</span>
            {options !== "unresolved" && sharesClientId(client, options.clients) && (
              <span className="shrink-0 text-xs text-muted-foreground">
                <OAuthClientOrigin client={client} clients={options.clients} />
              </span>
            )}
          </span>
        );
      }
      case "automatic":
        return "Automatic";
      case "manual":
        return machine ? "New client credentials" : "Enter client details";
    }
  };
  const connect = () => {
    if (blocked || choice === undefined) return;
    setPending(true);
    onPendingChange?.(true);
    setError(undefined);
    const submission: OAuthSubmission =
      choice.kind === "manual"
        ? {
            client: {
              clientId: clientId.trim(),
              ...(acceptsSecret && clientSecret.trim()
                ? { clientSecret: Redacted.make(clientSecret.trim()) }
                : {}),
            },
            ...(updating ? { update: editing.id } : missing && shared ? { register: true } : {}),
          }
        : choice.kind === "registered"
          ? { client: { id: choice.id } }
          : choice.kind === "automatic"
            ? { client: { automatic: true } }
            : {};
    const operation = start(submission);
    void operation.then((exit) => {
      if (Exit.isSuccess(exit)) {
        setClientSecret("");
        if (onAuthorized(exit.value) === "navigating") return;
      } else {
        if (requiresClient(exit.cause)) setPicked({ kind: "manual" });
        setError(exit.cause);
      }
      setPending(false);
      onPendingChange?.(false);
    });
  };
  const prominent =
    account === undefined && choices.filter((offered) => offered.kind !== "manual").length > 1;
  const clientSelect =
    choice === undefined || choices.length < 2 ? undefined : (
      <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
        OAuth client
        <Select
          value={choiceKey(choice)}
          disabled={pending || disabled}
          onValueChange={(value) => {
            setPicked(choices.find((offered) => choiceKey(offered) === value));
            setError(undefined);
          }}
        >
          <SelectTrigger aria-label="OAuth client">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((offered) => (
              <SelectItem key={choiceKey(offered)} value={choiceKey(offered)}>
                {label(offered)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );

  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setPending(false);
      onPendingChange?.(false);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [onPendingChange]);
  return (
    <>
      {prominent && clientSelect}
      {error ? (
        <Failure cause={error} layout="compact" />
      ) : manual && refusal !== undefined ? (
        <ErrorNotice error={refusal} layout="compact" context="While connecting an account." />
      ) : (
        manual && (
          <p className="text-[13px] leading-5 text-pretty text-muted-foreground">{guidance}</p>
        )
      )}
      {manual && !machine && (
        <div className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
          <span>Redirect URL</span>
          <div className="oauth-redirect flex min-h-9 items-center gap-1 rounded-md border bg-muted/60 py-0.5 pr-0.5 pl-3">
            <code className="min-w-0 flex-1 font-mono text-xs font-normal wrap-anywhere [user-select:all]">
              {redirectUri}
            </code>
            <CopyButton
              code={redirectUri}
              label="Copy redirect URL"
              text=""
              size="icon-sm"
              inline
            />
          </div>
        </div>
      )}
      {manual && clientGuide && <SetupHelp label="OAuth client guide">{clientGuide}</SetupHelp>}
      {manual && (
        <>
          <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
            Client ID
            <Input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              disabled={pending || disabled}
              autoComplete="off"
            />
          </label>
          {acceptsSecret && (
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
              {needsSecret && !updating ? "Client secret" : "Client secret (optional)"}
              <Input
                type="password"
                {...(updating ? { placeholder: "Unchanged" } : {})}
                autoComplete="off"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                disabled={pending || disabled}
              />
            </label>
          )}
        </>
      )}
      {manual && missing && setup !== "unresolved" && requested > 0 && (
        <div className="space-y-4">
          <Permissions label="Permissions to add to the OAuth app" scopes={setup.scopes} />
          <Permissions label="User token permissions" scopes={userScopes} />
        </div>
      )}
      {manual && missing && (
        <div className="flex flex-col gap-2.25">
          <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
            Who can use this client
            <Select
              value={shared ? "everyone" : "account"}
              disabled={pending || disabled}
              onValueChange={(value) => setShared(value === "everyone")}
            >
              <SelectTrigger aria-label="Who can use this client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="everyone">Everyone in the organization</SelectItem>
                <SelectItem value="account">Only this account</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <p className="text-xs text-muted-foreground">
            {shared
              ? "Registered for the organization before sign-in."
              : "Used for this account only; nothing is saved for the organization."}
          </p>
        </div>
      )}
      <div className="form-actions flex flex-col gap-3 pt-1">
        {access}
        <div role="group" aria-label="Connection options" className="relative flex flex-col gap-4">
          <div className="flex min-h-9 flex-col max-[740px]:min-h-11">
            {setupAction ?? (
              <Button type="button" className="w-full" disabled={blocked} onClick={connect}>
                {pending
                  ? machine
                    ? "Connecting…"
                    : "Preparing sign-in…"
                  : `${account === undefined ? "Connect" : "Reconnect"} ${providerName}`}
              </Button>
            )}
          </div>
          {missing ? null : setup !== "unresolved" &&
            (requested > 0 || (!prominent && clientSelect !== undefined)) ? (
            <details className="group/advanced min-w-0 border-t pt-3">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={14}
                  className="shrink-0 -rotate-90 group-open/advanced:rotate-0"
                  aria-hidden
                />
                <span>Advanced</span>
                {requested > 0 && (
                  <span className="font-normal tabular-nums">
                    · {requested} {requested === 1 ? "permission" : "permissions"} requested
                  </span>
                )}
              </summary>
              <div className="space-y-4 pt-4">
                {!prominent && clientSelect}
                <Permissions label="Requested permissions" scopes={setup.scopes} />
                <Permissions label="User token permissions" scopes={userScopes} />
              </div>
            </details>
          ) : (
            <div aria-hidden="true" className="border-t border-transparent pt-3">
              <div className="h-4" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Permissions({
  label,
  scopes,
}: {
  readonly label: string;
  readonly scopes: readonly string[];
}) {
  if (scopes.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-medium">
        <span>{label}</span>
        <span className="font-normal tabular-nums text-muted-foreground">{scopes.length}</span>
      </h3>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="flex max-h-[min(14rem,30dvh)] flex-wrap gap-1.5 overflow-y-auto overscroll-contain rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {scopes.map((scope) => (
          <code key={scope} className="max-w-full rounded bg-muted px-2 py-1 text-xs break-all">
            {scope}
          </code>
        ))}
      </div>
    </section>
  );
}
