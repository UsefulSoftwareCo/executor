import { EmptyStatePanel } from "@executor-js/ui/dashboard/empty-state";
import { AppWorkspace } from "@executor-js/ui/dashboard/app-workspace";
import { appManagement } from "../../contracts/app-management.ts";
import { acknowledgeApp } from "../../contracts/apps.ts";
import { toolsAtom } from "../../contracts/api.ts";
import { VersionId } from "@executor-js/sdk";
import type { DashboardApp } from "@executor-js/local-server/contracts";
import { useMemo, useState } from "react";
import { sourceAtom, sourceFileAtom } from "../../contracts/api.ts";
import { AppVersions as SharedAppVersions } from "@executor-js/ui/dashboard/app-versions";
import { Failure } from "../components/common.tsx";

export function AppVersions({ data }: { readonly data: DashboardApp }) {
  const [selectedVersion, setSelectedVersion] = useState<VersionId | undefined>(undefined);
  const version = selectedVersion ?? data.app.activeVersion;
  const query = useMemo(
    () => (version === null ? undefined : sourceAtom({ app: data.app.id, version })),
    [data.app.id, version],
  );
  if (version === null || query === undefined)
    return (
      <EmptyStatePanel title="No versions yet">
        Deploy from Source when you’re ready.
      </EmptyStatePanel>
    );
  return (
    <SharedAppVersions
      app={data.app}
      versions={data.versions}
      version={version}
      onVersionChange={setSelectedVersion}
      query={query}
      file={(version, path) => sourceFileAtom({ app: data.app.id, version, path })}
      Failure={Failure}
    />
  );
}

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
        get.refresh(toolsAtom({ app: app.id }));
      }}
      view={view}
      live={
        data.app.activeVersion === null
          ? undefined
          : sourceAtom({ app: data.app.id, version: data.app.activeVersion })
      }
    />
  );
}
