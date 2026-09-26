/** Resolve visible account choices without selecting a session-wide default. */
import type { App, AppId } from "@executor-js/sdk";
import { QueryResult, QueryView, useQuery } from "@executor-js/ui/dashboard/context";
import { AppLaunch } from "@executor-js/ui/dashboard/app-launch";
import { accountContexts } from "@executor-js/ui/dashboard/account-group";
import type { AppReturnPath } from "@executor-js/ui/contracts/app-launch";
import type { AccountSummary, FailureProps } from "@executor-js/ui/contracts/dashboard";
import type { Profile } from "@executor-js/sdk";
import { Link } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { appAtom } from "../../contracts/apps.ts";
import { profilesAtom } from "../../contracts/profiles.ts";
import { appUiLocationAtom, appUiError, type AppUiError } from "../../contracts/app-ui.ts";
const pending = (
  <p className="p-6 text-sm text-muted-foreground" role="status">
    Loading app choices…
  </p>
);
/** The dashboard session lists only this subject's profiles and accessible account names. */
export function AppLaunchPage({
  appId: app,
  returnTo,
}: {
  readonly appId: AppId;
  readonly returnTo: AppReturnPath;
}) {
  const { organization } = useOrganizationRoute();
  const metadata = useQuery(appAtom({ organization, app }));
  const profiles = useQuery(profilesAtom({ organization, app }));
  const inventory = useQuery(useDashboardAtoms().inventory);
  return (
    <QueryResult
      result={metadata.result}
      retry={metadata.refresh}
      Failure={HostedFailure}
      pending={pending}
    >
      {(app) => (
        <QueryResult
          result={profiles.result}
          retry={profiles.refresh}
          Failure={HostedFailure}
          pending={pending}
        >
          {(entries) => (
            <QueryResult
              result={inventory.result}
              retry={inventory.refresh}
              Failure={HostedFailure}
              pending={pending}
            >
              {(data) => (
                <LaunchLocation
                  app={app}
                  profiles={entries}
                  accounts={data.accounts}
                  returnTo={returnTo}
                />
              )}
            </QueryResult>
          )}
        </QueryResult>
      )}
    </QueryResult>
  );
}
function LaunchLocation({
  app,
  profiles,
  accounts,
  returnTo,
}: {
  readonly app: App;
  readonly profiles: readonly Profile[];
  readonly accounts: readonly AccountSummary[];
  readonly returnTo: AppReturnPath;
}) {
  const { organization, slug } = useOrganizationRoute();
  if (app.activeDeployment === null)
    return <p className="p-6 text-sm">Deploy this app before opening it.</p>;
  return (
    <QueryView
      query={appUiLocationAtom({
        organization,
        slug,
        app: app.id,
        appSlug: app.slug,
        deployment: app.activeDeployment,
      })}
      Failure={AppLocationFailure}
      pending={pending}
    >
      {(location) =>
        location.status === "ready" ? (
          <AppLaunch
            app={app}
            origin={location.url}
            returnTo={returnTo}
            accounts={accounts}
            contexts={accountContexts(app, profiles)}
            manage={
              <Link
                to="/org/$organizationSlug/apps/$appId"
                params={{ organizationSlug: slug, appId: app.id }}
                search={{ view: "accounts" }}
              >
                Manage accounts
              </Link>
            }
          />
        ) : (
          <p className="p-6 text-sm text-muted-foreground" role="status">
            {location.status === "pending"
              ? "Preparing app domain…"
              : "This app's page is unavailable."}
          </p>
        )
      }
    </QueryView>
  );
}
function AppLocationFailure({ cause, retry }: FailureProps<AppUiError>) {
  return (
    <div className="space-y-3 p-6">
      <p role="alert" className="text-sm">
        {appUiError(cause)}
      </p>
      {retry && (
        <Button variant="outline" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
