import { useEffect, useState } from "react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cause, Exit, Option, Redacted } from "effect";
import type { Account, OAuthClientSetup } from "@executor-js/sdk";
import type { OAuthSubmission } from "../../contracts/credentials.ts";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { CopyButton } from "./code.tsx";
import { AsyncResult } from "effect/reactivity";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";
import { undeclaredError } from "@executor-js/utils/connection-failure";
import { ErrorNotice } from "./error-notice.tsx";
import { useQuery } from "./context.tsx";

/** Keep forms mounted through cached setup reads, refresh failures, and retries. */
export function OAuthSetup<E extends UserFacingError>({
  query,
  children,
}: {
  readonly query: Query<OAuthClientSetup, E>;
  readonly children: (state: {
    readonly setup: OAuthClientSetup | "unresolved";
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

/** Automatic OAuth setup and manual client entry; each host owns the sign-in and return flow. */
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
  setup,
  setupAction,
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
  readonly setup: OAuthClientSetup | "unresolved";
  /** Setup progress covers the Connect action and collapsed Advanced options. */
  readonly setupAction?: ReactNode;
}) {
  const [customClient, setManual] = useState(manualClient);
  const manual = customClient || (setup !== "unresolved" && setup.mode === "client-required");
  const machine = setup !== "unresolved" && setup.grant === "client_credentials";
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
    setup === "unresolved" ||
    pending ||
    (manual && (!clientId.trim() || (needsSecret && !clientSecret.trim())));
  const connect = () => {
    if (blocked) return;
    setPending(true);
    onPendingChange?.(true);
    setError(undefined);
    const client = manual
      ? {
          clientId: clientId.trim(),
          ...(acceptsSecret && clientSecret.trim()
            ? { clientSecret: Redacted.make(clientSecret.trim()) }
            : {}),
        }
      : undefined;
    const operation = start(client ? { client } : {});
    void operation.then((exit) => {
      if (Exit.isSuccess(exit)) {
        setClientSecret("");
        if (onAuthorized(exit.value) === "navigating") return;
      } else {
        if (requiresClient(exit.cause)) setManual(true);
        setError(exit.cause);
      }
      setPending(false);
      onPendingChange?.(false);
    });
  };
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
  return (
    <>
      {error ? (
        <Failure cause={error} layout="compact" />
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
      {manual && (
        <>
          <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
            Client ID
            <Input
              value={clientId}
              onChange={(event) => {
                setManual(true);
                setClientId(event.target.value);
              }}
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
                onChange={(event) => {
                  setManual(true);
                  setClientSecret(event.target.value);
                }}
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
          {setup !== "unresolved" && (setup.mode === "saved" || requested > 0) ? (
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
                {setup.mode === "saved" && (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">OAuth client</p>
                      <p className="text-muted-foreground">
                        {manual ? "Saved after a successful connection." : "Using a saved client"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs"
                      aria-label={manual ? "Use saved client" : "Change OAuth client"}
                      disabled={pending || disabled}
                      onClick={() => {
                        setManual(!manual);
                        setError(undefined);
                      }}
                    >
                      {manual ? "Use saved client" : "Change"}
                    </Button>
                  </div>
                )}
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
