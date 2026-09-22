import { useState } from "react";
import { ArrowDown01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Exit, Option, Redacted, type Cause } from "effect";
import type { Account, OAuthClientSetup } from "@executor-js/sdk";
import type { OAuthSubmission } from "../../contracts/credentials.ts";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import type { ComponentType, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/alert.tsx";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { CopyButton } from "./code.tsx";
import { AsyncResult } from "effect/unstable/reactivity";
import { useQuery } from "./context.tsx";

/** Keep forms mounted through cached setup reads, refresh failures, and retries. */
export function OAuthSetup<E>({
  query,
  children,
}: {
  readonly query: Query<OAuthClientSetup, E>;
  readonly children: (state: {
    readonly setup: OAuthClientSetup | "unresolved";
    readonly blocked: boolean;
    readonly refresh: () => void;
  }) => ReactNode;
}) {
  const { result, data, refresh } = useQuery(query);
  const failed = AsyncResult.isFailure(result);
  return (
    <>
      {failed ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border p-3 text-xs"
        >
          <span>Couldn’t check connection options.</span>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : Option.isNone(data) ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking connection options…
        </p>
      ) : null}
      <div key="fields" className="flex flex-col gap-4">
        {children({
          setup: Option.isSome(data) ? data.value : "unresolved",
          blocked: failed,
          refresh,
        })}
      </div>
    </>
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
  onPendingChange,
  manualClient = false,
  setup,
  initialLabel = "Default",
  disabled = false,
}: {
  readonly providerName: string;
  readonly account?: Pick<Account, "label">;
  readonly redirectUri: string;
  readonly start: (input: OAuthSubmission) => Promise<Exit.Exit<A, E>>;
  readonly onAuthorized: (value: NoInfer<A>) => void;
  readonly requiresClient: (cause: Cause.Cause<NoInfer<E>>) => boolean;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly disabled?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly manualClient?: boolean | undefined;
  /** Hosts with a preflight check supply its result; unresolved checks never guess a sign-in method. */
  readonly setup: OAuthClientSetup | "unresolved";
  readonly initialLabel?: string | undefined;
}) {
  const [label, setLabel] = useState(account?.label ?? initialLabel);
  const [customClient, setManual] = useState(manualClient);
  const manual = customClient || (setup !== "unresolved" && setup.mode === "client-required");
  const machine = setup !== "unresolved" && setup.grant === "client_credentials";
  const needsSecret = setup !== "unresolved" && setup.tokenEndpointAuthMethod !== "none";
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const blocked =
    disabled ||
    setup === "unresolved" ||
    pending ||
    !label.trim() ||
    (manual && (!clientId.trim() || (needsSecret && !clientSecret)));
  const connect = () => {
    if (blocked) return;
    setPending(true);
    onPendingChange?.(true);
    setError(undefined);
    const client = manual
      ? {
          clientId: clientId.trim(),
          ...(needsSecret ? { clientSecret: Redacted.make(clientSecret) } : {}),
        }
      : undefined;
    const operation = start({ label: label.trim(), ...(client ? { client } : {}) });
    void operation.then((exit) => {
      setPending(false);
      onPendingChange?.(false);
      if (Exit.isSuccess(exit)) {
        setClientSecret("");
        onAuthorized(exit.value);
      } else {
        if (requiresClient(exit.cause)) setManual(true);
        setError(exit.cause);
      }
    });
  };
  return (
    <>
      {manual && (
        <>
          <Alert role="note" className="gap-y-2 bg-muted/30 px-3 py-3">
            <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
            <AlertTitle className="text-[13px]">Set up an OAuth client</AlertTitle>
            <AlertDescription className="gap-2 text-xs leading-relaxed">
              <p>
                {machine
                  ? "This service uses an OAuth client ID and secret to connect."
                  : setup !== "unresolved" && setup.mode === "client-required"
                    ? "Executor can’t set up sign-in automatically for this service."
                    : "Use your OAuth app’s details to connect this account."}
              </p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>Open or create an OAuth app in {providerName}’s developer settings.</li>
                {!machine ? (
                  <li>Add the redirect URL below to that app.</li>
                ) : setup.scopes.length > 0 ? (
                  <li>Enable the permissions listed below for that app.</li>
                ) : null}
                <li>
                  {needsSecret
                    ? "Enter its client ID and client secret here."
                    : "Enter its client ID here."}
                </li>
              </ol>
            </AlertDescription>
          </Alert>
          {!machine && (
            <div className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
              <span>Redirect URL</span>
              <div className="oauth-redirect flex items-start gap-3 [&_>_code]:flex-1 [&_>_code]:min-w-0 [&_>_code]:py-[3px] [&_>_code]:px-0 [&_>_code]:font-mono [&_>_code]:text-[12px] [&_>_code]:font-normal [&_>_code]:wrap-anywhere [&_>_code]:[user-select:all]">
                <code>{redirectUri}</code>
                <CopyButton code={redirectUri} label="Copy redirect URL" inline />
              </div>
            </div>
          )}
        </>
      )}
      {account === undefined && (
        <label className="flex flex-col gap-2 text-[13px] font-medium">
          Account name
          <Input
            autoFocus
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                connect();
              }
            }}
            disabled={pending || disabled}
            maxLength={120}
          />
        </label>
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
          {needsSecret && (
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
              Client secret
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
      {error && <Failure cause={error} />}
      <div className="form-actions pt-1">
        <Button type="button" className="w-full" disabled={blocked} onClick={connect}>
          {pending
            ? machine
              ? "Connecting…"
              : "Preparing sign-in…"
            : `${account === undefined ? "Connect" : "Reconnect"} ${providerName}`}
        </Button>
      </div>
      {setup !== "unresolved" && (setup.mode === "saved" || setup.scopes.length > 0) && (
        <details className="group/advanced min-w-0 border-t pt-3">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={14}
              className="shrink-0 -rotate-90 group-open/advanced:rotate-0"
              aria-hidden
            />
            <span>Advanced</span>
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
            {setup.scopes.length > 0 && (
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-xs font-medium">
                  <span>Required permissions</span>
                  <span className="font-normal tabular-nums text-muted-foreground">
                    {setup.scopes.length}
                  </span>
                </h3>
                <div
                  role="region"
                  aria-label="Required permissions"
                  tabIndex={0}
                  className="flex max-h-[min(14rem,30dvh)] flex-wrap gap-1.5 overflow-y-auto overscroll-contain rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {setup.scopes.map((scope) => (
                    <code
                      key={scope}
                      className="max-w-full rounded bg-muted px-2 py-1 text-xs break-all"
                    >
                      {scope}
                    </code>
                  ))}
                </div>
              </section>
            )}
          </div>
        </details>
      )}
    </>
  );
}
