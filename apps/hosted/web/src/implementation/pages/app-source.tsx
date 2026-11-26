import { EmptyStatePanel } from "@executor-js/ui/dashboard/empty-state";
import { AppVersionsLoading } from "@executor-js/ui/dashboard/app-loading";
import { AppWorkspace } from "@executor-js/ui/dashboard/app-workspace";
import { appManagement } from "../../contracts/app-management.ts";
import { acknowledgeApp, toolsAtom } from "../../contracts/apps.ts";
import { RegistryContext, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { App, VersionId } from "@executor-js/sdk";
import { AppVersions as SharedAppVersions } from "@executor-js/ui/dashboard/app-versions";
import { QueryView, usePreload } from "@executor-js/ui/dashboard/context";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { Exit, type Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useContext, useState } from "react";
import {
  activateAppAtom,
  appAtom,
  versionsAtom,
  sourceAtom,
  sourceFileAtom,
} from "../../contracts/apps.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

export function AppVersions({ app }: { readonly app: App }) {
  const { organization } = useOrganizationRoute();
  const [selected, setSelected] = useState<VersionId>();
  const version = selected ?? app.activeVersion;
  if (version === null)
    return (
      <EmptyStatePanel title="No versions yet">
        Deploy from Source when you’re ready.
      </EmptyStatePanel>
    );
  return (
    <>
      <ReadSourceEarly app={app} version={version} />
      <QueryView
        query={versionsAtom({ organization, app: app.id })}
        Failure={HostedFailure}
        pending={<AppVersionsLoading />}
      >
        {(versions) => (
          <SharedAppVersions
            app={app}
            versions={versions}
            version={version}
            onVersionChange={setSelected}
            query={sourceAtom({ organization, app: app.id, version })}
            file={(version, path) => sourceFileAtom({ organization, app: app.id, version, path })}
            Failure={HostedFailure}
            actions={
              version !== app.activeVersion && (
                <ActivateVersion key={version} app={app} version={version} />
              )
            }
          />
        )}
      </QueryView>
    </>
  );
}

function ReadSourceEarly({ app, version }: { readonly app: App; readonly version: VersionId }) {
  const { organization } = useOrganizationRoute();
  const source = sourceAtom({ organization, app: app.id, version });
  usePreload(versionsAtom({ organization, app: app.id }), source);
  useAtomMount(source);
  return null;
}

function ActivateVersion({ app, version }: { readonly app: App; readonly version: VersionId }) {
  const { organization } = useOrganizationRoute();
  const registry = useContext(RegistryContext);
  const source = useAtomValue(sourceAtom({ organization, app: app.id, version }));
  const activate = useAtomSet(activateAppAtom({ organization, app: app.id }), {
    mode: "promiseExit",
  });
  const [expected, setExpected] = useState<VersionId | null>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<HostedError>>();
  const refresh = () => {
    registry.refresh(appAtom({ organization, app: app.id }));
    registry.refresh(versionsAtom({ organization, app: app.id }));
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!AsyncResult.isSuccess(source)}
        onClick={() => {
          setExpected(app.activeVersion);
          setError(undefined);
        }}
      >
        Activate version
      </Button>
      <Dialog
        open={expected !== undefined}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setExpected(undefined);
            setError(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Activate this version?</DialogTitle>
          <DialogDescription>
            New calls will use this code. App data and changes made in other services will not be
            rolled back.
          </DialogDescription>
          {error && (
            <HostedFailure
              cause={error}
              retry={() => {
                refresh();
                setExpected(undefined);
                setError(undefined);
              }}
            />
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setExpected(undefined)}>
              Cancel
            </Button>
            <Button
              loading={pending}
              onClick={async () => {
                if (expected === undefined || pending) return;
                setPending(true);
                setError(undefined);
                const result = await activate({ version, expectedVersion: expected });
                setPending(false);
                if (Exit.isFailure(result)) {
                  setError(result.cause);
                  return;
                }
                setExpected(undefined);
              }}
            >
              Activate version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AppSource({
  app,
  view,
}: {
  readonly app: App;
  readonly view: "source" | "history";
}) {
  const { organization } = useOrganizationRoute();
  const atoms = appManagement(organization);
  return (
    <AppWorkspace
      Failure={HostedFailure}
      app={app}
      atoms={atoms}
      onApp={(get, saved) => {
        acknowledgeApp(get, organization, saved);
        get.refresh(versionsAtom({ organization, app: saved.id }));
        get.refresh(toolsAtom({ organization, app: saved.id }));
      }}
      view={view}
      live={
        app.activeVersion === null
          ? undefined
          : sourceAtom({ organization, app: app.id, version: app.activeVersion })
      }
    />
  );
}
