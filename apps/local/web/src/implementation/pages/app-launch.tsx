/** Local launch choices use the paired browser's accounts without hosted identity concepts. */
import type { AppId } from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import type { AppReturnPath } from "@executor-js/ui/contracts/app-launch";
import { AppLaunch } from "@executor-js/ui/dashboard/app-launch";
import { accountContexts } from "@executor-js/ui/dashboard/account-group";
import { QueryResult, useQuery } from "@executor-js/ui/dashboard/context";
import { Link } from "@tanstack/react-router";
import { appAtom } from "../../contracts/api.ts";
import { profilesAtom } from "../../contracts/profiles.ts";
import { Failure } from "../components/common.tsx";
const pending = (
  <p className="p-6 text-sm text-muted-foreground" role="status">
    Loading app choices…
  </p>
);
/** The returned app URL is product-owned; query input can only select a path on that origin. */
export function AppLaunchPage({
  id,
  data,
  returnTo,
}: {
  readonly id: AppId;
  readonly data: DashboardOverview;
  readonly returnTo: AppReturnPath;
}) {
  const app = useQuery(appAtom(id)),
    profiles = useQuery(profilesAtom({ app: id }));
  return (
    <QueryResult result={app.result} retry={app.refresh} Failure={Failure} pending={pending}>
      {(current) => (
        <QueryResult
          result={profiles.result}
          retry={profiles.refresh}
          Failure={Failure}
          pending={pending}
        >
          {(entries) =>
            current.uiUrl === null ? (
              <p className="p-6 text-sm">This app has no UI.</p>
            ) : (
              <AppLaunch
                app={current.app}
                origin={current.uiUrl}
                returnTo={returnTo}
                contexts={accountContexts(current.app, entries)}
                accounts={data.accounts}
                manage={
                  <Link to="/apps/$appId" params={{ appId: id }} search={{ view: "accounts" }}>
                    Manage accounts
                  </Link>
                }
              />
            )
          }
        </QueryResult>
      )}
    </QueryResult>
  );
}
