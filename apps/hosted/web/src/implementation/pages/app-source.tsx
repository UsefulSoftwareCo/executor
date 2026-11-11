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
import { AsyncResult, type Atom } from "effect/reactivity";
import { useContext, useState } from "react";
import {
  activateAppAtom,
  appAtom,
  applyCatalogUpdateAtom,
  catalogUpdateAtom,
  versionsAtom,
  sourceAtom,
  sourceFileAtom,
} from "../../contracts/apps.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Hosts own reads and activation authority; source browsing shares the local presentation. */
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
            notice={app.copiedFrom !== null && <CatalogUpdate app={app} />}
          />
        )}
      </QueryView>
    </>
  );
}

/**
 * A catalog update held back for a copied app, if any. It always breaks accounts or replaces
 * someone's version, so applying it asks first.
 */
function CatalogUpdate({ app }: { readonly app: App }) {
  const { organization } = useOrganizationRoute();
  const result = useAtomValue(catalogUpdateAtom({ organization, app: app.id }));
  const update = AsyncResult.isSuccess(result) ? result.value : null;
  if (update === null) return null;
  return <CatalogUpdateNotice app={app} update={update} />;
}

function CatalogUpdateNotice({
  app,
  update,
}: {
  readonly app: App;
  readonly update: NonNullable<Atom.Success<ReturnType<typeof catalogUpdateAtom>>>;
}) {
  const { organization } = useOrganizationRoute();
  const apply = useAtomSet(applyCatalogUpdateAtom({ organization, app: app.id }), {
    mode: "promiseExit",
  });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<HostedError>>();
  const newAccount = update.reasons.includes("added");
  const run = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const result = await apply();
    setPending(false);
    if (Exit.isFailure(result)) setError(result.cause);
    else setConfirming(false);
  };
  return (
    <div
      role="status"
      className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-2 text-sm max-[740px]:px-4"
    >
      <span>
        Update available
        {update.reconnect > 0 &&
          ` · ${update.reconnect} ${update.reconnect === 1 ? "account needs" : "accounts need"} reconnecting`}
        {newAccount && " · needs a new account"}
      </span>
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
        Update
      </Button>
      {error && !confirming && <HostedFailure cause={error} retry={() => setError(undefined)} />}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setConfirming(false);
            setError(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Update this app?</DialogTitle>
          <DialogDescription>
            {update.touched && "This replaces the version someone deployed; it stays in Versions. "}
            {update.reconnect > 0 &&
              `${update.reconnect} linked ${update.reconnect === 1 ? "account stops" : "accounts stop"} working until reconnected. `}
            {newAccount && "The update needs an account nobody has linked yet. "}
            {update.reasons.includes("cardinality") &&
              "It uses one account where several are linked now. "}
            New calls will use the catalog's current code.
          </DialogDescription>
          {error && <HostedFailure cause={error} retry={() => setError(undefined)} />}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={pending} onClick={() => void run()}>
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The shown version is known from the app, so its source loads alongside the version list. */
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

/** Source inspection, publication, and version history belong to this app's detail page. */
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
