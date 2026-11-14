import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useContext, useState, type ReactNode } from "react";
import { Cause, Effect, Exit, Option, Predicate } from "effect";
import type { App, DeployedApp } from "@executor-js/sdk";
import type {
  CatalogEntry,
  CatalogFeedState,
  CatalogListing,
} from "@executor-js/catalog/contracts";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  QueryProps,
  MutationProps,
  InstallApp,
  Inventory,
  Query,
} from "../../contracts/dashboard.ts";
import { Empty, ProviderIcon, SearchInput } from "./common.tsx";
import { CatalogCountSkeleton, CatalogPageFrame, CatalogRowsSkeleton } from "./loading.tsx";
import { Button } from "../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/dialog.tsx";
import { Input } from "../components/input.tsx";
import { Alert, AlertDescription, AlertTitle } from "../components/alert.tsx";
import { ErrorNotice } from "./error-notice.tsx";
import { useIncrementalList } from "./incremental-list.tsx";

/**
 * The installed copy of each catalog package, by package name. Installs record the catalog package
 * as their copy origin, so the most recent copy of a package is the one a catalog row leads to.
 */
export function installedCatalogApps(apps: readonly App[] | undefined): ReadonlyMap<string, App> {
  const installed = new Map<string, App>();
  for (const app of apps ?? []) {
    const name = app.copiedFrom?.name;
    const latest = name === undefined ? undefined : installed.get(name);
    if (name !== undefined && (!latest || app.createdAt > latest.createdAt))
      installed.set(name, app);
  }
  return installed;
}

/**
 * Why Executor's official apps are missing from a listing: this instance turned its catalog off, or
 * the server could not read the feed. Renders nothing when the feed was listed.
 */
export function CatalogFeedNotice({
  feed,
  retry,
  retrying,
  layout,
}: {
  readonly feed: CatalogFeedState;
  readonly retry: () => void;
  /** The listing is being read again, so Try again shows that it is checking. */
  readonly retrying: boolean;
  readonly layout?: "inline" | "compact";
}) {
  switch (feed.status) {
    case "listed":
      return null;
    case "unavailable":
      return (
        <ErrorNotice
          error={feed.error}
          context="Executor could not list the official apps in its app catalog."
          retry={retry}
          retrying={retrying}
          retryStatus="Checking the app catalog"
          layout={layout}
        />
      );
    case "off":
      return (
        <Alert role="note" className="border-border bg-muted/30 [&>svg]:text-muted-foreground">
          <HugeiconsIcon icon={InformationCircleIcon} size={16} aria-hidden />
          <AlertTitle role="heading" aria-level={3} className="line-clamp-none leading-5">
            App catalog turned off
          </AlertTitle>
          <AlertDescription className="text-[13px] text-muted-foreground">
            <p>
              Executor’s official apps are not listed because this instance’s app catalog is turned
              off. Whoever runs it can list them by removing{" "}
              <code className="font-mono text-[12px]">EXECUTOR_CATALOG_URL=off</code>.
            </p>
          </AlertDescription>
        </Alert>
      );
  }
}

/** Runs one catalog entry's install and resolves with that entry's own result. */
export function useCatalogInstall<IE>(
  mutation: (entry: string) => MutationProps<InstallApp, DeployedApp, IE>["mutation"],
) {
  const registry = useContext(RegistryContext);
  return async (entry: CatalogEntry, input: InstallApp) => {
    const command = mutation(entry.id);
    const release = registry.mount(command);
    try {
      registry.set(command, input);
      return await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, command, { suspendOnWaiting: true }),
      );
    } finally {
      release();
    }
  };
}

/**
 * Official apps available to add, in the feed's order. Published registry apps are not listed here.
 * Catalog apps are vetted, so each row installs its own source under the catalog name. Only a name
 * conflict asks for another one. The page stays put after an add; a row whose app is installed, now
 * or in an earlier visit, offers Open instead of Add. Installs record the catalog package name as
 * their copy origin, so the most recent copy of that package is the one Open leads to. The user
 * then connects an account through the app's own providers.
 */
export function CatalogPage<E, IE>({
  query,
  Failure,
  mutation,
  InstallFailure,
  back,
  action,
  create,
  inventory,
  open,
}: QueryProps<CatalogListing, E> & {
  /** The install command for one catalog entry; each row has its own. */
  readonly mutation: (entry: string) => MutationProps<InstallApp, DeployedApp, IE>["mutation"];
  readonly InstallFailure: MutationProps<InstallApp, DeployedApp, IE>["Failure"];
  readonly back: ReactNode;
  /** The heading's action, beside the title. */
  readonly action?: ReactNode;
  /** Offers the ways to make an app when nothing here fits. */
  readonly create?: ReactNode;
  /** The apps already installed; a failed read just leaves every row on Add. */
  readonly inventory: Query<Inventory, unknown>;
  /** A link to the installed app, rendered inside the row's Open button. */
  readonly open: (app: App) => ReactNode;
}) {
  const result = useAtomValue(query);
  const installedByPackage = installedCatalogApps(
    Option.getOrUndefined(AsyncResult.value(useAtomValue(inventory)))?.apps,
  );
  const install = useCatalogInstall(mutation);
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<Cause.Cause<IE>>();
  const [conflict, setConflict] = useState<{
    readonly entry: CatalogEntry;
    readonly name: string;
  }>();
  /** Installs under `name`; a taken name reopens the prompt, any other failure is shown above the list. */
  const add = async (entry: CatalogEntry, name: string) => {
    if (adding.has(entry.id) || !name.trim()) return;
    setAdding((current) => new Set(current).add(entry.id));
    setFailure(undefined);
    try {
      const exit = await install(entry, { entry: entry.id, name: name.trim() });
      if (Exit.isSuccess(exit)) {
        setConflict(undefined);
        return;
      }
      const taken = Option.filter(
        Cause.findErrorOption(exit.cause),
        Predicate.isTagged("AppNameTaken"),
      );
      setFailure(exit.cause);
      setConflict(Option.isSome(taken) ? { entry, name: name.trim() } : undefined);
    } finally {
      setAdding((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
    }
  };
  const renaming = conflict !== undefined && adding.has(conflict.entry.id);
  const retry = useAtomRefresh(query);
  const [search, setSearch] = useState("");
  const listing = AsyncResult.value(result);
  const feed = Option.isSome(listing) ? listing.value.feed : undefined;
  const term = search.trim().toLowerCase();
  // Name matches come first; the rest keep the feed's order.
  const entries = (Option.isSome(listing) ? listing.value.apps : [])
    .filter((entry) =>
      `${entry.name} ${entry.package} ${entry.category ?? ""} ${entry.description}`
        .toLowerCase()
        .includes(term),
    )
    .sort(
      (a, b) =>
        Number(!a.name.toLowerCase().includes(term)) - Number(!b.name.toLowerCase().includes(term)),
    );
  const visible = useIncrementalList(entries.length, term, 50);
  return (
    <CatalogPageFrame
      back={back}
      action={action}
      toolbar={
        <>
          <SearchInput autoFocus value={search} onChange={setSearch} placeholder="Search apps…" />
          {AsyncResult.isInitial(result) && !entries.length ? (
            <CatalogCountSkeleton />
          ) : (
            <span className="muted min-w-20 text-muted-foreground tabular-nums">
              {entries.length.toLocaleString("en-US")} apps
            </span>
          )}
        </>
      }
    >
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} retry={retry} />}
      {feed && (
        <CatalogFeedNotice feed={feed} retry={retry} retrying={AsyncResult.isWaiting(result)} />
      )}
      {failure && conflict === undefined && <InstallFailure cause={failure} />}
      {!entries.length && AsyncResult.isInitial(result) ? (
        <CatalogRowsSkeleton />
      ) : !entries.length &&
        (AsyncResult.isFailure(result) ||
          (!search && feed && feed.status !== "listed")) ? null : !entries.length ? (
        <Empty
          title={search ? "No matching apps" : "No apps available"}
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            ) : undefined
          }
        >
          {create ? <MissingApp create={create} /> : "Try another name."}
        </Empty>
      ) : (
        <>
          <div className="catalog-list border-t border-t-border">
            {entries.slice(0, visible.count).map((entry) => (
              <div
                className="catalog-row w-full flex items-center gap-4 min-h-18.5 py-[15px] px-[12px] border-b border-b-border max-[740px]:grid max-[740px]:grid-cols-[34px_minmax(0,_1fr)_auto] max-[740px]:gap-[4px_12px] max-[740px]:py-[15px] max-[740px]:px-0 max-[740px]:[&_>_[data-slot='button']]:col-[3] max-[740px]:[&_>_[data-slot='button']]:row-[1_/_3]"
                key={entry.id}
              >
                <ProviderIcon name={entry.name} icons={entry.icons} />
                <div className="catalog-row-title flex-1 flex flex-col gap-1.25 min-w-0 [&_strong]:text-[13px] [&_strong]:font-medium [&_span]:text-[12px] [&_span]:text-muted-foreground wrap-anywhere max-[740px]:col-[2]">
                  <strong>{entry.name}</strong>
                  <span className="line-clamp-1">{entry.description}</span>
                </div>
                {(() => {
                  const installed = installedByPackage.get(entry.package);
                  return installed ? (
                    <Button variant="outline" size="sm" className="min-w-21" asChild>
                      {open(installed)}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-w-21"
                      aria-label={`Add ${entry.name}`}
                      disabled={adding.has(entry.id)}
                      onClick={() => void add(entry, entry.name)}
                    >
                      {adding.has(entry.id) ? "Adding…" : "Add"}
                    </Button>
                  );
                })()}
              </div>
            ))}
          </div>
          {visible.sentinel}
          {create && (
            <p className="mt-6 text-center text-[13px] text-muted-foreground">
              <MissingApp create={create} />
            </p>
          )}
        </>
      )}
      <Dialog
        open={conflict !== undefined}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setConflict(undefined);
            setFailure(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Choose another name</DialogTitle>
          <DialogDescription>
            {conflict ? `You already have an app named ${conflict.entry.name}.` : null}
          </DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (conflict) void add(conflict.entry, conflict.name);
            }}
          >
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
              App name
              <Input
                autoFocus
                required
                maxLength={120}
                value={conflict?.name ?? ""}
                onChange={(event) =>
                  setConflict((current) => current && { ...current, name: event.target.value })
                }
                disabled={renaming}
              />
            </label>
            {failure && <InstallFailure cause={failure} layout="compact" />}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => {
                  setConflict(undefined);
                  setFailure(undefined);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || !conflict?.name.trim()}>
                {renaming ? "Adding…" : "Add app"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </CatalogPageFrame>
  );
}

function MissingApp({ create }: { readonly create: ReactNode }) {
  return <>Can’t find what you’re looking for? {create}</>;
}
