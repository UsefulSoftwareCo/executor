import { useQuery } from "./context.tsx";
import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ComponentType,
} from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/reactivity";
import { Exit, Option, type Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { RadioGroup } from "radix-ui";
import type {
  Account,
  AccountAppHealth,
  AccountScope,
  App,
  AccountId,
  AccountRequirement,
} from "@executor-js/sdk";
import type { RequirementChoice, RequirementLink } from "../../contracts/app-accounts.ts";
import {
  providerDisplayUrl,
  accountNeedsSignIn,
  type AccountDetail,
  type AccountSummary,
  type FailureProps,
  type Query,
} from "../../contracts/dashboard.ts";
import { AppProviderIcon, ProviderIcon } from "./common.tsx";
import { AccountAvatar, AccountCheckResult } from "./account-health.tsx";
import { EmptyState } from "./empty-state.tsx";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
import { Spinner } from "../components/spinner.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/dialog.tsx";
import { cn } from "../lib/utils.ts";

const accountName = (account: AccountSummary) => account.label || "Unnamed account";

/**
 * An account's actions in this app: the host's items, then unlinking when the host offers it.
 * Unlinking stops using the account for the requirement; the saved account and its other links
 * stay.
 */
export function LinkedAccountMenu<A, E>({
  label,
  unlink,
  bound,
  Failure,
  onUnlinked,
  children,
}: {
  readonly label: string;
  /** Set for an account this app signed in itself: unlinking deletes it, so it asks first. */
  readonly bound?: { readonly app: string } | undefined;
  readonly unlink?: Atom.AtomResultFn<void, A, E> | undefined;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onUnlinked?: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const [error, setError] = useState<Cause.Cause<E>>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (children === undefined && unlink === undefined) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Manage ${label}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            loading={pending}
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} size={14} strokeWidth={2} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {children}
          {children && unlink && <DropdownMenuSeparator />}
          {unlink && bound && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
              Remove account…
            </DropdownMenuItem>
          )}
          {unlink && !bound && (
            <UnlinkItem
              unlink={unlink}
              label="Unlink"
              onStart={() => {
                setError(undefined);
                setPending(true);
              }}
              onDone={(exit) => {
                setPending(false);
                if (Exit.isFailure(exit)) setError(exit.cause);
                else onUnlinked?.();
              }}
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming && unlink && bound && (
        <BoundUnlink
          unlink={unlink}
          name={label}
          app={bound.app}
          onClose={() => setConfirming(false)}
          onDone={(exit) => {
            if (Exit.isFailure(exit)) setError(exit.cause);
            else onUnlinked?.();
          }}
        />
      )}
      {error && (
        <div className="basis-full text-xs">
          <Failure cause={error} />
        </div>
      )}
    </>
  );
}

function UnlinkItem<A, E>({
  unlink,
  label,
  onStart,
  onDone,
}: {
  readonly unlink: Atom.AtomResultFn<void, A, E>;
  readonly label: string;
  readonly onStart: () => void;
  readonly onDone: (exit: Exit.Exit<A, E>) => void;
}) {
  const run = useAtomSet(unlink, { mode: "promiseExit" });
  const result = useAtomValue(unlink);
  return (
    <DropdownMenuItem
      variant="destructive"
      disabled={AsyncResult.isWaiting(result)}
      onSelect={() => {
        onStart();
        void run().then(onDone);
      }}
    >
      {label}
    </DropdownMenuItem>
  );
}

/**
 * Accounts are saved separately from the apps that use them, so unlinking one from an app keeps
 * it. After an unlink leaves no app using an account, offer to delete it.
 */
export function useUnusedAccountPrompt<E, A>({
  usage,
  remove,
  Failure,
}: {
  readonly usage: Atom.AtomResultFn<AccountId, AccountDetail, unknown>;
  readonly remove: (account: AccountId) => Atom.AtomResultFn<void, A, E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const read = useAtomSet(usage, { mode: "promiseExit" });
  const [unused, setUnused] = useState<AccountDetail>();
  const check = async (account: AccountId) => {
    const exit = await read(account);
    // The removal already succeeded; a failed read only skips this optional prompt.
    if (Exit.isSuccess(exit) && exit.value.canManage && exit.value.apps.length === 0)
      setUnused(exit.value);
  };
  return {
    check,
    prompt: unused && (
      <DeleteUnusedAccount
        key={unused.account.id}
        data={unused}
        remove={remove(unused.account.id)}
        Failure={Failure}
        onClose={() => setUnused(undefined)}
      />
    ),
  };
}

function DeleteUnusedAccount<E, A>({
  data,
  remove,
  Failure,
  onClose,
}: {
  readonly data: AccountDetail;
  readonly remove: Atom.AtomResultFn<void, A, E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onClose: () => void;
}) {
  const run = useAtomSet(remove, { mode: "promiseExit" });
  const result = useAtomValue(remove);
  const pending = AsyncResult.isWaiting(result);
  const provider = data.provider.definition.name;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogTitle>Delete unused account?</DialogTitle>
        <div className="flex min-w-0 items-center gap-2.5 text-sm font-medium">
          <ProviderIcon name={provider} url={providerDisplayUrl(data.provider.definition)} />
          <span className="min-w-0 break-words">
            {data.account.label || "Unnamed account"} · {provider}
          </span>
        </div>
        <DialogDescription>
          Accounts are saved separately from apps, so any app can reuse them. Unlinking an account
          from an app keeps it saved. No app uses this account now.
        </DialogDescription>
        <p className="text-sm text-muted-foreground">
          Delete it if you no longer need it.{" "}
          {data.revocation === "automatic"
            ? `This removes the saved credentials from Executor and asks ${provider} to revoke its access.`
            : `This removes the saved credentials from Executor but does not revoke access at ${provider}. To end access, revoke it there too.`}
        </p>
        {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Keep account
          </Button>
          <Button
            variant="destructive"
            loading={pending}
            onClick={async () => {
              if (Exit.isSuccess(await run())) onClose();
            }}
          >
            Delete account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How long a check result stays fresh before viewing the app's accounts checks again. */
const checkFreshFor = 5 * 60 * 1000;

/**
 * Stale while revalidate: rows show the recorded checks at once, and each account this app checks
 * is checked again in the background when its result is missing, outdated or older than
 * `checkFreshFor`. Each recorded result is rechecked once, so a redeploy or new credentials while
 * the page stays open check again, and a recheck that changes nothing does not repeat. A recheck
 * that cannot run leaves the result as it was, so its rows offer to try again.
 */
function useRevalidateChecks(
  app: App,
  scope: AccountScope,
  accounts: readonly AccountSummary[],
  revalidate: Revalidate | undefined,
): Rechecks {
  const started = useRef(new Set<string>());
  const [running, setRunning] = useState<ReadonlyMap<AccountId, number>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<AccountId>>(new Set());
  const retry = useCallback(
    (id: AccountId) => {
      if (revalidate === undefined) return;
      const count = (by: number) =>
        setRunning((runs) => {
          const next = new Map(runs);
          const total = (next.get(id) ?? 0) + by;
          if (total > 0) next.set(id, total);
          else next.delete(id);
          return next;
        });
      const fail = (failure: boolean) =>
        setFailed((ids) => {
          const next = new Set(ids);
          if (failure) next.add(id);
          else next.delete(id);
          return next;
        });
      count(1);
      fail(false);
      void revalidate(id)
        .then(
          (exit) => fail(Exit.isFailure(exit)),
          () => fail(true),
        )
        .finally(() => count(-1));
    },
    [revalidate],
  );
  useEffect(() => {
    if (revalidate === undefined) return;
    const now = Date.now();
    for (const requirement of Object.values(app.requirements.accounts)) {
      if (requirement.health !== true || requirement.scope !== scope) continue;
      for (const account of accounts) {
        if (
          account.provider !== requirement.provider ||
          account.health === undefined ||
          accountNeedsSignIn(account) ||
          account.signIn?.state === "unavailable"
        )
          continue;
        const entry = account.health.apps.find((item) => item.app === app.id);
        if (entry !== undefined && !entry.checkable) continue;
        const checkedAt =
          entry === undefined ? account.health.infoCheckedAt : (entry.check?.checkedAt ?? null);
        const current = entry?.check?.current !== false;
        if (checkedAt !== null && current && now - checkedAt.getTime() < checkFreshFor) continue;
        const result = `${account.id}:${checkedAt?.getTime() ?? "none"}:${current}`;
        if (started.current.has(result)) continue;
        started.current.add(result);
        retry(account.id);
      }
    }
  }, [app, scope, accounts, revalidate, retry]);
  return { running, failed, retry };
}

/** Check an account again; resolves with the check's outcome. */
type Revalidate = (account: AccountId) => Promise<Exit.Exit<unknown, unknown>>;
/** The accounts whose check of this app is running again, or could not run. */
interface Rechecks {
  readonly running: ReadonlyMap<AccountId, number>;
  readonly failed: ReadonlySet<AccountId>;
  readonly retry: (account: AccountId) => void;
}
const Checking = createContext<Rechecks>({
  running: new Map(),
  failed: new Set(),
  retry: () => {},
});

type RequirementEntry = readonly [string, AccountRequirement];

const scoped = (app: App, scope: AccountScope): readonly RequirementEntry[] =>
  Object.entries(app.requirements.accounts).filter(
    ([, requirement]) => requirement.scope === scope,
  );

/** Changing the links of one scope. The host still authorizes every link and connection. */
export interface LinkEditing<E> {
  /** One requirement's linked accounts, then the other accounts the caller could link. */
  readonly choices: (
    slot: string,
  ) => Query<{ readonly accounts: readonly RequirementChoice<Account>[] }, E>;
  readonly link: (slot: string, account: AccountId) => Atom.AtomResultFn<void, unknown, E>;
  readonly unlink: (slot: string, account: AccountId) => Atom.AtomResultFn<void, unknown, E>;
  /** Connect a new account for the requirement; saving it links it. */
  readonly connect: (slot: string, requirement: AccountRequirement) => void;
  /** A connection is open or saving, so the other changes wait for it. */
  readonly connecting?: boolean | undefined;
  readonly onUnlinked?: ((account: AccountId) => void) | undefined;
}

/** The links of one scope and what the caller can do with them. */
export interface ScopeAccounts<E> {
  /** The scope's links with their sign-in and check details, oldest first per requirement. */
  readonly links: readonly RequirementLink<AccountSummary>[];
  /** Absent when the caller cannot change these links. */
  readonly edit?: LinkEditing<E> | undefined;
  /** Why the caller cannot change these links, shown with the greyed-out list. */
  readonly readOnly?: string | undefined;
  /** Each account's menu, such as editing or reconnecting it. */
  readonly accountMenu?:
    | ((
        account: AccountSummary,
        slot: string,
        requirement: AccountRequirement,
        linked: boolean,
      ) => ReactNode)
    | undefined;
  readonly reconnectAction?:
    | ((account: AccountSummary, slot: string, requirement: AccountRequirement) => ReactNode)
    | undefined;
  /** Check one linked account again; its result reaches `links` through the host's queries. */
  readonly revalidate?: Revalidate | undefined;
}

/**
 * The app's account requirements in two sections with the same layout: "App accounts", linked for
 * everyone who uses the app and its background work, and "Your accounts", linked for the caller.
 * Each requirement lists every account the caller could use: a radio for a plain requirement,
 * checkboxes for a many() requirement, and "Connect new account" last. Selecting an account links
 * it, which replaces a plain requirement's account; clearing a checkbox unlinks it.
 */
export function AppAccounts<E>({
  app,
  appAccounts,
  yourAccounts,
  accounts,
  Failure,
}: {
  readonly app: App;
  readonly appAccounts: ScopeAccounts<E>;
  readonly yourAccounts: ScopeAccounts<E>;
  /** The caller's usable accounts, whose sign-in and check details the choices reuse. */
  readonly accounts: readonly AccountSummary[];
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const appRequirements = scoped(app, "app");
  const userRequirements = scoped(app, "user");
  if (appRequirements.length === 0 && userRequirements.length === 0)
    return (
      <EmptyState size="compact" title="No accounts required">
        This app can run without a saved account.
      </EmptyState>
    );
  return (
    <div className="accounts-section space-y-8">
      {appRequirements.length > 0 && (
        <LinkScope
          app={app}
          scope="app"
          title="App accounts"
          description="Linked for everyone"
          requirements={appRequirements}
          data={appAccounts}
          accounts={accounts}
          Failure={Failure}
        />
      )}
      {userRequirements.length > 0 && (
        <LinkScope
          app={app}
          scope="user"
          title="Your accounts"
          description="Linked for you"
          requirements={userRequirements}
          data={yourAccounts}
          accounts={accounts}
          Failure={Failure}
        />
      )}
    </div>
  );
}

interface ScopeProps<E> {
  readonly app: App;
  readonly scope: AccountScope;
  readonly data: ScopeAccounts<E>;
  readonly accounts: readonly AccountSummary[];
  readonly Failure: ComponentType<FailureProps<E>>;
}

function LinkScope<E>({
  title,
  description,
  requirements,
  ...props
}: ScopeProps<E> & {
  readonly title: string;
  readonly description: string;
  readonly requirements: readonly RequirementEntry[];
}) {
  const { app, scope, data } = props;
  const checking = useRevalidateChecks(
    app,
    scope,
    data.links.map((link) => link.account),
    data.revalidate,
  );
  const all = Object.values(app.requirements.accounts);
  const readOnly = data.edit === undefined;
  return (
    <Checking.Provider value={checking}>
      <section aria-label={title} data-read-only={readOnly} className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {readOnly && data.readOnly !== undefined && (
          <p className="text-xs text-muted-foreground">{data.readOnly}</p>
        )}
        <div className={cn("space-y-5", readOnly && "opacity-60")}>
          {requirements.map(([slot, requirement]) => (
            <RequirementView
              key={slot}
              {...props}
              slot={slot}
              requirement={requirement}
              linked={data.links.flatMap((link) =>
                link.requirement === slot ? [link.account] : [],
              )}
              label={
                all.length > 1
                  ? `${requirement.definition.name} (${slot})`
                  : requirement.definition.name
              }
              showSlot={
                all.filter((other) => other.definition.name === requirement.definition.name)
                  .length > 1
              }
            />
          ))}
        </div>
      </section>
    </Checking.Provider>
  );
}

/** Short guidance under a requirement; the rows say the rest. */
const requirementNote = (requirement: AccountRequirement, linked: number) =>
  requirement.cardinality === "many"
    ? requirement.scope === "app"
      ? "The app uses every linked account, for everyone."
      : "The app uses every account you link."
    : linked === 0
      ? requirement.scope === "app"
        ? "Link an account so the app can run."
        : "Link an account to use this app."
      : requirement.scope === "app"
        ? "The app uses this account for everyone."
        : "The app uses this account when you use it.";

function RequirementView<E>({
  slot,
  requirement,
  linked,
  label,
  showSlot,
  ...props
}: ScopeProps<E> & {
  readonly slot: string;
  readonly requirement: AccountRequirement;
  /** The requirement's linked accounts, oldest first. */
  readonly linked: readonly AccountSummary[];
  readonly label: string;
  readonly showSlot: boolean;
}) {
  const { data } = props;
  return (
    <section aria-label={label} className="min-w-0 space-y-2.5">
      <div className="flex min-h-8 min-w-0 items-center gap-3 text-sm [&_.provider-icon]:size-14 [&_.provider-icon]:rounded-xl">
        <AppProviderIcon app={props.app} provider={requirement.definition} large />
        <div className="min-w-0">
          <p className="truncate font-medium">{requirement.definition.name}</p>
          <p className="text-pretty text-xs leading-4.5 text-muted-foreground">
            {showSlot && `${slot} · `}
            {requirementNote(requirement, linked.length)}
          </p>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border">
        {data.edit === undefined ? (
          <ReadOnlyChoices {...props} slot={slot} requirement={requirement} linked={linked} />
        ) : (
          <EditableChoices
            {...props}
            edit={data.edit}
            slot={slot}
            requirement={requirement}
            linked={linked}
          />
        )}
      </div>
    </section>
  );
}

const rowClass =
  "group/account flex min-h-10 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2 transition-colors";
const radioClass =
  "grid size-4 shrink-0 place-items-center rounded-full border border-input shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary";
const radioDot = "size-2 rounded-full bg-primary";

/** Account names sort the rows, so linking one does not move it. */
const byName = <C extends { readonly account: AccountSummary }>(choices: readonly C[]) =>
  [...choices].sort(
    (a, b) =>
      accountName(a.account).localeCompare(accountName(b.account)) ||
      a.account.id.localeCompare(b.account.id),
  );

/** A member's view: the linked accounts with their status, and no controls. */
function ReadOnlyChoices<E>({
  app,
  slot,
  requirement,
  linked,
  data,
}: ScopeProps<E> & {
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly linked: readonly AccountSummary[];
}) {
  const plain = requirement.cardinality === "one";
  if (linked.length === 0)
    return <p className="px-3.5 py-2.5 text-[13px] text-muted-foreground">No account linked</p>;
  const rows = linked.map((account) => (
    <li key={account.id} className={rowClass}>
      {plain ? (
        <RadioGroup.Item
          value={account.id}
          aria-label={accountName(account)}
          className={radioClass}
        >
          <RadioGroup.Indicator className={radioDot} />
        </RadioGroup.Item>
      ) : (
        <Checkbox checked disabled aria-label={accountName(account)} />
      )}
      <AccountAvatar info={account.health?.info} className="size-5" />
      <span className="min-w-0 flex-1 break-words">{accountName(account)}</span>
      <AccountStatus app={app} account={account} />
      {data.accountMenu?.(account, slot, requirement, true)}
    </li>
  ));
  const list = (
    <ul
      aria-label={`${requirement.definition.name} accounts`}
      className="divide-y divide-border/50 text-[13px]"
    >
      {rows}
    </ul>
  );
  return plain ? (
    <RadioGroup.Root
      value={linked.at(-1)?.id ?? ""}
      disabled
      aria-label={`${requirement.definition.name} account`}
    >
      {list}
    </RadioGroup.Root>
  ) : (
    list
  );
}

/**
 * The accounts the caller could use for one requirement, from the host's read of it. Until that
 * read arrives the linked accounts show, without controls that could act on stale choices.
 */
function EditableChoices<E>({
  app,
  slot,
  requirement,
  linked,
  data,
  edit,
  accounts,
  Failure,
}: ScopeProps<E> & {
  readonly edit: LinkEditing<E>;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly linked: readonly AccountSummary[];
}) {
  const { result, data: loaded, refresh } = useQuery(edit.choices(slot));
  const plain = requirement.cardinality === "one";
  // A choice shows the page's own view of the account: its link's details, with sign-in state and
  // checks, or the caller's account list, which renames and reconnects keep current.
  const summarize = (account: Account): AccountSummary =>
    linked.find((item) => item.id === account.id) ??
    accounts.find((item) => item.id === account.id) ??
    account;
  const choices = byName(
    Option.match(loaded, {
      onNone: () => linked.map((account) => ({ account, linked: true })),
      // An account deleted since the read is no longer the caller's to link.
      onSome: (value) =>
        value.accounts.flatMap((choice) =>
          choice.linked || accounts.some((item) => item.id === choice.account.id)
            ? [{ account: summarize(choice.account), linked: choice.linked }]
            : [],
        ),
    }),
  );
  const ready = Option.isSome(loaded) && edit.connecting !== true;
  // Picking or connecting another account for a plain requirement retires an app-bound one, so it
  // asks first.
  const [replacingWithNew, setReplacingWithNew] = useState(false);
  const bound = plain
    ? choices.find(
        (choice) =>
          choice.linked &&
          requirement.definition.auth[choice.account.method]?.type === "interactive",
      )
    : undefined;
  const rows = choices.map((choice) => (
    <ChoiceRow
      replaces={
        bound !== undefined && bound.account.id !== choice.account.id
          ? accountName(bound.account)
          : undefined
      }
      key={choice.account.id}
      app={app}
      slot={slot}
      requirement={requirement}
      choice={choice}
      plain={plain}
      ready={ready}
      edit={edit}
      data={data}
      Failure={Failure}
    />
  ));
  const list = (
    <ul
      aria-label={`${requirement.definition.name} accounts`}
      className="divide-y divide-border/50 text-[13px]"
    >
      {rows}
    </ul>
  );
  return (
    <div className="divide-y divide-border/50">
      {AsyncResult.isFailure(result) && (
        <div className="px-3.5 py-2.5 text-xs">
          <Failure cause={result.cause} retry={refresh} retrying={result.waiting} />
        </div>
      )}
      {choices.length > 0 &&
        (plain ? (
          <RadioGroup.Root
            value={choices.find((choice) => choice.linked)?.account.id ?? ""}
            aria-label={`${requirement.definition.name} account`}
          >
            {list}
          </RadioGroup.Root>
        ) : (
          list
        ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-10 w-full justify-start rounded-none px-3.5 text-[13px] text-muted-foreground hover:text-foreground"
        disabled={edit.connecting === true}
        onClick={() =>
          bound === undefined ? edit.connect(slot, requirement) : setReplacingWithNew(true)
        }
      >
        <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden />
        Connect new account
      </Button>
      {replacingWithNew && bound !== undefined && (
        <RemoveAppBoundAccount
          name={accountName(bound.account)}
          app={app.name}
          pending={false}
          replacement="a new account"
          confirmLabel="Continue"
          onKeep={() => setReplacingWithNew(false)}
          onRemove={() => {
            setReplacingWithNew(false);
            edit.connect(slot, requirement);
          }}
        />
      )}
    </div>
  );
}

function ChoiceRow<E>({
  app,
  slot,
  requirement,
  choice,
  plain,
  ready,
  edit,
  data,
  Failure,
  replaces,
}: {
  /** The app-bound account that selecting this one would retire. */
  readonly replaces?: string | undefined;
  readonly app: App;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly choice: RequirementChoice<AccountSummary>;
  readonly plain: boolean;
  /** The choices are read and no connection is open. */
  readonly ready: boolean;
  readonly edit: LinkEditing<E>;
  readonly data: ScopeAccounts<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const { account, linked } = choice;
  const link = edit.link(slot, account.id);
  const unlink = edit.unlink(slot, account.id);
  const runLink = useAtomSet(link, { mode: "promiseExit" });
  const runUnlink = useAtomSet(unlink, { mode: "promiseExit" });
  const linking = useAtomValue(link);
  const unlinking = useAtomValue(unlink);
  const pending = AsyncResult.isWaiting(linking) || AsyncResult.isWaiting(unlinking);
  const [error, setError] = useState<Cause.Cause<E>>();
  const id = useId();
  const name = accountName(account);
  // An account the app acquired means nothing elsewhere, so unlinking it deletes it.
  const appBound = requirement.definition.auth[account.method]?.type === "interactive";
  const [confirming, setConfirming] = useState(false);
  const change = async (next: boolean) => {
    setError(undefined);
    const exit = await (next ? runLink() : runUnlink());
    if (Exit.isFailure(exit)) setError(exit.cause);
    else if (!next) edit.onUnlinked?.(account.id);
    return exit;
  };
  return (
    <li aria-busy={pending} className={cn(rowClass, "hover:bg-muted/25 focus-within:bg-muted/25")}>
      {plain ? (
        <RadioGroup.Item
          id={id}
          value={account.id}
          aria-label={name}
          disabled={!ready || pending}
          className={radioClass}
          onClick={() => {
            if (linked) return;
            if (replaces !== undefined) setConfirming(true);
            else void change(true);
          }}
        >
          <RadioGroup.Indicator className={radioDot} />
        </RadioGroup.Item>
      ) : (
        <Checkbox
          id={id}
          checked={linked}
          aria-label={name}
          disabled={!ready || pending}
          onCheckedChange={(checked) =>
            checked !== true && appBound ? setConfirming(true) : void change(checked === true)
          }
        />
      )}
      {confirming && (
        <RemoveAppBoundAccount
          name={replaces ?? name}
          app={app.name}
          pending={pending}
          {...(replaces === undefined ? {} : { replacement: name })}
          onKeep={() => setConfirming(false)}
          onRemove={() => void change(replaces !== undefined).then(() => setConfirming(false))}
        />
      )}
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
        <AccountAvatar info={account.health?.info} className="size-5" />
        <span className="min-w-0 flex-1 break-words">{name}</span>
      </label>
      {pending && <Spinner className="size-3.5 text-muted-foreground" />}
      <AccountStatus
        app={app}
        account={account}
        reconnect={data.reconnectAction?.(account, slot, requirement)}
      />
      {data.accountMenu?.(account, slot, requirement, linked)}
      {error && (
        <div className="basis-full text-xs">
          <Failure cause={error} />
        </div>
      )}
    </li>
  );
}

/** The menu's removal of an app-bound account, behind the same confirmation as its checkbox. */
function BoundUnlink<A, E>({
  unlink,
  name,
  app,
  onClose,
  onDone,
}: {
  readonly unlink: Atom.AtomResultFn<void, A, E>;
  readonly name: string;
  readonly app: string;
  readonly onClose: () => void;
  readonly onDone: (exit: Exit.Exit<A, E>) => void;
}) {
  const run = useAtomSet(unlink, { mode: "promiseExit" });
  const pending = AsyncResult.isWaiting(useAtomValue(unlink));
  return (
    <RemoveAppBoundAccount
      name={name}
      app={app}
      pending={pending}
      onKeep={onClose}
      onRemove={() =>
        void run().then((exit) => {
          onClose();
          onDone(exit);
        })
      }
    />
  );
}

/** Unlinking an app-bound account deletes it, and the app removes it where it signed in. */
function RemoveAppBoundAccount({
  name,
  app,
  pending,
  replacement,
  confirmLabel,
  onKeep,
  onRemove,
}: {
  readonly name: string;
  /** The confirming button, when it doesn't remove the account right away. */
  readonly confirmLabel?: string | undefined;
  /** Set when choosing another account for the requirement is what removes this one. */
  readonly replacement?: string | undefined;
  readonly app: string;
  readonly pending: boolean;
  readonly onKeep: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onKeep();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogTitle>
          {replacement === undefined ? `Remove ${name}?` : `Use ${replacement} instead of ${name}?`}
        </DialogTitle>
        <DialogDescription>
          Only {app} can use this account, because it signed the account in itself. Removing it
          deletes the account here and where {app} keeps it. Adding it back means signing in again.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onKeep}>
            Keep account
          </Button>
          <Button variant="destructive" loading={pending} onClick={onRemove}>
            {confirmLabel ?? (replacement === undefined ? "Remove account" : `Remove ${name}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** An account's sign-in state, or this app's check of it. */
function AccountStatus({
  app,
  account,
  reconnect,
}: {
  readonly app: App;
  readonly account: AccountSummary;
  readonly reconnect?: ReactNode;
}) {
  const rechecks = useContext(Checking);
  if (accountNeedsSignIn(account))
    return (
      <span className="flex items-center gap-2 text-xs text-sign-in-warning">
        Needs sign-in{reconnect}
      </span>
    );
  if (account.signIn?.state === "unavailable")
    return <span className="text-xs text-sign-in-warning">Unavailable</span>;
  return (
    <AppCheck
      health={account.health?.apps.find((entry) => entry.app === app.id)}
      checking={rechecks.running.has(account.id)}
      retry={rechecks.failed.has(account.id) ? () => rechecks.retry(account.id) : undefined}
    />
  );
}

/** This app's check of a linked account; apps without a check show nothing. */
function AppCheck({
  health,
  checking,
  retry,
}: {
  readonly health: AccountAppHealth | undefined;
  readonly checking: boolean;
  readonly retry: (() => void) | undefined;
}) {
  if (health === undefined || !health.checkable) return null;
  return <AccountCheckResult health={health} checking={checking} retry={retry} />;
}
