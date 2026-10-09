import {
  useDeferredValue,
  useId,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { AccountId, App, AppId, Profile, ToolName } from "@executor-js/sdk";
import { ConnectionId, type ConnectionView } from "@executor-js/mcp-auth/connections";
import type { AccountSummary, FailureProps, Inventory, Query } from "../../contracts/dashboard.ts";
import {
  type ConnectionApp,
  type ConnectionDraft,
  type ConnectionTarget,
  connectionInput,
  connectionTargetKey,
  connectionTargetLabel,
  connectionToolsLabel,
  connectionEventsLabel,
  type ScopedConnectionBindings,
} from "../../contracts/scoped-connections.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Label } from "../components/label.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/dialog.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { PageFrame, PageHeader } from "./page.tsx";
import { QueryView } from "./context.tsx";
import { ProviderIcon } from "./common.tsx";
import { providerDisplayUrl } from "../../contracts/dashboard.ts";
import {
  appChoices,
  ConnectionAppRow,
  accountOption,
  initialSelection,
  selectionIssue,
  declaresEvents,
  type AppChoices,
} from "./connection-app-picker.tsx";
import { useIncrementalList } from "./incremental-list.tsx";
import { McpInstallInstructions } from "./connect.tsx";
import { publicDocsBaseUrl } from "../../contracts/documentation.ts";

/** Each host supplies its existing authorized, profile-specific catalog read. */
export interface ConnectionToolPickerProps {
  readonly app: App;
  readonly profile: Profile | undefined;
  readonly names: readonly ToolName[];
  readonly onChange: (names: readonly ToolName[]) => void;
}

type View =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly connection: ConnectionId }
  | { readonly kind: "editor"; readonly draft: ConnectionDraft; readonly existing: boolean };

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** Every profile/app choice per app, computed once per inventory. */
const inventoryChoices = (inventory: Inventory) => {
  const profiles = new Map<AppId, Profile[]>();
  for (const profile of inventory.profiles) {
    const list = profiles.get(profile.app);
    if (list === undefined) profiles.set(profile.app, [profile]);
    else list.push(profile);
  }
  return new Map<AppId, AppChoices>(
    inventory.apps.map((app) => [
      app.id,
      appChoices(app, profiles.get(app.id) ?? [], inventory.accounts),
    ]),
  );
};

/** Show a stored connection with current names; removed apps and profiles stay visible as such. */
const connectionDraft = (
  connection: ConnectionView,
  choices: ReadonlyMap<AppId, AppChoices>,
): ConnectionDraft => ({
  id: connection.id,
  name: connection.name,
  apps: connection.policy.apps.map((item) => {
    const choice = choices.get(item.app);
    return {
      id: item.app,
      name: choice?.app.name ?? "Unavailable app",
      tools: item.tools,
      ...(item.events === undefined ? {} : { events: item.events }),
      targets: item.runsAs.map((target): ConnectionTarget => {
        if (target.kind === "app") return target;
        const option = choice?.options.find(
          (candidate) => candidate.target.kind === "profile" && candidate.target.id === target.id,
        );
        return option?.target ?? { kind: "profile", id: target.id, label: "Profile unavailable" };
      }),
    };
  }),
});

const newDraft = (): ConnectionDraft => ({
  id: ConnectionId.make(crypto.randomUUID()),
  name: "",
  apps: [],
});

/**
 * Connections the current user owns. The default connection keeps every app; scoped
 * connections each issue their own MCP URL, and edits apply to connected agents immediately.
 */
export function ScopedConnectionsPage<E, EL extends E, ES extends E, ER extends E>({
  query,
  connections,
  save,
  revoke,
  Failure,
  installation,
  agents,
  docs = publicDocsBaseUrl,
  renderTools,
}: ScopedConnectionBindings<EL, ES, ER> & {
  readonly query: Query<Inventory, E>;
  /** Renders every failure: inventory, connection reads, saves and revocation. */
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly installation: ReactNode;
  /** The agents connected through these URLs, when the host lists them. */
  readonly agents?: ReactNode;
  /** Documentation the setup prompt points agents to. */
  readonly docs?: string;
  readonly renderTools: (props: ConnectionToolPickerProps) => ReactNode;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [revoking, setRevoking] = useState<ConnectionView>();
  const submitRevoke = useAtomSet(revoke, { mode: "promiseExit" });
  const revokeState = useAtomValue(revoke);
  const back = () => setView({ kind: "list" });
  const create = () => setView({ kind: "editor", draft: newDraft(), existing: false });
  return (
    <PageFrame>
      <div className="max-w-260">
        {view.kind !== "list" && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-5 -ml-2 text-muted-foreground"
            onClick={back}
          >
            <HugeiconsIcon icon={ArrowLeft02Icon} size={15} />
            Connections
          </Button>
        )}
        {view.kind === "list" && (
          <div className="max-w-190">
            <PageHeader
              title="Connect your agent"
              description="Works with Claude Code, Cursor, Codex, or any MCP client."
            />
            <section
              aria-label="Agent setup"
              className="mt-2 rounded-xl border bg-muted/20 px-6 pt-5 pb-6 shadow-xs"
            >
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium">Executor MCP server</h2>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  Every app you can use
                </span>
              </div>
              {installation}
            </section>
            <QueryView<readonly ConnectionView[], E>
              query={connections}
              Failure={Failure}
              pending={<ConnectionListSkeleton />}
            >
              {(items) =>
                items.length === 0 ? (
                  <p className="mt-8 text-[13px] text-muted-foreground">
                    Want an agent limited to a few apps or tools?{" "}
                    <button
                      type="button"
                      onClick={create}
                      className="text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
                    >
                      Create a scoped connection
                    </button>
                  </p>
                ) : (
                  <section aria-label="Scoped connections" className="mt-10">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h2 className="text-xs font-medium text-muted-foreground">
                        Scoped connections
                      </h2>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground"
                        onClick={create}
                      >
                        <HugeiconsIcon icon={Add01Icon} size={13} />
                        New scoped connection
                      </Button>
                    </div>
                    <ConnectionList
                      items={items}
                      query={query}
                      onOpen={(connection) => setView({ kind: "detail", connection })}
                    />
                  </section>
                )
              }
            </QueryView>
            {agents}
          </div>
        )}
        {view.kind === "editor" && (
          <>
            <PageHeader
              title={view.existing ? "Edit connection" : "New connection"}
              description="Turn on the apps this agent needs. Everything else stays off. Approval rules come from each app’s code."
            />
            <QueryView query={query} Failure={Failure}>
              {(inventory) => (
                <ConnectionEditor
                  key={view.draft.id}
                  initial={view.draft}
                  existing={view.existing}
                  inventory={inventory}
                  renderTools={renderTools}
                  save={save}
                  Failure={Failure}
                  onCancel={back}
                  onSaved={(saved) => setView({ kind: "detail", connection: saved.id })}
                />
              )}
            </QueryView>
          </>
        )}
        {view.kind === "detail" && (
          <QueryView<readonly ConnectionView[], E> query={connections} Failure={Failure}>
            {(items) => {
              const connection = items.find((item) => item.id === view.connection);
              if (connection === undefined)
                return (
                  <PageHeader
                    title="Connection unavailable"
                    description="This connection was revoked or no longer exists."
                  />
                );
              return (
                <QueryView query={query} Failure={Failure}>
                  {(inventory) => {
                    const draft = connectionDraft(connection, inventoryChoices(inventory));
                    return (
                      <>
                        <PageHeader
                          title={connection.name}
                          description={`${plural(connection.policy.apps.length, "app")}. Every other app is excluded. Approval rules come from each app’s code.`}
                        >
                          <Button
                            variant="outline"
                            onClick={() => setView({ kind: "editor", draft, existing: true })}
                          >
                            Edit access
                          </Button>
                          <Button
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => setRevoking(connection)}
                          >
                            Revoke
                          </Button>
                        </PageHeader>
                        <ConnectionAccessList apps={draft.apps} inventory={inventory} />
                        <section className="mt-8 max-w-190">
                          <h2 className="mb-3 text-sm font-medium">Connect your agent</h2>
                          <McpInstallInstructions
                            endpoint={connection.url}
                            docs={docs}
                            next="show me which apps and tools this connection can use"
                          />
                        </section>
                      </>
                    );
                  }}
                </QueryView>
              );
            }}
          </QueryView>
        )}
      </div>
      <Dialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open && !revokeState.waiting) setRevoking(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>
              Agents using this connection lose access immediately. Its URL stops working.
            </DialogDescription>
          </DialogHeader>
          {AsyncResult.isFailure(revokeState) && <Failure cause={revokeState.cause} />}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={revokeState.waiting}
              onClick={() => setRevoking(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={revokeState.waiting}
              disabled={revokeState.waiting}
              onClick={async () => {
                if (revoking === undefined) return;
                const result = await submitRevoke(revoking.id);
                if (Exit.isSuccess(result)) {
                  setRevoking(undefined);
                  back();
                }
              }}
            >
              Revoke connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageFrame>
  );
}

/** Shares the scoped list's heading and row rhythm so loading does not reflow the page. */
function ConnectionListSkeleton() {
  return (
    <section role="status" aria-label="Loading scoped connections" className="mt-10">
      <div aria-hidden className="mb-2 flex h-6 items-center">
        <Skeleton className="h-3 w-28" />
      </div>
      <div aria-hidden className="divide-y border-y">
        {["w-36", "w-24"].map((width) => (
          <div key={width} className="flex items-center gap-4 px-1 py-3">
            <div className="min-w-0 flex-1 space-y-2 py-px">
              <Skeleton className={`h-3 ${width}`} />
              <Skeleton className="h-2.5 w-48 max-w-[60%]" />
            </div>
            <Skeleton className="h-2.5 w-10" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading scoped connections…</span>
    </section>
  );
}

/** Saved connections; app names come from the current inventory once it loads. */
function ConnectionList<E>({
  items,
  query,
  onOpen,
}: {
  readonly items: readonly ConnectionView[];
  readonly query: Query<Inventory, E>;
  readonly onOpen: (connection: ConnectionId) => void;
}) {
  const inventory = useAtomValue(query);
  const names = new Map<AppId, string>(
    AsyncResult.isSuccess(inventory) ? inventory.value.apps.map((app) => [app.id, app.name]) : [],
  );
  return (
    <div className="divide-y border-y">
      {items.map((item) => {
        const apps = item.policy.apps.map((app) => names.get(app.app) ?? "Unavailable app");
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item.id)}
            className="flex w-full items-center gap-4 px-1 py-3 text-left transition-colors hover:bg-muted/40"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{item.name}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {AsyncResult.isSuccess(inventory) && apps.slice(0, 4).join(", ")}
                {AsyncResult.isSuccess(inventory) &&
                  apps.length > 4 &&
                  ` and ${plural(apps.length - 4, "more", "more")}`}
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {plural(item.policy.apps.length, "app")}
            </span>
            <HugeiconsIcon icon={ArrowRight02Icon} size={15} className="text-muted-foreground" />
          </button>
        );
      })}
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly label: string;
}) {
  return (
    <div className="relative min-w-48 flex-1">
      <HugeiconsIcon
        icon={Search01Icon}
        size={15}
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        className="h-9 pl-9"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly count: number;
  }[];
  readonly onChange: (value: T) => void;
  readonly label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-md border p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded px-2.5 py-1 text-xs transition-colors ${
            value === option.value
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
          <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
            {option.count.toLocaleString("en-US")}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Bulk-including apps leaves each waiting for an account; assign one account to all that accept it. */
function AssignAccount({
  apps,
  byId,
  accounts,
  onAssign,
}: {
  readonly apps: readonly ConnectionApp[];
  readonly byId: ReadonlyMap<AppId, AppChoices>;
  readonly accounts: readonly AccountSummary[];
  readonly onAssign: (account: AccountId) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = new Map<AccountId, { label: string; description: string; fits: number }>();
  for (const app of apps) {
    const choices = byId.get(app.id);
    for (const account of accounts) {
      if (choices === undefined || accountOption(choices, account.id) === undefined) continue;
      const existing = options.get(account.id);
      if (existing === undefined)
        options.set(account.id, {
          label: account.label || "Unnamed account",
          description: account.providerName ?? "Connected account",
          fits: 1,
        });
      else existing.fits += 1;
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-amber-600 dark:text-amber-400"
        >
          Assign account to {plural(apps.length, "app")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-1.5">
        <p className="px-2 pt-1.5 pb-2 text-xs text-muted-foreground">
          Run every included app that isn’t set up yet as this account. Uses a matching saved
          profile when there is one.
        </p>
        {[...options.entries()]
          .toSorted(([, a], [, b]) => b.fits - a.fits)
          .map(([account, option]) => (
            <button
              key={account}
              type="button"
              onClick={() => {
                onAssign(account);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px]">{option.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {option.description}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {option.fits === apps.length ? "All" : `${option.fits} of ${apps.length}`}
              </span>
            </button>
          ))}
      </PopoverContent>
    </Popover>
  );
}

type Filter = "all" | "selected" | "attention";

function ConnectionEditor<E, ES extends E>({
  initial,
  existing,
  inventory,
  renderTools,
  save,
  Failure,
  onCancel,
  onSaved,
}: {
  readonly initial: ConnectionDraft;
  readonly existing: boolean;
  readonly inventory: Inventory;
  readonly renderTools: (props: ConnectionToolPickerProps) => ReactNode;
  readonly save: ScopedConnectionBindings<never, ES, never>["save"];
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onCancel: () => void;
  readonly onSaved: (connection: ConnectionView) => void;
}) {
  const submit = useAtomSet(save, { mode: "promiseExit" });
  const saving = useAtomValue(save);
  const [draft, setDraft] = useState(initial);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>(initial.apps.length > 0 ? "selected" : "all");
  const [expanded, setExpanded] = useState<AppId>();
  const query = useDeferredValue(search.trim().toLowerCase());
  const nameId = useId();
  // Apps already in the connection come first; the order is fixed so rows never jump on toggle.
  const [pinned] = useState(() => new Set(initial.apps.map((app) => app.id)));
  const choices = useMemo(() => {
    const profiles = new Map<AppId, Profile[]>();
    for (const profile of inventory.profiles) {
      const list = profiles.get(profile.app);
      if (list === undefined) profiles.set(profile.app, [profile]);
      else list.push(profile);
    }
    return inventory.apps
      .map((app) => appChoices(app, profiles.get(app.id) ?? [], inventory.accounts))
      .toSorted(
        (a, b) =>
          Number(pinned.has(b.app.id)) - Number(pinned.has(a.app.id)) ||
          a.app.name.localeCompare(b.app.name),
      );
  }, [inventory, pinned]);
  const byId = useMemo(
    () => new Map<AppId, AppChoices>(choices.map((choice) => [choice.app.id, choice])),
    [choices],
  );
  const selections = new Map<AppId, ConnectionApp>(draft.apps.map((app) => [app.id, app]));
  const unavailable = draft.apps.filter((app) => !byId.has(app.id));
  const attention = new Set<AppId>(
    draft.apps.flatMap((selection) => {
      const choice = byId.get(selection.id);
      return choice !== undefined && selectionIssue(choice, selection) !== undefined
        ? [selection.id]
        : [];
    }),
  );
  const visible = choices.filter(
    (choice) =>
      (filter === "all" ||
        (filter === "selected" && selections.has(choice.app.id)) ||
        (filter === "attention" && attention.has(choice.app.id))) &&
      (query === "" || choice.app.name.toLowerCase().includes(query)),
  );
  const addable = visible.filter((choice) => !selections.has(choice.app.id));
  const unassigned = draft.apps.filter(
    (app) => app.targets.length === 0 && (byId.get(app.id)?.options.length ?? 0) > 0,
  );
  const { count, sentinel } = useIncrementalList(visible.length, `${query}:${filter}`);
  const setSelection = (id: AppId, next: ConnectionApp | undefined) =>
    setDraft((previous) => ({
      ...previous,
      apps:
        next === undefined
          ? previous.apps.filter((app) => app.id !== id)
          : previous.apps.some((app) => app.id === id)
            ? previous.apps.map((app) => (app.id === id ? next : app))
            : [...previous.apps, next],
    }));
  const accountCount = new Set(
    draft.apps.flatMap((app) =>
      app.targets.flatMap((target) => (target.kind === "app" ? [] : [connectionTargetKey(target)])),
    ),
  ).size;
  const blocked = attention.size + unavailable.length;
  const input = connectionInput(draft);
  const valid =
    input !== undefined && input.name.length > 0 && draft.apps.length > 0 && blocked === 0;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || saving.waiting) return;
        const saved = await submit({ existing, input });
        if (Exit.isSuccess(saved)) onSaved(saved.value);
      }}
    >
      <div className="mt-6 max-w-md space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={nameId}>Name</Label>
          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            Required
          </span>
        </div>
        <Input
          id={nameId}
          autoFocus={initial.name.length === 0}
          placeholder="e.g. Support assistant"
          required
          maxLength={80}
          value={draft.name}
          onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
        />
      </div>
      {unavailable.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 px-4 py-3 text-sm">
          <span>
            {plural(unavailable.length, "app")} in this connection{" "}
            {unavailable.length === 1 ? "is" : "are"} no longer available:{" "}
            {unavailable.map((app) => app.name).join(", ")}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft((previous) => ({
                ...previous,
                apps: previous.apps.filter((app) => byId.has(app.id)),
              }))
            }
          >
            Remove
          </Button>
        </div>
      )}
      <section aria-label="Apps" className="mt-6 rounded-lg border">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-lg border-b bg-background px-4 py-3">
          <SearchInput
            label="Search apps"
            placeholder={`Search ${plural(choices.length, "app")}…`}
            value={search}
            onChange={setSearch}
          />
          <Tabs
            label="Filter apps"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: choices.length },
              { value: "selected", label: "Included", count: draft.apps.length },
              ...(attention.size > 0 || filter === "attention"
                ? [{ value: "attention" as const, label: "Needs setup", count: attention.size }]
                : []),
            ]}
          />
          {query !== "" && addable.length > 1 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((previous) => ({
                  ...previous,
                  apps: [...previous.apps, ...addable.map(initialSelection)],
                }))
              }
            >
              Include {plural(addable.length, "match", "matches")}
            </Button>
          )}
          {unassigned.length > 0 && (
            <AssignAccount
              apps={unassigned}
              byId={byId}
              accounts={inventory.accounts}
              onAssign={(account) =>
                setDraft((previous) => ({
                  ...previous,
                  apps: previous.apps.map((app) => {
                    const choices = byId.get(app.id);
                    const option =
                      choices === undefined ? undefined : accountOption(choices, account);
                    return app.targets.length === 0 && option !== undefined
                      ? { ...app, targets: [option.target] }
                      : app;
                  }),
                }))
              }
            />
          )}
        </div>
        <div className="divide-y">
          {visible.slice(0, count).map((choice) => (
            <ConnectionAppRow
              key={choice.app.id}
              choices={choice}
              selection={selections.get(choice.app.id)}
              expanded={expanded === choice.app.id}
              onExpandedChange={(open) => setExpanded(open ? choice.app.id : undefined)}
              onChange={(next) => setSelection(choice.app.id, next)}
              renderTools={renderTools}
            />
          ))}
        </div>
        {sentinel}
        {visible.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {query !== ""
              ? "No apps match your search."
              : filter === "selected"
                ? "No apps included yet. Switch to All to turn some on."
                : filter === "attention"
                  ? "Every included app is ready."
                  : "No apps are available."}
          </div>
        )}
      </section>
      <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-4">
        <p className="text-xs text-muted-foreground">
          {draft.apps.length === 0 ? (
            "No apps included"
          ) : (
            <>
              {plural(draft.apps.length, "app")}
              {accountCount > 0 && ` · ${plural(accountCount, "account")}`}
              {blocked > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="text-amber-600 underline underline-offset-2 dark:text-amber-400"
                    onClick={() => setFilter("attention")}
                  >
                    {plural(blocked, "app")} {blocked === 1 ? "needs" : "need"} setup
                  </button>
                </>
              )}
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={saving.waiting} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || saving.waiting} loading={saving.waiting}>
            {existing ? "Save changes" : "Create connection"}
          </Button>
        </div>
        {AsyncResult.isFailure(saving) && (
          <div className="w-full">
            <Failure cause={saving.cause} />
          </div>
        )}
      </div>
    </form>
  );
}

/** Read-only view of a saved connection; long app lists and tool lists render in slices. */
function ConnectionAccessList({
  apps,
  inventory,
}: {
  readonly apps: readonly ConnectionApp[];
  readonly inventory: Inventory;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<AppId>();
  const query = useDeferredValue(search.trim().toLowerCase());
  const byId = useMemo(
    () => new Map<AppId, App>(inventory.apps.map((app) => [app.id, app])),
    [inventory],
  );
  const visible = apps
    .filter((app) => query === "" || app.name.toLowerCase().includes(query))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const { count, sentinel } = useIncrementalList(visible.length, query);
  return (
    <section aria-label="App access" className="mt-6 rounded-lg border">
      {apps.length > 8 && (
        <div className="border-b px-4 py-3">
          <SearchInput
            label="Search included apps"
            placeholder={`Search ${plural(apps.length, "included app")}…`}
            value={search}
            onChange={setSearch}
          />
        </div>
      )}
      <div className="divide-y">
        {visible.slice(0, count).map((selection) => {
          const app = byId.get(selection.id);
          const provider =
            app === undefined ? undefined : Object.values(app.requirements.accounts)[0]?.definition;
          const names = selection.tools.kind === "selected" ? selection.tools.names : [];
          return (
            <div key={selection.id}>
              <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <ProviderIcon
                  name={provider?.name ?? selection.name}
                  url={providerDisplayUrl(provider)}
                />
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block truncate text-[13px] font-medium">{selection.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {app === undefined
                      ? "No longer available"
                      : selection.targets.map(connectionTargetLabel).join(", ")}
                  </span>
                </span>
                {selection.tools.kind === "selected" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    aria-expanded={open === selection.id}
                    onClick={() => setOpen(open === selection.id ? undefined : selection.id)}
                  >
                    {connectionToolsLabel(selection.tools)}
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={14}
                      className={open === selection.id ? "rotate-180" : ""}
                    />
                  </Button>
                ) : (
                  <span className="px-3 text-xs text-muted-foreground">
                    {connectionToolsLabel(selection.tools)}, including new ones
                  </span>
                )}
                {declaresEvents(app) && (
                  <span className="px-3 text-xs text-muted-foreground">
                    {connectionEventsLabel(selection.events)}
                  </span>
                )}
              </div>
              {open === selection.id && <ToolNames names={names} />}
            </div>
          );
        })}
      </div>
      {sentinel}
      {visible.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">No apps match.</p>
      )}
    </section>
  );
}

function ToolNames({ names }: { readonly names: readonly string[] }) {
  const sorted = useMemo(() => names.toSorted(), [names]);
  const { count, sentinel } = useIncrementalList(sorted.length, "", 200);
  return (
    <div className="mx-4 mb-3 max-h-60 overflow-y-auto rounded-md border bg-background p-3 sm:ml-12">
      <div className="flex flex-wrap gap-1.5">
        {sorted.slice(0, count).map((name) => (
          <span key={name} className="rounded border bg-muted/30 px-2 py-0.5 font-mono text-[11px]">
            {name}
          </span>
        ))}
      </div>
      {sentinel}
    </div>
  );
}
