import { EmptyStatePanel } from "@executor-js/ui/dashboard/empty-state";
import { AppWorkspace } from "@executor-js/ui/dashboard/app-workspace";
import { appManagement } from "../../contracts/app-management.ts";
import { acknowledgeApp } from "../../contracts/apps.ts";
import { toolsAtom } from "../../contracts/api.ts";
import { DeploymentId } from "@executor-js/sdk";
import type { DashboardApp } from "@executor-js/local-server/contracts";
import { useMemo, useState } from "react";
import { sourceAtom } from "../../contracts/api.ts";
import { AppDeployments as SharedAppDeployments } from "@executor-js/ui/dashboard/app-deployments";
import { Failure } from "../components/common.tsx";

/** Inspect immutable source versions; choosing a version never changes the active deployment. */
export function AppDeployments({ data }: { readonly data: DashboardApp }) {
  const [selectedDeployment, setSelectedDeployment] = useState<DeploymentId | undefined>(undefined);
  const deployment = selectedDeployment ?? data.app.activeDeployment;
  const query = useMemo(
    () => (deployment === null ? undefined : sourceAtom({ app: data.app.id, deployment })),
    [data.app.id, deployment],
  );
  if (deployment === null || query === undefined)
    return (
      <EmptyStatePanel title="No deployments yet">
        Deploy from Source when you’re ready.
      </EmptyStatePanel>
    );
  return (
    <SharedAppDeployments
      app={data.app}
      deployments={data.deployments}
      deployment={deployment}
      onDeploymentChange={setSelectedDeployment}
      query={query}
      Failure={Failure}
    />
  );
}

/** Local app source uses shared read-only inspection and the existing live app inventory. */
export function AppSource({
  data,
  view,
}: {
  readonly data: DashboardApp;
  readonly view: "source" | "history";
}) {
  return (
    <AppWorkspace
      Failure={Failure}
      app={data.app}
      atoms={appManagement}
      onApp={(get, app) => {
        acknowledgeApp(get, app);
        get.refresh(toolsAtom(app.id));
      }}
      view={view}
    />
  );
}
