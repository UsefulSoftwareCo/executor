import { AtomRegistry } from "effect/unstable/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Effect, Exit, Option, Redacted, Schema, Cause } from "effect";
import { OAuthCompletionFailed } from "@executor-js/sdk";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { appError, completeOAuthAtom, PendingOAuth } from "../../contracts/apps.ts";

/** Complete provider OAuth in the same browser session that started it. */
export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const started = useRef(false);
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const [clientRejected, setClientRejected] = useState(false);
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
      setError(
        "This sign-in has expired or was started in another tab. Open the app and connect again.",
      );
      return;
    }
    if (new URLSearchParams(callbackSearch).get("error") === "access_denied") {
      setCancelled(true);
      setError("No account was connected. You can return to the app and try again.");
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
        setClientRejected(
          Option.exists(
            Cause.findErrorOption(result.cause),
            (error) => Schema.is(OAuthCompletionFailed)(error) && error.reason === "invalid_client",
          ),
        );
        setError(appError(result.cause));
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
    <section className="page w-full shrink-0 max-w-315 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
        {error
          ? cancelled
            ? "Connection cancelled"
            : "Account not connected"
          : "Connecting account…"}
      </h1>
      {error && (
        <>
          <p className="auth-error mt-4 text-destructive text-[13px]" role="alert">
            {error}
          </p>
          {Option.isSome(pending) && !cancelled && (
            <Button className="mt-4 mr-3" asChild>
              <Link
                to="/org/$organizationSlug/connections/$connectionId"
                params={{
                  organizationSlug: pending.value.organizationSlug,
                  connectionId: pending.value.connection,
                }}
                search={clientRejected || pending.value.manualClient ? { client: "change" } : {}}
              >
                {clientRejected || pending.value.manualClient
                  ? "Update client details"
                  : "Try again"}
              </Link>
            </Button>
          )}
          {!(Option.isSome(pending) && !cancelled && pending.value.app === null) && (
            <Button className="mt-4 self-start" variant="outline" asChild>
              {Option.isSome(pending) ? (
                pending.value.app !== null ? (
                  <Link
                    to="/org/$organizationSlug/apps/$appId"
                    params={{
                      organizationSlug: pending.value.organizationSlug,
                      appId: pending.value.app,
                    }}
                    search={{ view: "accounts", profile: pending.value.profile }}
                  >
                    Back to app
                  </Link>
                ) : (
                  <Link
                    to="/org/$organizationSlug/connections/$connectionId"
                    params={{
                      organizationSlug: pending.value.organizationSlug,
                      connectionId: pending.value.connection,
                    }}
                  >
                    Try again
                  </Link>
                )
              ) : (
                <Link to="/">Open Executor</Link>
              )}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
