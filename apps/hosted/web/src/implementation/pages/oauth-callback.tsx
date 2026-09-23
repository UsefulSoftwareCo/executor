import { AtomRegistry } from "effect/unstable/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Effect, Exit, Option, Redacted, Schema, Cause } from "effect";
import { OAuthCompletionFailed } from "@executor-js/sdk";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { ConnectionStatusPage } from "../components/connection-status.tsx";
import { appError, completeOAuthAtom, PendingOAuth } from "../../contracts/apps.ts";

type CallbackState =
  | { readonly status: "connecting" }
  | { readonly status: "cancelled"; readonly message: string }
  | { readonly status: "failed"; readonly message: string; readonly recovery: "retry" | "client" };

/** Complete provider OAuth in the same browser session that started it. */
export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const started = useRef(false);
  const [state, setState] = useState<CallbackState>({ status: "connecting" });
  const [pending] = useState(() =>
    Schema.decodeUnknownOption(Schema.fromJsonString(PendingOAuth))(
      sessionStorage.getItem("executor:hosted:oauth"),
    ),
  );
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const callbackSearch = window.location.search;
    window.history.replaceState(null, "", "/oauth/callback");
    if (Option.isNone(pending)) {
      // oxlint-disable-next-line react/set-state-in-effect -- one-time callback handling on mount
      setState({
        status: "failed",
        message:
          "This sign-in has expired or was started in another tab. Open the app and connect again.",
        recovery: "retry",
      });
      return;
    }
    if (new URLSearchParams(callbackSearch).get("error") === "access_denied") {
      setState({
        status: "cancelled",
        message: "No account was connected. You can return to the app and try again.",
      });
      sessionStorage.removeItem("executor:hosted:oauth");
      return;
    }
    const callback = new URL(pending.value.redirectUri);
    callback.search = callbackSearch;
    const { organization, organizationSlug, connection, app, profile } = pending.value;
    void (async () => {
      const mutation = completeOAuthAtom({ organization, connection });
      registry.set(mutation, { callbackUrl: Redacted.make(callback.href), app });
      const result = await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true }),
      );
      if (Exit.isFailure(result)) {
        const clientRejected = Option.exists(
          Cause.findErrorOption(result.cause),
          (error) => Schema.is(OAuthCompletionFailed)(error) && error.reason === "invalid_client",
        );
        setState({
          status: "failed",
          message: appError(result.cause),
          recovery: clientRejected ? "client" : "retry",
        });
        return;
      }
      sessionStorage.removeItem("executor:hosted:oauth");
      if (app !== null) {
        await navigate({
          to: "/org/$organizationSlug/apps/$appId",
          params: { organizationSlug, appId: app },
          search: { view: "accounts", profile },
        });
      } else
        await navigate({
          to: "/org/$organizationSlug/accounts/$accountId",
          params: { organizationSlug, accountId: result.value.id },
        });
    })();
  }, [registry, navigate, pending]);
  return (
    <ConnectionStatusPage
      status={state.status}
      label={Option.isSome(pending) ? pending.value.label : undefined}
      message={
        state.status !== "connecting"
          ? state.message
          : Option.isSome(pending) && pending.value.app !== null
            ? "Finishing sign-in. You’ll return to the app automatically."
            : "Finishing sign-in. Your account will open automatically."
      }
    >
      {state.status !== "connecting" && (
        <OAuthRecoveryActions
          pending={pending}
          recovery={state.status === "cancelled" ? "cancelled" : state.recovery}
        />
      )}
    </ConnectionStatusPage>
  );
}

/** Recovery links resume the original connection or return to its owning app. */
function OAuthRecoveryActions({
  pending,
  recovery,
}: {
  readonly pending: Option.Option<typeof PendingOAuth.Type>;
  readonly recovery: "retry" | "client" | "cancelled";
}) {
  if (Option.isNone(pending))
    return (
      <Button asChild>
        <Link to="/">Open Executor</Link>
      </Button>
    );
  const context = pending.value;
  const changeClient = recovery === "client" || context.manualClient;
  return (
    <>
      {recovery !== "cancelled" && (
        <Button asChild>
          <Link
            to="/org/$organizationSlug/connections/$connectionId"
            params={{
              organizationSlug: context.organizationSlug,
              connectionId: context.connection,
            }}
            search={changeClient ? { client: "change" } : {}}
          >
            {changeClient ? "Update client details" : "Try again"}
          </Link>
        </Button>
      )}
      {context.app !== null ? (
        <Button variant={recovery === "cancelled" ? "default" : "outline"} asChild>
          <Link
            to="/org/$organizationSlug/apps/$appId"
            params={{ organizationSlug: context.organizationSlug, appId: context.app }}
            search={{ view: "accounts", profile: context.profile }}
          >
            Back to app
          </Link>
        </Button>
      ) : recovery === "cancelled" ? (
        <Button asChild>
          <Link
            to="/org/$organizationSlug/connections/$connectionId"
            params={{
              organizationSlug: context.organizationSlug,
              connectionId: context.connection,
            }}
          >
            Try again
          </Link>
        </Button>
      ) : null}
    </>
  );
}
