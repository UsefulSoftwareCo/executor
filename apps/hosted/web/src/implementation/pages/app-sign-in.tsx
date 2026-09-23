import type { ProfileId } from "@executor-js/sdk";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { App } from "@executor-js/sdk";
import { Button } from "@executor-js/ui/components/button";
import { Exit, Redacted } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import {
  appUiError,
  appUiLocationAtom,
  authorizeAppUiAtom,
  type AppSignInId,
} from "../../contracts/app-ui.ts";
import { useOrganizationRoute } from "../components/organization.tsx";

/** The product's existing AuthBoundary owns sign-in and return navigation. */
export function AppSignInPage({ request }: { readonly request: AppSignInId | undefined }) {
  const authorize = useAtomSet(authorizeAppUiAtom, { mode: "promiseExit" });
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (request === undefined) return;
    let active = true;
    void authorize({ payload: { request } }).then((result) => {
      if (!active) return;
      if (Exit.isFailure(result)) setError(appUiError(result.cause));
      else window.location.replace(Redacted.value(result.value.url));
    });
    return () => {
      active = false;
    };
  }, [request, authorize]);
  return (
    <div className="auth-pending min-h-dvh flex items-center justify-center gap-4">
      <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
        {error || request === undefined ? "Could not open app" : "Opening app…"}
      </h1>
      {request === undefined && <p>Open the app URL to sign in.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** Optional action slot: products with app hosting render a normal link. */
export function OpenAppAction({
  app,
  profile,
}: {
  readonly app: App;
  readonly profile?: ProfileId | undefined;
}) {
  return app.activeDeployment === null ? null : (
    <DeployedOpenAppAction app={app} profile={profile} deployment={app.activeDeployment} />
  );
}

function DeployedOpenAppAction({
  app,
  deployment,
  profile,
}: {
  readonly app: App;
  readonly profile?: ProfileId | undefined;
  readonly deployment: NonNullable<App["activeDeployment"]>;
}) {
  const { organization, slug } = useOrganizationRoute();
  const location = appUiLocationAtom({
    organization,
    slug,
    app: app.id,
    appSlug: app.slug,
    deployment,
  });
  const result = useAtomValue(location);
  const refresh = useAtomRefresh(location);
  if (AsyncResult.isFailure(result))
    return (
      <div className="flex items-center gap-2">
        <span className="max-w-sm text-sm text-muted-foreground" role="status">
          {appUiError(result.cause)}
        </span>
        <Button variant="outline" onClick={refresh}>
          Check again
        </Button>
      </div>
    );
  if (!AsyncResult.isSuccess(result)) return null;
  if (result.value.status === "pending")
    return (
      <span className="text-sm text-muted-foreground" role="status">
        Preparing app domain…
      </span>
    );
  if (result.value.status === "failed")
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground" role="status">
          App domain setup needs attention.
        </span>
        <Button variant="outline" onClick={refresh}>
          Check again
        </Button>
      </div>
    );
  if (result.value.status !== "ready") return null;
  return (
    <Button variant="outline" asChild>
      <a
        href={
          profile === undefined
            ? result.value.url
            : `${result.value.url}?profile=${encodeURIComponent(profile)}`
        }
        target="_blank"
        rel="noopener noreferrer"
      >
        Open app
      </a>
    </Button>
  );
}
