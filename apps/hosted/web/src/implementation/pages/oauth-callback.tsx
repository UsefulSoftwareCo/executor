import { AtomRegistry } from "effect/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Effect, Exit, Option, Redacted, Schema, Cause } from "effect";
import {
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  OAuthCompletionFailed,
  oauthCompletionRecovery,
  type OAuthCompletionRecovery,
} from "@executor-js/sdk";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { CopyButton } from "@executor-js/ui/dashboard/code";
import { ConnectionStatusPage } from "../components/connection-status.tsx";
import {
  appError,
  completeOAuthAtom,
  PendingOAuth,
  resolveOAuthCallbackAtom,
} from "../../contracts/apps.ts";
import { accountToNameAtom } from "../../contracts/accounts.ts";
import type { HostedError } from "../../contracts/errors.ts";

/** The SDK decides recovery for every completion reason; `setup` means the connection itself ended. */
type Recovery = Exclude<OAuthCompletionRecovery, "cancelled"> | "setup";

type CallbackState =
  | { readonly status: "connecting" }
  | { readonly status: "cancelled"; readonly message: string }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly recovery: Recovery;
      readonly fixPrompt?: string | undefined;
    };

/**
 * Complete provider OAuth in whichever tab or browser the provider opened. Some services sign in
 * through an emailed link, so the callback cannot rely on the starting tab's session storage: the
 * server finds the pending connection from the callback's state and checks that the signed-in
 * user created it. The starting tab's context only adds its manual-client retry hint.
 */
export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const started = useRef(false);
  const [state, setState] = useState<CallbackState>({ status: "connecting" });
  const [pending, setPending] = useState<Option.Option<typeof PendingOAuth.Type>>(Option.none());
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The server renders this page too and cannot see the tab's storage, so the context is read
    // once the page has hydrated; until then both render the same neutral progress.
    const stored = Schema.decodeUnknownOption(Schema.fromJsonString(PendingOAuth))(
      sessionStorage.getItem("executor:hosted:oauth"),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- one-time callback handling on mount
    setPending(stored);
    const callbackSearch = window.location.search;
    window.history.replaceState(null, "", "/oauth/callback");
    if (!new URLSearchParams(callbackSearch).has("state")) {
      // oxlint-disable-next-line react/set-state-in-effect -- one-time callback handling on mount
      setState({
        status: "failed",
        message: "This sign-in has ended. Open the app and connect again.",
        recovery: "setup",
      });
      return;
    }
    /** Map a failed step to the SDK's recovery for its reason. */
    const fail = (cause: Cause.Cause<HostedError>) => {
      const error = Cause.findErrorOption(cause);
      const completion = Option.filter(error, Schema.is(OAuthCompletionFailed));
      const recovery = Option.match(completion, {
        onSome: (failure) => oauthCompletionRecovery[failure.reason],
        onNone: () =>
          Option.exists(
            error,
            (value) =>
              Schema.is(AccountConnectionClosed)(value) ||
              Schema.is(AccountConnectionTargetChanged)(value),
          )
            ? ("setup" as const)
            : ("restart" as const),
      });
      if (recovery === "cancelled") {
        sessionStorage.removeItem("executor:hosted:oauth");
        setState({
          status: "cancelled",
          message: "No account was connected. You can return to the app and try again.",
        });
        return;
      }
      setState({
        status: "failed",
        message: appError(cause),
        recovery,
        fixPrompt: Option.match(error, {
          onSome: (value) =>
            recovery === "configuration" && UserFacingError.is(value) && value.agentFixable
              ? `While connecting an account in Executor.\n\n${value.fixPrompt}`
              : undefined,
          onNone: () => undefined,
        }),
      });
    };
    void (async () => {
      const received = new URL("/oauth/callback", window.location.origin);
      received.search = callbackSearch;
      registry.set(resolveOAuthCallbackAtom, Redacted.make(received.href));
      const resolved = await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, resolveOAuthCallbackAtom, { suspendOnWaiting: true }),
      );
      if (Exit.isFailure(resolved)) {
        // Only the member who started a connection may finish it.
        if (
          Option.exists(
            Cause.findErrorOption(resolved.cause),
            (error) => error._tag === "OrganizationForbidden",
          )
        )
          return setState({
            status: "failed",
            message:
              "Another Executor user started this sign-in. Sign in as that user and open the link again.",
            recovery: "setup",
          });
        return fail(resolved.cause);
      }
      const { organizationSlug, connection, app, profile, reconnect } = resolved.value;
      // The organization's pages key their state by the route's slug reference.
      const organization = organizationSlug;
      const context = {
        ...resolved.value,
        organization,
        manualClient: Option.exists(
          stored,
          (value) => value.connection === connection && value.manualClient === true,
        ),
      };
      setPending(Option.some(context));
      const callback = new URL(context.redirectUri);
      callback.search = callbackSearch;
      const mutation = completeOAuthAtom({ organization, connection });
      registry.set(mutation, { callbackUrl: Redacted.make(callback.href), app });
      const result = await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true }),
      );
      if (Exit.isFailure(result)) return fail(result.cause);
      sessionStorage.removeItem("executor:hosted:oauth");
      // Reconnects keep their name; a new account is named on the page that follows.
      if (!reconnect) registry.set(accountToNameAtom, { organization, account: result.value.id });
      if (app !== null) {
        await navigate({
          to: "/org/$organizationSlug/apps/$appId",
          params: { organizationSlug, appId: app },
          search: { view: "accounts", profile },
        });
      } else
        await navigate({
          to: "/org/$organizationSlug/accounts",
          params: { organizationSlug },
          search: { account: result.value.id },
        });
    })();
  }, [registry, navigate]);
  return (
    <ConnectionStatusPage
      status={state.status}
      message={
        state.status !== "connecting"
          ? state.message
          : Option.match(pending, {
              onNone: () => "Finishing sign-in…",
              onSome: (context) =>
                context.app !== null
                  ? "Finishing sign-in. You’ll return to the app automatically."
                  : "Finishing sign-in. You’ll return to your accounts automatically.",
            })
      }
    >
      {state.status !== "connecting" && (
        <OAuthRecoveryActions
          pending={pending}
          recovery={state.status === "cancelled" ? "cancelled" : state.recovery}
          fixPrompt={state.status === "failed" ? state.fixPrompt : undefined}
        />
      )}
    </ConnectionStatusPage>
  );
}

/** Recovery links resume the original connection or return to its owning app. */
function OAuthRecoveryActions({
  pending,
  recovery,
  fixPrompt,
}: {
  readonly pending: Option.Option<typeof PendingOAuth.Type>;
  readonly recovery: Recovery | "cancelled";
  readonly fixPrompt?: string | undefined;
}) {
  if (Option.isNone(pending))
    return (
      <Button asChild>
        <Link to="/">Open Executor</Link>
      </Button>
    );
  const context = pending.value;
  // Entered clients are saved only after a successful sign-in, so a retry reopens their fields.
  const retry =
    recovery === "restart" ||
    recovery === "client" ||
    (recovery === "cancelled" && context.app === null)
      ? {
          label: recovery === "client" ? "Update client details" : "Try again",
          search:
            recovery === "client" || (recovery !== "cancelled" && context.manualClient)
              ? { client: "change" as const }
              : {},
        }
      : undefined;
  const primary = retry === undefined && fixPrompt === undefined;
  return (
    <>
      {fixPrompt !== undefined && (
        <CopyButton
          code={fixPrompt}
          label="Copy fix prompt"
          text="Copy fix prompt"
          variant="default"
          size="default"
          inline
        />
      )}
      {retry !== undefined && (
        <Button asChild>
          <Link
            to="/org/$organizationSlug/connections/$connectionId"
            params={{
              organizationSlug: context.organizationSlug,
              connectionId: context.connection,
            }}
            search={retry.search}
          >
            {retry.label}
          </Link>
        </Button>
      )}
      {context.app !== null ? (
        <Button variant={primary ? "default" : "outline"} asChild>
          <Link
            to="/org/$organizationSlug/apps/$appId"
            params={{ organizationSlug: context.organizationSlug, appId: context.app }}
            search={{ view: "accounts", profile: context.profile }}
          >
            Back to app
          </Link>
        </Button>
      ) : retry === undefined ? (
        <Button asChild variant={primary ? "default" : "outline"}>
          <Link
            to="/org/$organizationSlug/accounts"
            params={{ organizationSlug: context.organizationSlug }}
          >
            Open Accounts
          </Link>
        </Button>
      ) : null}
    </>
  );
}
