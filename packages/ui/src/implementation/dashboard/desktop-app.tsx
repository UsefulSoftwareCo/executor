import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerIcon } from "@hugeicons/core-free-icons";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  desktopInstallLink,
  desktopPermissions,
  type DesktopHostBridge,
  type DesktopPermission,
  type DesktopPermissionState,
} from "apps/ui/contracts";
import { desktopDownloadTargets, handheldDevice } from "../../contracts/desktop-download.ts";
import {
  DesktopDownload,
  dashboardDownloadOther,
  dashboardDownloadOtherList,
} from "./desktop-download.tsx";
import {
  currentDesktopHost,
  desktopDownloadPage,
  desktopHostFailure,
  desktopInstallAtom,
  desktopInstalledAtom,
  desktopOpenAtom,
  desktopPermissionLabels,
  desktopPermissionsAtom,
  desktopSetPermissionAtom,
  desktopPlatformOf,
  desktopUninstallAtom,
  DesktopAppKey,
  type DesktopHostFailed,
  type DesktopPermissionChoice,
} from "../../contracts/desktop.ts";
import { Button } from "../components/button.tsx";
import { cn } from "../lib/utils.ts";
import { Skeleton } from "../components/skeleton.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

const unchanging = () => () => {};
const noHost = () => undefined;

export const useDesktopHost = (): DesktopHostBridge | undefined =>
  useSyncExternalStore(unchanging, currentDesktopHost, noHost);

const failureText = (result: AsyncResult.AsyncResult<unknown, DesktopHostFailed>) =>
  AsyncResult.isFailure(result)
    ? Option.match(Cause.findErrorOption(result.cause), {
        onSome: desktopHostFailure,
        onNone: () => "The Executor desktop app did not answer. Try again.",
      })
    : undefined;

export type DesktopAppUi =
  | { readonly status: "ready"; readonly browserOpen: ReactNode }
  | { readonly status: "checking" }
  | { readonly status: "unavailable"; readonly reason: string; readonly notice?: ReactNode };

export interface DesktopHandoff {
  readonly name: string;
  readonly organization?: string;
  readonly team?: string;
}

export function DesktopAppActions({
  app,
  handoff,
  ui,
}: {
  readonly app: string;
  readonly handoff: DesktopHandoff | undefined;
  readonly ui: DesktopAppUi;
}) {
  const host = useDesktopHost();
  if (host === undefined)
    return ui.status === "ready" ? (
      <>
        {ui.browserOpen}
        {handoff !== undefined && <BrowserInstall app={app} handoff={handoff} />}
      </>
    ) : ui.status === "unavailable" ? (
      ui.notice
    ) : null;
  return <InstalledAppActions appKey={new DesktopAppKey({ server: host.server, app })} ui={ui} />;
}

const dialogTargets = desktopDownloadTargets.filter(
  (target) => target.os.startsWith("mac-") || target.os.startsWith("win-"),
);

function BrowserInstall({
  app,
  handoff,
}: {
  readonly app: string;
  readonly handoff: DesktopHandoff;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} aria-hidden size={14} />
        Install as app
      </Button>
      {open && <BrowserInstallDialog app={app} handoff={handoff} />}
    </Dialog>
  );
}

function BrowserInstallDialog({
  app,
  handoff,
}: {
  readonly app: string;
  readonly handoff: DesktopHandoff;
}) {
  const handheld = handheldDevice();
  const platform = desktopPlatformOf(navigator.userAgent);
  const supported = !handheld && platform !== "other";
  const link = desktopInstallLink({
    server: window.location.origin,
    app,
    name: handoff.name,
    ...(handoff.organization === undefined ? {} : { organization: handoff.organization }),
    ...(handoff.team === undefined ? {} : { team: handoff.team }),
  });
  return (
    <DialogContent className="gap-5 sm:max-w-lg">
      <DialogHeader className="pr-8">
        <DialogTitle className="leading-snug">Install {handoff.name} as a desktop app</DialogTitle>
        <DialogDescription>
          {handheld
            ? "Executor's desktop app is for Mac and Windows."
            : supported
              ? "In the Executor desktop app, it gets its own window and icon, and can use the menu bar and keyboard shortcuts."
              : "The Executor desktop app is for Mac and Windows. There, this app gets its own window and icon, and can use the menu bar and keyboard shortcuts."}
        </DialogDescription>
      </DialogHeader>
      {supported && link === undefined && (
        <p className="text-sm text-muted-foreground" role="status">
          The desktop app can't open this dashboard's address. Open the dashboard over HTTPS, or on
          this computer, to install from here.
        </p>
      )}
      {!handheld && (
        <div className="flex items-start justify-between gap-4">
          <DesktopDownload
            targets={dialogTargets}
            fallback={desktopDownloadPage}
            className="shrink-0 flex-col items-start gap-3 whitespace-nowrap"
            otherClassName={cn(dashboardDownloadOther, "self-start")}
            otherListClassName={cn(dashboardDownloadOtherList, "left-0 translate-x-0")}
          />
          {supported && link !== undefined && (
            <div className="flex shrink-0 flex-col items-end gap-3 whitespace-nowrap">
              <Button
                asChild
                className="h-auto border border-transparent px-[1.25rem] py-[0.7rem] text-[14.5px]"
              >
                <a href={link}>Open in Executor</a>
              </Button>
              <p className="text-[13px] text-muted-foreground">
                Nothing opened?{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href={desktopDownloadPage}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Update Executor
                </a>
              </p>
            </div>
          )}
        </div>
      )}
    </DialogContent>
  );
}

function ReadFailure({
  result,
  refresh,
}: {
  readonly result: AsyncResult.AsyncResult<unknown, DesktopHostFailed>;
  readonly refresh: () => void;
}) {
  return (
    <>
      <span className="max-w-sm text-sm text-muted-foreground" role="status">
        {failureText(result)}
      </span>
      <Button variant="outline" onClick={refresh}>
        Check again
      </Button>
    </>
  );
}

function ReservedActions({ label }: { readonly label: string }) {
  return (
    <span role="status" aria-busy aria-label={label} className="contents">
      <Skeleton className="h-9 w-28 max-[740px]:h-11" />
      <Skeleton className="h-9 w-32 max-[740px]:h-11" />
    </span>
  );
}

function InstalledAppActions({
  appKey,
  ui,
}: {
  readonly appKey: DesktopAppKey;
  readonly ui: DesktopAppUi;
}) {
  const installed = useAtomValue(desktopInstalledAtom(appKey));
  const refresh = useAtomRefresh(desktopInstalledAtom(appKey));
  const install = useAtomSet(desktopInstallAtom(appKey)),
    installing = useAtomValue(desktopInstallAtom(appKey));
  const uninstall = useAtomSet(desktopUninstallAtom(appKey)),
    uninstalling = useAtomValue(desktopUninstallAtom(appKey));
  const open = useAtomSet(desktopOpenAtom(appKey)),
    opening = useAtomValue(desktopOpenAtom(appKey));
  const current = AsyncResult.value(installed);
  const problem = failureText(installing) ?? failureText(uninstalling) ?? failureText(opening);
  const notices = (
    <>
      {ui.status === "unavailable" && ui.notice}
      {problem && (
        <span className="max-w-sm text-sm text-muted-foreground" role="alert">
          {problem}
        </span>
      )}
      {AsyncResult.isFailure(installed) && <ReadFailure result={installed} refresh={refresh} />}
    </>
  );
  if (Option.isNone(current))
    return AsyncResult.isFailure(installed) ? (
      <>
        {notices}
        {ui.status === "ready" && ui.browserOpen}
      </>
    ) : (
      <>
        {notices}
        <ReservedActions label="Checking the desktop app" />
      </>
    );
  if (current.value === null)
    return (
      <>
        {notices}
        {ui.status === "ready" ? (
          <>
            {ui.browserOpen}
            <Button variant="outline" disabled={installing.waiting} onClick={() => install()}>
              <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} aria-hidden size={14} />
              {installing.waiting ? "Installing…" : "Install as app"}
            </Button>
          </>
        ) : (
          ui.status === "checking" && <ReservedActions label="Checking the app's page" />
        )}
      </>
    );
  return (
    <>
      {notices}
      <Button
        variant="outline"
        disabled={opening.waiting}
        disabledReason={
          ui.status === "ready"
            ? undefined
            : ui.status === "checking"
              ? "Checking the app's page…"
              : ui.reason
        }
        onClick={() => open()}
      >
        <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} aria-hidden size={14} />
        Open app
      </Button>
      <Button variant="outline" disabled={uninstalling.waiting} onClick={() => uninstall()}>
        {uninstalling.waiting ? "Uninstalling…" : "Uninstall"}
      </Button>
    </>
  );
}

export function DesktopAppSection({
  app,
  uiReady,
}: {
  readonly app: string;
  readonly uiReady: boolean;
}) {
  const host = useDesktopHost();
  if (host === undefined) return null;
  const appKey = new DesktopAppKey({ server: host.server, app });
  return uiReady ? (
    <DesktopPermissions appKey={appKey} />
  ) : (
    <InstalledPermissions appKey={appKey} />
  );
}

function InstalledPermissions({ appKey }: { readonly appKey: DesktopAppKey }) {
  const installed = AsyncResult.value(useAtomValue(desktopInstalledAtom(appKey)));
  return Option.isSome(installed) && installed.value !== null ? (
    <DesktopPermissions appKey={appKey} />
  ) : null;
}

function DesktopPermissions({ appKey }: { readonly appKey: DesktopAppKey }) {
  const permissions = useAtomValue(desktopPermissionsAtom(appKey));
  const refresh = useAtomRefresh(desktopPermissionsAtom(appKey));
  const rows = (state: (permission: DesktopPermission) => ReactNode) =>
    desktopPermissions.map((permission) => (
      <li
        key={permission}
        className="flex flex-wrap items-center justify-between gap-4 border-t px-5 py-4"
      >
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium">{desktopPermissionLabels[permission].name}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {desktopPermissionLabels[permission].description}
          </p>
        </div>
        {state(permission)}
      </li>
    ));
  const controls = (current: Record<DesktopPermission, DesktopPermissionState>) => (
    <ul>
      {rows((permission) => (
        <PermissionControl appKey={appKey} permission={permission} state={current[permission]} />
      ))}
    </ul>
  );
  const readFailure = AsyncResult.isFailure(permissions) && (
    <div className="flex flex-wrap items-center gap-3 border-t px-5 py-4">
      <span className="text-sm text-muted-foreground" role="status">
        {failureText(permissions)}
      </span>
      <Button variant="outline" size="sm" onClick={refresh}>
        Check again
      </Button>
    </div>
  );
  return (
    <section aria-label="Desktop" className="overflow-hidden rounded-lg border">
      <div className="p-5">
        <h3 className="text-sm font-medium">Desktop</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          What this app may do when it runs as an installed app on this computer. It asks the first
          time it needs each one.
        </p>
      </div>
      {readFailure}
      {AsyncResult.match(permissions, {
        onInitial: () => (
          <ul aria-busy>
            {rows(() => (
              <Skeleton className="h-9 w-40 max-[740px]:h-11" />
            ))}
          </ul>
        ),
        onFailure: (failure) =>
          Option.match(AsyncResult.value(failure), {
            onNone: () => null,
            onSome: controls,
          }),
        onSuccess: ({ value }) => controls(value),
      })}
    </section>
  );
}

const choiceLabels: Record<DesktopPermissionChoice, string> = {
  granted: "Allow",
  denied: "Don't allow",
  prompt: "Ask next time",
};
const isChoice = (value: string): value is DesktopPermissionChoice => value in choiceLabels;

function PermissionControl({
  appKey,
  permission,
  state,
}: {
  readonly appKey: DesktopAppKey;
  readonly permission: DesktopPermission;
  readonly state: DesktopPermissionState;
}) {
  const set = useAtomSet(desktopSetPermissionAtom(appKey, permission)),
    setting = useAtomValue(desktopSetPermissionAtom(appKey, permission));
  const name = desktopPermissionLabels[permission].name;
  if (state === "unavailable")
    return <span className="text-sm text-muted-foreground">Not available on this computer</span>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {AsyncResult.isFailure(setting) && (
        <span className="text-xs text-muted-foreground" role="alert">
          {failureText(setting)}
        </span>
      )}
      <Select
        value={state}
        disabled={setting.waiting}
        onValueChange={(value) => {
          if (isChoice(value)) set(value);
        }}
      >
        <SelectTrigger aria-label={`${name} permission`} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(choiceLabels).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
