import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { Exit, Option, type Cause } from "effect";
import { AsyncResult, type Atom } from "effect/reactivity";
import { Cancel01Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Account, AccountRequirement, App } from "@executor-js/sdk";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import { executorCatalogPackage } from "@executor-js/hosted-server/catalog";
import { Button } from "@executor-js/ui/components/button";
import { DialogDescription, DialogTitle } from "@executor-js/ui/components/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@executor-js/ui/components/popover";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { Spinner } from "@executor-js/ui/components/spinner";
import { ProviderIcon } from "@executor-js/ui/dashboard/common";
import { installedCatalogApps, useCatalogInstall } from "@executor-js/ui/dashboard/catalog";
import { useIncrementalList } from "@executor-js/ui/dashboard/incremental-list";
import { parseAccountsSetupSearch, setupHandoff } from "../../contracts/navigation.ts";
import { inventoryAtom } from "../../contracts/organization.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import {
  SetupActions,
  SetupCard,
  SetupLede,
  SetupNext,
  SetupPage,
  SetupTitle,
} from "../components/setup-page.tsx";
import { SetupLink, useSetupSequence, useSetupViewed } from "../components/setup-sequence.tsx";
import { AppConnectionDialogContent, methodsOf } from "./app-accounts.tsx";
import { ConnectionModal } from "./connection-dialog.tsx";
import { OAuthReturnContext } from "./connect-account.tsx";
import {
  HostedAccountActions,
  HostedAccountDialog,
  type AccountDialogKind,
} from "./account-actions.tsx";
import { useProductBrand } from "@executor-js/ui/hooks/product-brand";

/**
 * The apps offered first, by catalog ID, when the catalog lists them. Google signs in to every
 * Google service at once; each service is also offered alone, with narrower access.
 */
const featured: readonly { readonly id: string; readonly detail?: string }[] = [
  { id: "google", detail: "Gmail, Calendar, Drive, Docs and Sheets in one sign-in" },
  { id: "gmail" },
  { id: "google-calendar" },
  { id: "google-drive" },
  { id: "github" },
  { id: "slack" },
  { id: "linear" },
  { id: "notion" },
  { id: "vercel" },
  { id: "stripe" },
];

/** Rows load in pages as the list scrolls. */
const pageSize = 12;

type Inventory = Atom.Success<ReturnType<typeof inventoryAtom>>;

/** One catalog app as this step lists it: its installed copy, if any, and the accounts it can use. */
interface SetupApp {
  readonly entry: CatalogEntry;
  readonly detail: string;
  readonly app: App | undefined;
  /** The accounts linked to the installed app first, then other saved accounts of its providers. */
  readonly accounts: readonly Account[];
}

/**
 * Catalog apps that take an account, with the accounts the organization's inventory has for them.
 * Executor's own app is already the team's, and the assistant reaches it through MCP.
 */
function setupApps(entries: readonly CatalogEntry[], inventory: Inventory): readonly SetupApp[] {
  const installed = installedCatalogApps(inventory.apps);
  const details = new Map(featured.map((item) => [item.id, item.detail]));
  return entries
    .filter((entry) => entry.auth.length > 0 && entry.package !== executorCatalogPackage)
    .map((entry) => {
      const app = installed.get(entry.package);
      const detail = details.get(entry.id) ?? entry.description;
      if (app === undefined) return { entry, detail, app, accounts: [] };
      const linked = inventory.links.flatMap((link) =>
        link.app === app.id ? inventory.accounts.filter((item) => item.id === link.account) : [],
      );
      const providers = new Set(
        Object.values(app.requirements.accounts).map((requirement) => requirement.provider),
      );
      const others = inventory.accounts
        .filter(
          (item) => providers.has(item.provider) && !linked.some((link) => link.id === item.id),
        )
        .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return { entry, detail, app, accounts: [...linked, ...others] };
    });
}

/** Names that start with the search come first, then other name matches, then descriptions. */
const searchRank = (item: SetupApp, term: string) => {
  const name = item.entry.name.toLowerCase();
  if (name.startsWith(term)) return 0;
  if (name.includes(term)) return 1;
  return item.detail.toLowerCase().includes(term) ? 2 : undefined;
};

/**
 * Onboarding's account step: the catalog in one list, searchable in place, where each app
 * installs on its first connection and then runs the app's own connection flow. Every row keeps
 * one height and one button width, so connecting never moves the list.
 */
export function AccountsSetupPage() {
  const brand = useProductBrand();
  const { organization } = useOrganizationRoute();
  // When the assistant connected first, its handoff rides in the URL to the first prompt.
  const handoff = setupHandoff(parseAccountsSetupSearch(useLocation().search));
  const sequence = useSetupSequence();
  useSetupViewed("setup_accounts");
  const atoms = useDashboardAtoms();
  useAtomMount(atoms.catalog);
  const catalog = useAtomValue(atoms.catalog);
  const retryCatalog = useAtomRefresh(atoms.catalog);
  const inventory = useAtomValue(inventoryAtom(organization));
  const retryInventory = useAtomRefresh(inventoryAtom(organization));
  const entries = Option.getOrUndefined(AsyncResult.value(catalog));
  const known = Option.getOrUndefined(AsyncResult.value(inventory));
  const apps = entries && known ? setupApps(entries, known) : undefined;
  const connected = new Set(apps?.flatMap((item) => item.accounts.map((account) => account.id)));
  const done = connected.size > 0;
  // Until one connects, the label it changes to is reserved at one account.
  const count = Math.max(connected.size, 1);
  return (
    <OAuthReturnContext value={{ page: "setup", ...(handoff === undefined ? {} : { handoff }) }}>
      <SetupPage className="h-dvh">
        {/*
          Wider screens give the list one height, shrunk only to fit the screen, so the actions
          keep their place whether the list is loading, short or long. Phones fill the screen.
        */}
        <section
          aria-labelledby="accounts-setup-title"
          className="flex min-h-0 flex-col max-sm:flex-1"
        >
          <SetupTitle id="accounts-setup-title">Connect your accounts</SetupTitle>
          <SetupLede>
            Your assistant uses these through {brand.name}. Connect the tools you work in now
            <span className="max-sm:hidden"> — you can add more any time</span>.
          </SetupLede>
          <SetupCard className="flex min-h-60 flex-1 flex-col sm:h-[620px] sm:flex-initial">
            {entries === undefined && AsyncResult.isFailure(catalog) ? (
              <ListMessage>
                <HostedFailure cause={catalog.cause} retry={retryCatalog} layout="compact" />
              </ListMessage>
            ) : known === undefined && AsyncResult.isFailure(inventory) ? (
              <ListMessage>
                <HostedFailure cause={inventory.cause} retry={retryInventory} layout="compact" />
              </ListMessage>
            ) : apps === undefined || known === undefined ? (
              <LoadingList />
            ) : apps.length === 0 ? (
              <NotListed query="" />
            ) : (
              <AppList apps={apps} redirectUri={known.accountSetup.redirectUri} />
            )}
          </SetupCard>
        </section>
        <SetupActions>
          <SetupNext done={done} label={`Continue with ${count} account${count === 1 ? "" : "s"}`}>
            {(content) => (
              <SetupLink
                to={sequence.after("accounts", handoff)}
                onClick={() =>
                  sequence.report(done ? "continue_accounts" : "skip_accounts", "started")
                }
              >
                {content}
              </SetupLink>
            )}
          </SetupNext>
        </SetupActions>
      </SetupPage>
    </OAuthReturnContext>
  );
}

function ListMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="px-4 py-7 text-center text-[13px] leading-6 text-muted-foreground max-sm:px-6">
      {children}
    </div>
  );
}

/** The search and rows the catalog will fill, at their loaded size, as many as the list shows. */
function LoadingList() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading apps"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <SearchField value="" placeholder="Search apps" disabled onChange={() => {}} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {Array.from({ length: pageSize }, (_, index) => (
          <div
            key={index}
            className="flex h-[70px] items-center gap-3.5 border-t px-4 first:border-t-0 max-sm:px-6"
          >
            <Skeleton className="size-8.5 rounded-[7px]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
            <Skeleton className="h-8 w-[120px] max-sm:w-[92px]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The list's last row, after every app it can show: any other app or API is one the assistant can
 * add once connected. With a search, it names what was searched for; with no match it is the
 * whole list.
 */
function NotListed({ query }: { readonly query: string }) {
  const brand = useProductBrand();
  return (
    <div
      role="note"
      aria-label="Not listed"
      className="border-t px-4 py-4 text-[13px] leading-5 text-muted-foreground first:border-t-0 max-sm:px-6"
    >
      <p className="font-medium text-foreground/70">
        {query === "" ? "Not seeing what you’re looking for?" : `Not seeing “${query}”?`}
      </p>
      <p className="mt-0.5">
        Once your assistant is connected, ask it to add{" "}
        {query === "" ? "any app or API" : `“${query}”`} through {brand.name}.
      </p>
    </div>
  );
}

function SearchField({
  value,
  placeholder,
  disabled = false,
  focus = false,
  onChange,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  /**
   * Focus the search when it is shown, where typing is the quickest way to an app: with a fine
   * pointer on a wider screen. On touch screens and phones the keyboard would cover the list.
   */
  readonly focus?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focus || input.current === null) return;
    if (!window.matchMedia("(pointer: fine) and (min-width: 640px)").matches) return;
    // Only when nothing else has focus, such as a control the member already reached.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    input.current.focus({ preventScroll: true });
  }, [focus]);
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4 text-muted-foreground max-sm:px-6">
      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} size={16} aria-hidden />
      <input
        ref={input}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label="Search apps"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground max-sm:text-base [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="flex size-5.5 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** A connection the step is running: the install first, then the app's connection form. */
type Connection =
  | { readonly status: "installing"; readonly entry: string }
  | {
      readonly status: "connecting";
      readonly entry: string;
      readonly app: App;
      readonly slot: string;
      readonly requirement: AccountRequirement;
      readonly method: string;
    }
  | {
      readonly status: "failed";
      readonly entry: string;
      readonly name: string;
      /** Unset when the installed app declares no account to connect. */
      readonly cause: Cause.Cause<HostedError> | undefined;
    };

function AppList({
  apps,
  redirectUri,
}: {
  readonly apps: readonly SetupApp[];
  readonly redirectUri: string;
}) {
  const atoms = useDashboardAtoms();
  const install = useCatalogInstall(atoms.install);
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const [connection, setConnection] = useState<Connection>();
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<{
    readonly id: Account["id"];
    readonly kind: AccountDialogKind;
  }>();
  // Apps connected from the full list or a search join the top list only when the list is shown
  // again, so a row never moves away from the button that was just clicked.
  const connectedIds = new Set(
    apps.flatMap((item) => (item.accounts.length > 0 ? [item.entry.id] : [])),
  );
  const view = term === "" ? "list" : "search";
  const [joined, setJoined] = useState({ view, ids: connectedIds });
  if (joined.view !== view) setJoined({ view, ids: connectedIds });
  const scroller = useRef<HTMLDivElement>(null);

  const isFeatured = (item: SetupApp) => featured.some(({ id }) => id === item.entry.id);
  const top = [
    ...featured.flatMap(({ id }) => apps.filter((item) => item.entry.id === id)),
    ...apps.filter((item) => joined.ids.has(item.entry.id) && !isFeatured(item)),
  ];
  const rest = apps.filter((item) => !top.includes(item));
  const matches =
    term === ""
      ? rest
      : apps
          .flatMap((item) => {
            const rank = searchRank(item, term);
            return rank === undefined ? [] : [{ item, rank }];
          })
          .toSorted((a, b) => a.rank - b.rank)
          .map(({ item }) => item);
  const visible = useIncrementalList(matches.length, term, pageSize, scroller);
  // The note follows the last app, once every one the list can show is rendered.
  const end = visible.count >= matches.length;

  const open = (item: SetupApp, app: App) => {
    const [slot, requirement] = Object.entries(app.requirements.accounts)[0] ?? [];
    const [method] = requirement === undefined ? [] : (methodsOf(requirement)[0] ?? []);
    setConnection(
      slot !== undefined && requirement !== undefined && method !== undefined
        ? { status: "connecting", entry: item.entry.id, app, slot, requirement, method }
        : { status: "failed", entry: item.entry.id, name: item.entry.name, cause: undefined },
    );
  };
  const connect = async (item: SetupApp) => {
    if (connection !== undefined) return;
    if (item.app !== undefined) return open(item, item.app);
    setConnection({ status: "installing", entry: item.entry.id });
    const exit = await install(item.entry, { entry: item.entry.id, name: item.entry.name });
    if (Exit.isSuccess(exit)) open(item, exit.value);
    else
      setConnection({
        status: "failed",
        entry: item.entry.id,
        name: item.entry.name,
        cause: exit.cause,
      });
  };
  const row = (item: SetupApp) => (
    <AppRow
      key={item.entry.id}
      item={item}
      busy={connection?.entry === item.entry.id}
      onConnect={() => void connect(item)}
      onAccountAction={(id, kind) => setDialog({ id, kind })}
    />
  );
  return (
    <>
      <SearchField
        value={search}
        focus
        placeholder={`Search ${apps.length.toLocaleString("en-US")} apps`}
        onChange={(value) => {
          setSearch(value);
          scroller.current?.scrollTo({ top: 0 });
        }}
      />
      <div
        ref={scroller}
        role="region"
        aria-label="Apps"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {term === "" ? (
          <>
            {top.map(row)}
            {rest.length > 0 && <SectionHeader>All apps</SectionHeader>}
            {rest.slice(0, visible.count).map(row)}
          </>
        ) : matches.length > 0 ? (
          <>
            <SectionHeader>
              {matches.length} app{matches.length === 1 ? "" : "s"} match “{search.trim()}”
            </SectionHeader>
            {matches.slice(0, visible.count).map(row)}
          </>
        ) : null}
        {visible.sentinel}
        {end && <NotListed query={search.trim()} />}
      </div>
      <ConnectionModal
        open={connection !== undefined && connection.status !== "installing"}
        busy={pending}
        onClose={() => setConnection(undefined)}
      >
        {connection?.status === "connecting" ? (
          <AppConnectionDialogContent
            app={connection.app}
            scope={connection.requirement.scope}
            slot={connection.slot}
            requirement={connection.requirement}
            method={connection.method}
            redirectUri={redirectUri}
            onPendingChange={setPending}
            onSaved={() => setConnection(undefined)}
          />
        ) : connection?.status === "failed" ? (
          <>
            <DialogTitle className="text-base">Couldn’t connect {connection.name}</DialogTitle>
            {connection.cause === undefined ? (
              <DialogDescription>This app has no account to connect.</DialogDescription>
            ) : (
              <>
                <DialogDescription className="sr-only">
                  {connection.name} could not be added to your team.
                </DialogDescription>
                <HostedFailure cause={connection.cause} layout="compact" />
              </>
            )}
          </>
        ) : null}
      </ConnectionModal>
      {dialog && (
        <HostedAccountDialog
          id={dialog.id}
          dialog={dialog.kind}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
  );
}

function SectionHeader({ children }: { readonly children: ReactNode }) {
  return (
    <div className="sticky top-0 z-1 border-b bg-muted px-4 py-2 text-xs text-muted-foreground max-sm:px-6 [&+[role=group]]:border-t-0">
      {children}
    </div>
  );
}

const Check = () => (
  <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
    <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} size={9} aria-hidden />
  </span>
);

/**
 * One app in one fixed-height row: its logo, its name over one line of detail, and one button of a
 * fixed width. Connecting changes only the detail line and the button; more accounts open over the
 * list instead of growing the row.
 */
function AppRow({
  item,
  busy,
  onConnect,
  onAccountAction,
}: {
  readonly item: SetupApp;
  readonly busy: boolean;
  readonly onConnect: () => void;
  readonly onAccountAction: (account: Account["id"], kind: AccountDialogKind) => void;
}) {
  const { entry, accounts } = item;
  const [first] = accounts;
  const oauth = entry.auth.some((auth) => auth.kind === "oauth2");
  return (
    <div
      role="group"
      aria-label={entry.name}
      className="flex h-[70px] shrink-0 items-center gap-3.5 border-t px-4 first:border-t-0 max-sm:gap-3 max-sm:px-6"
    >
      <ProviderIcon name={entry.name} icons={entry.icons} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{entry.name}</span>
          {!oauth && first === undefined && (
            <span className="shrink-0 rounded-full border px-1.75 text-[11px] leading-[18px] font-normal text-muted-foreground max-sm:hidden">
              API token
            </span>
          )}
        </div>
        {first === undefined ? (
          <p className="truncate text-[13px] text-muted-foreground">{item.detail}</p>
        ) : (
          <div className="flex h-5 min-w-0 items-center gap-1.75 text-[13px]">
            <Check />
            <span className="truncate">{first.label || "Unnamed account"}</span>
            {accounts.length > 1 && (
              <AccountsPopover
                name={entry.name}
                accounts={accounts}
                busy={busy}
                onAdd={onConnect}
                onAccountAction={onAccountAction}
              />
            )}
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={onConnect}
        className="min-w-[120px] disabled:text-muted-foreground disabled:opacity-100 max-sm:min-w-[92px] max-sm:px-2.5"
      >
        {busy ? (
          <>
            <Spinner className="size-3" aria-hidden role={undefined} />
            {first === undefined ? "Connecting" : "Adding"}
          </>
        ) : first !== undefined ? (
          <span>
            Add<span className="max-sm:hidden"> another</span> +
          </span>
        ) : (
          "Connect"
        )}
      </Button>
    </div>
  );
}

/** Every account of one app, with the existing account actions, over the list. */
function AccountsPopover({
  name,
  accounts,
  busy,
  onAdd,
  onAccountAction,
}: {
  readonly name: string;
  readonly accounts: readonly Account[];
  readonly busy: boolean;
  readonly onAdd: () => void;
  readonly onAccountAction: (account: Account["id"], kind: AccountDialogKind) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Show all ${accounts.length} ${name} accounts`}
          className="shrink-0 rounded-full border bg-background px-1.75 text-[11.5px] leading-4 text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
        >
          +{accounts.length - 1}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-75 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11.5px] text-muted-foreground">
          {accounts.length} {name} accounts
        </p>
        <ul aria-label={`${name} accounts`}>
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center gap-2 rounded-md py-0.5 pr-0.5 pl-2 text-[13px] hover:bg-muted/60"
            >
              <Check />
              <span className="min-w-0 flex-1 truncate">{account.label || "Unnamed account"}</span>
              <HostedAccountActions
                account={account}
                access={undefined}
                open={(kind) => {
                  setOpen(false);
                  onAccountAction(account.id, kind);
                }}
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            onAdd();
          }}
          className="mt-1 block w-full border-t px-2 pt-2 pb-1 text-left text-[13px] text-foreground/80 hover:text-foreground disabled:opacity-50"
        >
          Add another {name} account +
        </button>
      </PopoverContent>
    </Popover>
  );
}
