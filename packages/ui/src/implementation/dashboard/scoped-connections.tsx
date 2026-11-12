/**
 * Connections the current user owns. The full-access URL reaches every app; each scoped
 * connection issues its own MCP URL, and edits apply to connected agents immediately. The list
 * shows every connection as a card, and each scoped connection has its own page, where its access
 * is edited in place.
 */
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
import type { AccountId, App, AppId, ToolName } from "@executor-js/sdk";
import { ConnectionId, type ConnectionView } from "@executor-js/mcp-auth/connections";
import { randomUuid } from "@executor-js/utils/random-uuid";
import { copyText } from "../lib/clipboard.ts";
import type { AccountSummary, FailureProps, Inventory, Query } from "../../contracts/dashboard.ts";
import {
  type ConnectionApp,
  type ConnectionDraft,
  type ConnectionTarget,
  connectionInput,
  defaultConnectionName,
  type ScopedConnectionBindings,
} from "../../contracts/scoped-connections.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft02Icon,
  ConnectIcon,
  Copy01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  Search01Icon,
  Tick02Icon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.tsx";
import { cn } from "../lib/utils.ts";
import { PageFrame } from "./page.tsx";
import { allResults, LoadingRows, QueryResult, usePreload, useQuery } from "./context.tsx";
import { AppIcon } from "./common.tsx";
import {
  appChoices,
  ConnectionAppRow,
  accountOption,
  initialSelection,
  selectionIssue,
  type AppChoices,
} from "./connection-app-picker.tsx";
import { useIncrementalList } from "./incremental-list.tsx";

/** Each host supplies its existing authorized catalog read of the app's tools. */
export interface ConnectionToolPickerProps {
  readonly app: App;
  readonly names: readonly ToolName[];
  readonly onChange: (names: readonly ToolName[]) => void;
}

/** Host routing remains typed by that host's router. */
export interface ConnectionLinkProps {
  /** The connection's page, `new` for the page that creates one, or the list when omitted. */
  readonly connection?: ConnectionId | "new";
  readonly className?: string;
  readonly children: ReactNode;
}

/** The URL an agent connects to; `apps` is undefined for the full-access URL. */
export interface ConnectTarget {
  readonly name: string;
  readonly url: string;
  readonly apps: readonly string[] | undefined;
}

/** What both connection pages read and render through the host. */
interface ConnectionPageBindings<
  E,
  EL extends E,
  ES extends E,
  ER extends E,
> extends ScopedConnectionBindings<EL, ES, ER> {
  readonly query: Query<Inventory, E>;
  /** Renders every failure: inventory, connection reads, saves and revocation. */
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly ConnectionLink: ComponentType<ConnectionLinkProps>;
  /** How an agent connects to a target's URL, shown in the Connect dialog. */
  readonly renderInstallation: (target: ConnectTarget) => ReactNode;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** The inventory and connections as one read, so both pages wait for and report them once. */
function ConnectionReads<E, EL extends E>({
  query,
  connections,
  Failure,
  pending,
  children,
}: {
  readonly query: Query<Inventory, E>;
  readonly connections: Query<readonly ConnectionView[], EL>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly pending: ReactNode;
  readonly children: (inventory: Inventory, connections: readonly ConnectionView[]) => ReactNode;
}) {
  usePreload(query, connections);
  const inventory = useQuery(query);
  const stored = useQuery(connections);
  return (
    <QueryResult<{ inventory: Inventory; stored: readonly ConnectionView[] }, E>
      result={allResults({ inventory: inventory.result, stored: stored.result })}
      Failure={Failure}
      retry={() => {
        inventory.refresh();
        stored.refresh();
      }}
      pending={pending}
    >
      {(value) => children(value.inventory, value.stored)}
    </QueryResult>
  );
}

interface ConnectionCardView {
  readonly id: ConnectionId | undefined;
  readonly name: string;
  readonly url: string;
  readonly apps: readonly { readonly app: App | undefined; readonly name: string }[];
}

/** The full-access URL first, then each scoped connection. */
const connectionCards = (
  endpoint: string,
  connections: readonly ConnectionView[],
  apps: readonly App[],
): readonly ConnectionCardView[] => {
  const byId = new Map<AppId, App>(apps.map((app) => [app.id, app]));
  return [
    {
      id: undefined,
      name: "Full access",
      url: endpoint,
      apps: apps.map((app) => ({ app, name: app.name })),
    },
    ...connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      url: connection.url,
      apps: connection.policy.apps.map((item) => {
        const app = byId.get(item.app);
        return { app, name: app?.name ?? "Unavailable app" };
      }),
    })),
  ];
};

/** Every connection as a card; each opens the Connect dialog, and a scoped one opens its page. */
export function ScopedConnectionsPage<E, EL extends E, ES extends E, ER extends E>({
  endpoint,
  agents,
  ...bindings
}: ConnectionPageBindings<E, EL, ES, ER> & {
  /** The full-access URL. */
  readonly endpoint: string;
  /** The agents connected through these URLs, when the host lists them. */
  readonly agents?: ReactNode;
}) {
  const { query, connections, Failure, ConnectionLink, renderInstallation } = bindings;
  const [connecting, setConnecting] = useState<ConnectionCardView>();
  return (
    <PageFrame>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.035em]">Connections</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Each connection gives an agent its own MCP URL that reaches only the apps you pick.
          </p>
        </div>
        <Button asChild>
          <ConnectionLink connection="new">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
            New connection
          </ConnectionLink>
        </Button>
      </header>
      <ConnectionReads
        query={query}
        connections={connections}
        Failure={Failure}
        pending={<LoadingRows count={4} />}
      >
        {(inventory, stored) => (
          <div
            role="list"
            aria-label="Connections"
            className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1"
          >
            {connectionCards(endpoint, stored, inventory.apps).map((card) => (
              <ConnectionCard
                key={card.id ?? "full"}
                connection={card}
                ConnectionLink={ConnectionLink}
                onConnect={setConnecting}
              />
            ))}
          </div>
        )}
      </ConnectionReads>
      {agents}
      <ConnectDialog
        target={
          connecting === undefined
            ? undefined
            : {
                name: connecting.name,
                url: connecting.url,
                apps:
                  connecting.id === undefined ? undefined : connecting.apps.map((app) => app.name),
              }
        }
        renderInstallation={renderInstallation}
        onClose={() => setConnecting(undefined)}
      />
    </PageFrame>
  );
}

function ConnectDialog({
  target,
  renderInstallation,
  onClose,
}: {
  readonly target: ConnectTarget | undefined;
  readonly renderInstallation: (target: ConnectTarget) => ReactNode;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect {target?.name}</DialogTitle>
          <DialogDescription>
            {target?.apps === undefined
              ? "This URL reaches every app. Make a new connection to limit what an agent sees."
              : `This URL only reaches ${target.apps.join(", ")}.`}
          </DialogDescription>
        </DialogHeader>
        {target && renderInstallation(target)}
      </DialogContent>
    </Dialog>
  );
}

/** A scoped card opens its page; the stretched name link keeps Connect a separate button. */
function ConnectionCard({
  connection,
  ConnectionLink,
  onConnect,
}: {
  readonly connection: ConnectionCardView;
  readonly ConnectionLink: ComponentType<ConnectionLinkProps>;
  readonly onConnect: (connection: ConnectionCardView) => void;
}) {
  const shown = connection.apps.slice(0, 4);
  return (
    <div
      role="listitem"
      aria-label={connection.name}
      className="relative flex min-h-56 flex-col rounded-xl border border-border p-4 transition-colors has-[a:hover]:border-muted-foreground/40 has-[a:hover]:bg-muted/60 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring max-[600px]:min-h-0"
    >
      <span className="flex items-center gap-2">
        {connection.id === undefined ? (
          <span className="text-[14px] font-medium">{connection.name}</span>
        ) : (
          <ConnectionLink
            connection={connection.id}
            className="text-[14px] font-medium after:absolute after:inset-0 after:rounded-xl"
          >
            {connection.name}
          </ConnectionLink>
        )}
        {connection.id === undefined && (
          <span className="rounded-md border border-border px-1.5 py-px text-[11px] text-muted-foreground">
            Default
          </span>
        )}
      </span>
      <ul className="mt-4 grid gap-1.5">
        {shown.map((item) => (
          <li key={item.name} className="flex items-center gap-2.5 text-[13px]">
            <AppIcon app={item.app} name={item.name} />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
          </li>
        ))}
        {connection.apps.length > shown.length && (
          <li className="pl-11 text-[12px] text-muted-foreground">
            and {connection.apps.length - shown.length} more
          </li>
        )}
      </ul>
      <div className="relative z-10 mt-auto pt-4">
        <Button size="sm" variant="outline" onClick={() => onConnect(connection)}>
          <HugeiconsIcon icon={ConnectIcon} strokeWidth={2} aria-hidden />
          Connect
        </Button>
      </div>
    </div>
  );
}

const choicesFor = (inventory: Inventory): ReadonlyMap<AppId, AppChoices> =>
  new Map(
    inventory.apps.map((app) => [app.id, appChoices(app, inventory.links, inventory.accounts)]),
  );

/** A stored connection as an editable draft, keeping removed apps and accounts visible. */
const draftFrom = (
  connection: ConnectionView,
  choices: ReadonlyMap<AppId, AppChoices>,
): ConnectionDraft => ({
  id: connection.id,
  name: connection.name,
  apps: connection.policy.apps.map((item): ConnectionApp => {
    const choice = choices.get(item.app);
    return {
      id: item.app,
      name: choice?.app.name ?? "Unavailable app",
      tools: item.tools,
      ...(item.events === undefined ? {} : { events: item.events }),
      targets: item.runsAs.map((target): ConnectionTarget => {
        if (target.kind === "app") return target;
        const option = choice?.options.find(
          (candidate) => candidate.target.kind === "account" && candidate.target.id === target.id,
        );
        return option?.target ?? { kind: "account", id: target.id, label: "Account unavailable" };
      }),
    };
  }),
});

/**
 * One connection's page: its name, how to connect an agent, and which apps it reaches, edited in
 * place. `new` creates one.
 */
export function ScopedConnectionPage<E, EL extends E, ES extends E, ER extends E>({
  connectionId,
  ...props
}: ConnectionPageBindings<E, EL, ES, ER> &
  ConnectionFormActions & {
    readonly connectionId: string;
  }) {
  // Chosen once, so a retried create returns the same connection.
  const [created] = useState(() => ConnectionId.make(randomUuid()));
  return (
    <PageFrame>
      <ConnectionReads
        query={props.query}
        connections={props.connections}
        Failure={props.Failure}
        pending={<LoadingRows count={5} />}
      >
        {(inventory, connections) => {
          const choices = choicesFor(inventory);
          if (connectionId === "new")
            return (
              <ConnectionForm
                {...props}
                key="new"
                choices={choices}
                accounts={inventory.accounts}
                stored={undefined}
                initial={{ id: created, name: "", apps: [] }}
              />
            );
          const stored = connections.find((item) => item.id === connectionId);
          if (stored === undefined)
            return (
              <>
                <BackLink ConnectionLink={props.ConnectionLink} />
                <h1 className="text-[22px] font-semibold tracking-[-0.035em]">
                  Connection unavailable
                </h1>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  It was revoked or no longer exists.
                </p>
              </>
            );
          return (
            <ConnectionForm
              {...props}
              key={`${stored.id}:${stored.name}:${JSON.stringify(stored.policy)}`}
              choices={choices}
              accounts={inventory.accounts}
              stored={stored}
              initial={draftFrom(stored, choices)}
            />
          );
        }}
      </ConnectionReads>
    </PageFrame>
  );
}

/** Where the host goes after a write, and how an app without an account gets one. */
interface ConnectionFormActions {
  readonly onCreated: (connection: ConnectionId) => void;
  readonly onRevoked: () => void;
  readonly renderTools: (props: ConnectionToolPickerProps) => ReactNode;
  readonly renderConnectAccount?: (app: App) => ReactNode;
}

function BackLink({
  ConnectionLink,
}: {
  readonly ConnectionLink: ComponentType<ConnectionLinkProps>;
}) {
  return (
    <Button variant="ghost" size="sm" className="mb-5 -ml-2 text-muted-foreground" asChild>
      <ConnectionLink>
        <HugeiconsIcon icon={ArrowLeft02Icon} size={15} />
        Connections
      </ConnectionLink>
    </Button>
  );
}

function ConnectionForm<E, EL extends E, ES extends E, ER extends E>({
  choices,
  accounts,
  stored,
  initial,
  save,
  revoke,
  Failure,
  ConnectionLink,
  renderInstallation,
  renderTools,
  renderConnectAccount,
  onCreated,
  onRevoked,
}: ConnectionPageBindings<E, EL, ES, ER> &
  ConnectionFormActions & {
    readonly choices: ReadonlyMap<AppId, AppChoices>;
    readonly accounts: Inventory["accounts"];
    /** Undefined while creating. */
    readonly stored: ConnectionView | undefined;
    readonly initial: ConnectionDraft;
  }) {
  const submit = useAtomSet(save, { mode: "promiseExit" });
  const saving = useAtomValue(save);
  const [draft, setDraft] = useState(initial);
  const [expanded, setExpanded] = useState<AppId>();
  const [connecting, setConnecting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [search, setSearch] = useState("");
  const [needsSetupOnly, setNeedsSetupOnly] = useState(false);
  const query = useDeferredValue(search.trim().toLowerCase());
  const nameId = useId();
  // Included apps stay on top in a fixed order so rows never jump while you toggle them.
  const [pinned] = useState(() => new Set(initial.apps.map((app) => app.id)));
  const ordered = useMemo(
    () =>
      [...choices.values()].toSorted(
        (a, b) =>
          Number(pinned.has(b.app.id)) - Number(pinned.has(a.app.id)) ||
          a.app.name.localeCompare(b.app.name),
      ),
    [choices, pinned],
  );
  const selections = new Map(draft.apps.map((app) => [app.id, app]));
  const unavailable = draft.apps.filter((app) => !choices.has(app.id));
  const attention = new Set(
    draft.apps.flatMap((selection) => {
      const choice = choices.get(selection.id);
      return choice !== undefined && selectionIssue(choice, selection) !== undefined
        ? [selection.id]
        : [];
    }),
  );
  const blocked = attention.size + unavailable.length;
  const visible = ordered.filter(
    (choice) =>
      (!needsSetupOnly || attention.has(choice.app.id)) &&
      (query === "" || choice.app.name.toLowerCase().includes(query)),
  );
  const included = visible.filter((choice) => pinned.has(choice.app.id));
  const others = visible.filter((choice) => !pinned.has(choice.app.id));
  const { count, sentinel } = useIncrementalList(others.length, `${query}:${needsSetupOnly}`);
  const addable = visible.filter((choice) => !selections.has(choice.app.id));
  const unassigned = draft.apps.filter(
    (app) => app.targets.length === 0 && (choices.get(app.id)?.options.length ?? 0) > 0,
  );
  const input = connectionInput(draft);
  const creating = stored === undefined;
  const dirty = creating || JSON.stringify(input) !== JSON.stringify(connectionInput(initial));
  const valid = input !== undefined && draft.apps.length > 0 && blocked === 0;
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
  const renderRow = (choice: AppChoices) => (
    <ConnectionAppRow
      key={choice.app.id}
      choices={choice}
      selection={selections.get(choice.app.id)}
      expanded={expanded === choice.app.id}
      onExpandedChange={(open) => setExpanded(open ? choice.app.id : undefined)}
      onChange={(next) => setSelection(choice.app.id, next)}
      {...(renderConnectAccount === undefined ? {} : { renderConnectAccount })}
      renderTools={renderTools}
    />
  );
  return (
    <>
      <form
        className="max-w-220"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || saving.waiting) return;
          const saved = await submit({ existing: !creating, input });
          if (Exit.isSuccess(saved) && creating) onCreated(saved.value.id);
        }}
      >
        <BackLink ConnectionLink={ConnectionLink} />
        <header className="flex items-start justify-between gap-4 max-[600px]:flex-col">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[22px] font-semibold tracking-[-0.035em]">
              {stored?.name ?? "New connection"}
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {creating
                ? "Turn on the apps this agent needs. It can't see anything else."
                : "Agents using this connection see only the apps turned on below. Changes apply right away."}
            </p>
          </div>
          {stored !== undefined && (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setConnecting(true)}>
                <HugeiconsIcon icon={ConnectIcon} strokeWidth={2} aria-hidden />
                Connect
              </Button>
              <DropdownMenu onOpenChange={(open) => !open && setCopy("idle")}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" aria-label="More actions">
                    <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={6}
                  collisionPadding={16}
                  className="w-52 p-1.5"
                >
                  <DropdownMenuItem
                    className="gap-2.5 py-2"
                    onSelect={(event) => {
                      event.preventDefault();
                      void copyText(stored.url).then(
                        () => setCopy("copied"),
                        () => setCopy("failed"),
                      );
                    }}
                  >
                    <HugeiconsIcon
                      icon={copy === "copied" ? Tick02Icon : Copy01Icon}
                      strokeWidth={2}
                    />
                    {copy === "copied"
                      ? "Copied"
                      : copy === "failed"
                        ? "Copy failed"
                        : "Copy MCP URL"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    className="gap-2.5 py-2"
                    onSelect={() => setRevoking(true)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    Revoke connection
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </header>

        <div className="mt-6 max-w-md space-y-2">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            maxLength={80}
            // Unnamed, it is named for its apps; the placeholder shows that name.
            placeholder={defaultConnectionName(draft.apps)}
            value={draft.name}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, name: event.target.value }))
            }
          />
        </div>

        {unavailable.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 px-4 py-3 text-[13px]">
            <span>
              {plural(unavailable.length, "app")} in this connection{" "}
              {unavailable.length === 1 ? "no longer exists" : "no longer exist"}:{" "}
              {unavailable.map((app) => app.name).join(", ")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((previous) => ({
                  ...previous,
                  apps: previous.apps.filter((app) => choices.has(app.id)),
                }))
              }
            >
              Remove
            </Button>
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-2">
          <SearchInput
            label="Search apps"
            placeholder={`Search ${plural(choices.size, "app")}…`}
            value={search}
            onChange={setSearch}
          />
          {query !== "" && addable.length > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft((previous) => ({
                  ...previous,
                  apps: [...previous.apps, ...addable.map(initialSelection)],
                }))
              }
            >
              Turn on {plural(addable.length, "match", "matches")}
            </Button>
          )}
          {unassigned.length > 0 && (
            <AssignAccount
              apps={unassigned}
              byId={choices}
              accounts={accounts}
              onAssign={(account) =>
                setDraft((previous) => ({
                  ...previous,
                  apps: previous.apps.map((app) => {
                    const choice = choices.get(app.id);
                    const option =
                      choice === undefined ? undefined : accountOption(choice, account);
                    return app.targets.length === 0 && option !== undefined
                      ? { ...app, targets: [option.target] }
                      : app;
                  }),
                }))
              }
            />
          )}
        </div>
        {needsSetupOnly && (
          <p className="mt-3 text-xs text-muted-foreground">
            Showing apps that need setup.{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => setNeedsSetupOnly(false)}
            >
              Show all
            </button>
          </p>
        )}

        {included.length > 0 && (
          <AppSection
            title="Can use"
            count={draft.apps.filter((app) => pinned.has(app.id)).length}
            hint={undefined}
          >
            {included.map(renderRow)}
          </AppSection>
        )}
        {others.length > 0 && (
          <AppSection
            title={pinned.size > 0 ? "Other apps" : "Apps"}
            count={undefined}
            hint={
              pinned.size > 0 && !others.some((choice) => selections.has(choice.app.id))
                ? "Turn one on to give this agent access."
                : undefined
            }
          >
            {others.slice(0, count).map(renderRow)}
          </AppSection>
        )}
        {sentinel}
        {visible.length === 0 && (
          <p className="mt-8 rounded-lg border px-4 py-10 text-center text-[13px] text-muted-foreground">
            {query !== "" ? "No apps match your search." : "Every app that's on is ready."}
          </p>
        )}

        <div
          className={cn(
            "sticky bottom-0 z-10 mt-6 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-4",
            !dirty && "invisible",
          )}
        >
          <p className="text-xs text-muted-foreground">
            {draft.apps.length === 0 ? (
              "No apps turned on"
            ) : blocked > 0 ? (
              <button
                type="button"
                className="text-amber-600 underline underline-offset-2 dark:text-amber-400"
                onClick={() => {
                  setSearch("");
                  setNeedsSetupOnly(true);
                }}
              >
                {plural(blocked, "app")} {blocked === 1 ? "needs" : "need"} setup before saving
              </button>
            ) : creating ? (
              `${plural(draft.apps.length, "app")} turned on`
            ) : (
              "Unsaved changes"
            )}
          </p>
          <div className="flex gap-2">
            {creating ? (
              <Button type="button" variant="outline" asChild>
                <ConnectionLink>Cancel</ConnectionLink>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={saving.waiting}
                onClick={() => setDraft(initial)}
              >
                Discard
              </Button>
            )}
            <Button type="submit" disabled={!valid || saving.waiting} loading={saving.waiting}>
              {creating ? "Create connection" : "Save changes"}
            </Button>
          </div>
          {AsyncResult.isFailure(saving) && (
            <div className="w-full">
              <Failure cause={saving.cause} />
            </div>
          )}
        </div>
      </form>
      {stored !== undefined && (
        <>
          <ConnectDialog
            target={
              connecting
                ? {
                    name: stored.name,
                    url: stored.url,
                    apps: initial.apps.map((app) => app.name),
                  }
                : undefined
            }
            renderInstallation={renderInstallation}
            onClose={() => setConnecting(false)}
          />
          <RevokeDialog
            connection={revoking ? stored : undefined}
            revoke={revoke}
            Failure={Failure}
            onClose={() => setRevoking(false)}
            onRevoked={onRevoked}
          />
        </>
      )}
    </>
  );
}

function AppSection({
  title,
  count,
  hint,
  children,
}: {
  readonly title: string;
  readonly count: number | undefined;
  readonly hint: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-8">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {count !== undefined && (
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="divide-y overflow-hidden rounded-lg border">{children}</div>
    </section>
  );
}

function RevokeDialog<E, ER extends E>({
  connection,
  revoke,
  Failure,
  onClose,
  onRevoked,
}: {
  readonly connection: ConnectionView | undefined;
  readonly revoke: ScopedConnectionBindings<never, never, ER>["revoke"];
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onClose: () => void;
  readonly onRevoked: () => void;
}) {
  const submit = useAtomSet(revoke, { mode: "promiseExit" });
  const state = useAtomValue(revoke);
  return (
    <Dialog
      open={connection !== undefined}
      onOpenChange={(open) => !open && !state.waiting && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {connection?.name}?</DialogTitle>
          <DialogDescription>
            Agents using this connection lose access immediately. Its URL stops working.
          </DialogDescription>
        </DialogHeader>
        {AsyncResult.isFailure(state) && <Failure cause={state.cause} />}
        <DialogFooter>
          <Button variant="outline" disabled={state.waiting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={state.waiting}
            disabled={state.waiting}
            onClick={async () => {
              if (connection === undefined) return;
              const result = await submit(connection.id);
              if (Exit.isSuccess(result)) onRevoked();
            }}
          >
            Revoke connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
          Run every included app that isn’t set up yet as this account.
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
