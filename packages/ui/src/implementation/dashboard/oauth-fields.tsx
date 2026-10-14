import { useEffect, useState } from "react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cause, Exit, Option, Redacted } from "effect";
import type { Account, OAuthClientId, OAuthConnectOptions } from "@executor-js/sdk";
import type { OAuthSubmission } from "../../contracts/credentials.ts";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
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

/** Keep forms mounted through cached setup reads, refresh failures, and retries. */
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

/** Where the connection's OAuth client comes from. */
type ClientChoice =
  | { readonly kind: "current" }
  | { readonly kind: "registered"; readonly id: OAuthClientId }
  | { readonly kind: "automatic" }
  | { readonly kind: "manual" };

const choiceKey = (choice: ClientChoice) =>
  choice.kind === "registered" ? `client:${choice.id}` : choice.kind;

/**
 * The clients this connection can use, in order of preference: the account's own on a reconnect,
 * then clients registered for the provider, the automatic client, and entered details last.
 * Client credentials are each account's own, so only the current ones or new ones apply.
 */
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

/** Choose an OAuth client or enter one; each host owns the sign-in and return flow. */
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
  missingClient,
  disabled = false,
}: {
  readonly providerName: string;
  readonly account?: Pick<Account, "label">;
  readonly redirectUri: string;
  readonly start: (input: OAuthSubmission) => Promise<Exit.Exit<A, E>>;
  /** Report "navigating" when the browser is leaving for sign-in, so the action stays busy until it does. */
  readonly onAuthorized: (value: NoInfer<A>) => "navigating" | "done";
  readonly requiresClient: (cause: Cause.Cause<NoInfer<E>>) => boolean;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  /** Where the sign-in goes once saved, shown just above the Connect action. */
  readonly access?: ReactNode;
  readonly disabled?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly manualClient?: boolean | undefined;
  /** Hosts with a preflight check supply its result; unresolved checks never guess a sign-in method. */
  readonly setup: OAuthConnectOptions | "unresolved";
  /** Setup progress covers the Connect action and collapsed Advanced options. */
  readonly setupAction?: ReactNode;
  /**
   * Hosts that register clients elsewhere supply the way to get one. When no client is available,
   * the form says so, shows this instead of Connect, and keeps entering details under Advanced.
   */
  readonly missingClient?: ReactNode;
}) {
  const choices = clientChoices(options, account !== undefined);
  const [picked, setPicked] = useState<ClientChoice | undefined>(
    manualClient ? { kind: "manual" } : undefined,
  );
  // A pick that is no longer offered, such as a removed client, falls back to the first choice.
  const choice =
    (picked === undefined
      ? undefined
      : choices.find((offered) => choiceKey(offered) === choiceKey(picked))) ?? choices[0];
  const setup = options;
  const machine = setup !== "unresolved" && setup.grant === "client_credentials";
  // Without a client to sign in with, entering one is a deliberate choice rather than the default.
  const missing =
    missingClient !== undefined &&
    !machine &&
    choices.length > 0 &&
    choices.every((offered) => offered.kind === "manual");
  const manual = choice?.kind === "manual" && (!missing || picked?.kind === "manual");
  const userScopes =
    setup !== "unresolved" && setup.grant === "authorization_code" ? (setup.userScopes ?? []) : [];
  const requested = setup === "unresolved" ? 0 : setup.scopes.length + userScopes.length;
  const method = setup === "unresolved" ? "none" : setup.tokenEndpointAuthMethod;
  // An undeclared method accepts either a public client or one with a secret.
  const acceptsSecret = method !== "none";
  const needsSecret = method !== undefined && method !== "none";
  const details = needsSecret
    ? "client ID and secret"
    : acceptsSecret
      ? "client ID (and secret, if it has one)"
      : "client ID";
  // Client entry's one line of help; a failure, which carries its own recovery, replaces it.
  const guidance = machine
    ? `Create an OAuth client in ${providerName}’s developer settings${setup.scopes.length > 0 ? " with the permissions under Advanced" : ""}, then enter its ${details}.`
    : setup !== "unresolved" && setup.mode === "client-required"
      ? `Executor can’t set up sign-in for ${providerName} automatically. Create an OAuth app there with this redirect URL, then enter its ${details}.`
      : `Use an OAuth app in ${providerName} that allows this redirect URL, and enter its ${details}.`;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const blocked =
    disabled ||
    setupAction !== undefined ||
    choice === undefined ||
    (missing && !manual) ||
    pending ||
    (manual && (!clientId.trim() || (needsSecret && !clientSecret.trim())));
  const label = (offered: ClientChoice): ReactNode => {
    switch (offered.kind) {
      case "current":
        return machine ? "Current client credentials" : "Current client";
      case "registered": {
        // Registered clients are unnamed; the form is for one service, so its client ID identifies
        // one, unless another client shares it.
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
  // The picker leads the form only when there is a real choice between clients. With one, the
  // form uses it and keeps the picker, with entering details, under Advanced.
  const prominent = choices.filter((offered) => offered.kind !== "manual").length > 1;
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

  // Going back from the provider can restore this page from the back-forward cache mid-redirect.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setPending(false);
      onPendingChange?.(false);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [onPendingChange]);
  const enterDetails = missing && (
    <label className="flex items-center gap-2 text-xs font-medium">
      <Checkbox
        checked={manual}
        disabled={pending || disabled}
        onCheckedChange={(checked) => {
          setPicked(checked === true ? { kind: "manual" } : undefined);
          setError(undefined);
        }}
      />
      Enter client details for this account
    </label>
  );
  return (
    <>
      {prominent && clientSelect}
      {error ? (
        <Failure cause={error} layout="compact" />
      ) : (
        <>
          {missing && !manual && (
            <p className="text-[13px] leading-5 text-pretty text-muted-foreground">
              No OAuth client is registered for {providerName}, and Executor doesn’t provide one.
            </p>
          )}
          {manual && (
            <p className="text-[13px] leading-5 text-pretty text-muted-foreground">{guidance}</p>
          )}
        </>
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
              {needsSecret ? "Client secret" : "Client secret (optional)"}
              <Input
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                disabled={pending || disabled}
              />
            </label>
          )}
        </>
      )}
      <div className="form-actions flex flex-col gap-3 pt-1">
        {access}
        <div role="group" aria-label="Connection options" className="relative flex flex-col gap-4">
          <div className="flex min-h-9 flex-col max-[740px]:min-h-11">
            {setupAction ??
              (missing && !manual ? (
                missingClient
              ) : (
                <Button type="button" className="w-full" disabled={blocked} onClick={connect}>
                  {pending
                    ? machine
                      ? "Connecting…"
                      : "Preparing sign-in…"
                    : `${account === undefined ? "Connect" : "Reconnect"} ${providerName}`}
                </Button>
              ))}
          </div>
          {setup !== "unresolved" &&
          (requested > 0 || missing || (!prominent && clientSelect !== undefined)) ? (
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
                {enterDetails}
                {!prominent && clientSelect}
                <Permissions label="Requested permissions" scopes={setup.scopes} />
                <Permissions label="User token permissions" scopes={userScopes} />
              </div>
            </details>
          ) : (
            // Reserve the collapsed row even when setup has not resolved or has no advanced options.
            <div aria-hidden="true" className="border-t border-transparent pt-3">
              <div className="h-4" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** What sign-in asks the provider for, shown before the user leaves for its consent page. */
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
