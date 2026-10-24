import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useContext, useState, type ReactNode } from "react";
import { Cause, Effect, Exit, Option, Predicate } from "effect";
import type { App, DeployedApp } from "@executor-js/sdk";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type {
  QueryProps,
  MutationProps,
  InstallApp,
  Inventory,
  Query,
} from "../../contracts/dashboard.ts";
import { Empty, LoadingRows, ProviderIcon, SearchInput } from "./common.tsx";
import { Button } from "../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/dialog.tsx";
import { Input } from "../components/input.tsx";
import { useIncrementalList } from "./incremental-list.tsx";
import { useProductBrand } from "../hooks/product-brand.ts";
import { appDisplayName } from "../../contracts/product-brand.ts";

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
  inventory,
  open,
}: QueryProps<readonly CatalogEntry[], E> & {
  /** The install command for one catalog entry; each row has its own. */
  readonly mutation: (entry: string) => MutationProps<InstallApp, DeployedApp, IE>["mutation"];
  readonly InstallFailure: MutationProps<InstallApp, DeployedApp, IE>["Failure"];
  readonly back: ReactNode;
  readonly action?: ReactNode;
  /** The apps already installed; a failed read just leaves every row on Add. */
  readonly inventory: Query<Inventory, unknown>;
  /** A link to the installed app, rendered inside the row's Open button. */
  readonly open: (app: App) => ReactNode;
}) {
  const brand = useProductBrand();
  const entryName = (entry: { readonly name: string; readonly package: string }) =>
    appDisplayName({ name: entry.name, copiedFrom: { name: entry.package } }, brand);
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
  const templates = AsyncResult.value(result);
  const term = search.trim().toLowerCase();
  // Name matches come first; the rest keep the feed's order.
  const entries = (Option.isSome(templates) ? templates.value : [])
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
    <div className="page w-full shrink-0 max-w-315 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      {back}
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
            Add app
          </h1>
          <p>Find a service to connect.</p>
        </div>
        {action}
      </div>
      <div className="list-toolbar flex flex-wrap items-center gap-[10px_16px] mb-4">
        <SearchInput autoFocus value={search} onChange={setSearch} placeholder="Search apps…" />
        <span className="muted text-muted-foreground">
          {entries.length.toLocaleString("en-US")} apps
        </span>
      </div>
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} retry={retry} />}
      {failure && conflict === undefined && <InstallFailure cause={failure} />}
      {!entries.length && AsyncResult.isInitial(result) ? (
        <LoadingRows />
      ) : !entries.length && AsyncResult.isFailure(result) ? null : !entries.length ? (
        <Empty
          title={search ? "No matching apps" : "No apps available"}
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            ) : (
              action
            )
          }
        >
          {search
            ? "Try another name or connect your own service."
            : "Connect your own service to get started."}
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
                  <strong>{entryName(entry)}</strong>
                  <span className="line-clamp-1">{entry.description}</span>
                </div>
                {(() => {
                  const installed = installedByPackage.get(entry.package);
                  return installed ? (
                    <Button variant="outline" size="sm" asChild>
                      {open(installed)}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Add ${entryName(entry)}`}
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
    </div>
  );
}
