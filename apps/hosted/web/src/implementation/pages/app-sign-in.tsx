import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { App } from "@executor-js/sdk";
import { Button } from "@executor-js/ui/components/button";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useEffect } from "react";
import {
  DesktopAppActions,
  DesktopAppSection,
  useDesktopHost,
  type DesktopAppUi,
} from "@executor-js/ui/dashboard/desktop-app";
import {
  appSignInFailureMessage,
  appUiError,
  appUiLocationAtom,
  type AppSignInFailure,
  type AppSignInId,
} from "../../contracts/app-ui.ts";
import { useOrganizationRoute } from "../components/organization.tsx";

export function AppSignInPage({
  request,
  failure,
}: {
  readonly request: AppSignInId | undefined;
  readonly failure: AppSignInFailure | undefined;
}) {
  const pending = failure === undefined && request !== undefined;
  useEffect(() => {
    if (pending) window.location.replace(window.location.href);
  }, [pending]);
  return (
    <div className="auth-pending min-h-dvh flex items-center justify-center gap-4">
      <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
        {pending ? "Opening app…" : "Could not open app"}
      </h1>
      {failure !== undefined && <p role="alert">{appSignInFailureMessage(failure)}</p>}
      {failure === undefined && request === undefined && <p>Open the app URL to sign in.</p>}
    </div>
  );
}

export function OpenAppAction({ app }: { readonly app: App }) {
  return app.activeVersion === null ? (
    <DesktopAppActions
      app={app.id}
      handoff={undefined}
      ui={{ status: "unavailable", reason: "Deploy this app before opening its page." }}
    />
  ) : (
    <DeployedOpenAppAction app={app} />
  );
}

const unavailableReason = "The app page is unavailable.";

const checkAgain = (message: string, refresh: () => void) => (
  <div className="flex items-center gap-2">
    <span className="max-w-sm text-sm text-muted-foreground" role="status">
      {message}
    </span>
    <Button variant="outline" onClick={refresh}>
      Check again
    </Button>
  </div>
);

const appUi = (
  result: Atom.Type<ReturnType<typeof appUiLocationAtom>>,
  refresh: () => void,
): DesktopAppUi => {
  if (AsyncResult.isFailure(result))
    return {
      status: "unavailable",
      reason: unavailableReason,
      notice: checkAgain(appUiError(result.cause), refresh),
    };
  if (!AsyncResult.isSuccess(result)) return { status: "checking" };
  const location = result.value;
  if (location.status === "ready")
    return {
      status: "ready",
      browserOpen: (
        <Button variant="outline" asChild>
          <a href={location.url} target="_blank" rel="noopener noreferrer">
            {location.embedded ? "Open in new tab" : "Open app"}
          </a>
        </Button>
      ),
    };
  if (location.status === "pending")
    return {
      status: "unavailable",
      reason: "The app domain is still being prepared.",
      notice: (
        <span className="text-sm text-muted-foreground" role="status">
          Preparing app domain…
        </span>
      ),
    };
  if (location.status === "unavailable")
    return {
      status: "unavailable",
      reason:
        location.reason === "no_ui"
          ? "This app's active version has no page."
          : "This server has no app domain, so app pages have no address.",
    };
  return {
    status: "unavailable",
    reason: unavailableReason,
    notice: checkAgain("App domain setup needs attention.", refresh),
  };
};

function DeployedOpenAppAction({ app }: { readonly app: App }) {
  const { organization, slug, id, name } = useOrganizationRoute();
  const location = appUiLocationAtom({
    organization,
    slug,
    app: app.id,
    appSlug: app.slug,
  });
  const result = useAtomValue(location);
  const refresh = useAtomRefresh(location);
  return (
    <DesktopAppActions
      app={app.id}
      handoff={
        id === undefined
          ? undefined
          : { name: app.name, organization: id, ...(name === undefined ? {} : { team: name }) }
      }
      ui={appUi(result, refresh)}
    />
  );
}

export function AppDesktopSettings({ app }: { readonly app: App }) {
  const host = useDesktopHost();
  if (host === undefined) return null;
  return app.activeVersion === null ? (
    <DesktopAppSection app={app.id} uiReady={false} />
  ) : (
    <DeployedDesktopSettings app={app} />
  );
}

function DeployedDesktopSettings({ app }: { readonly app: App }) {
  const { organization, slug } = useOrganizationRoute();
  const result = useAtomValue(
    appUiLocationAtom({ organization, slug, app: app.id, appSlug: app.slug }),
  );
  return (
    <DesktopAppSection
      app={app.id}
      uiReady={AsyncResult.isSuccess(result) && result.value.status === "ready"}
    />
  );
}
