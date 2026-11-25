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
import { CopyButton } from "./code.tsx";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
import { Skeleton } from "../components/skeleton.tsx";
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

export function LinkedAccountMenu<A, E>({
  label,
  unlink,
  Failure,
  onUnlinked,
  children,
}: {
  readonly label: string;
  readonly unlink?: Atom.AtomResultFn<void, A, E> | undefined;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onUnlinked?: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const [error, setError] = useState<Cause.Cause<E>>();
  const [pending, setPending] = useState(false);
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
          {unlink && (
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

const checkFreshFor = 5 * 60 * 1000;

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

type Revalidate = (account: AccountId) => Promise<Exit.Exit<unknown, unknown>>;
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

export interface LinkEditing<E> {
  readonly choices: (
    slot: string,
  ) => Query<{ readonly accounts: readonly RequirementChoice<Account>[] }, E>;
  readonly link: (slot: string, account: AccountId) => Atom.AtomResultFn<void, unknown, E>;
  readonly unlink: (slot: string, account: AccountId) => Atom.AtomResultFn<void, unknown, E>;
  readonly connect: (slot: string, requirement: AccountRequirement) => void;
  readonly connecting?: boolean | undefined;
  readonly onUnlinked?: ((account: AccountId) => void) | undefined;
}

export interface ScopeAccounts<E> {
  readonly links: readonly RequirementLink<AccountSummary>[];
  readonly edit?: LinkEditing<E> | undefined;
  readonly readOnly?: string | undefined;
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
  readonly revalidate?: Revalidate | undefined;
}

export function AppAccounts<E>({
  app,
  appAccounts,
  yourAccounts,
  accounts,
  canEdit,
  Failure,
}: {
  readonly app: App;
  readonly appAccounts: ScopeAccounts<E>;
  readonly yourAccounts: ScopeAccounts<E>;
  readonly accounts: readonly AccountSummary[];
  readonly canEdit: boolean;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  return (
    <div className="accounts-section space-y-8">
      {accountScopes.map(({ scope, title, description }) => {
        const requirements = scoped(app, scope);
        return requirements.length === 0 ? (
          <AccountScopeSection key={scope} title={title} description={description}>
            <NoScopeAccounts app={app} scope={scope} canEdit={canEdit} />
          </AccountScopeSection>
        ) : (
          <LinkScope
            key={scope}
            app={app}
            scope={scope}
            title={title}
            description={description}
            requirements={requirements}
            data={scope === "app" ? appAccounts : yourAccounts}
            accounts={accounts}
            Failure={Failure}
          />
        );
      })}
    </div>
  );
}

export const accountScopes = [
  { scope: "app", title: "App accounts", description: "Linked for everyone" },
  { scope: "user", title: "Your accounts", description: "Linked for you" },
] as const satisfies readonly {
  readonly scope: AccountScope;
  readonly title: string;
  readonly description: string;
}[];

export function AccountScopeSection({
  title,
  description,
  readOnly,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly readOnly?: boolean | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} data-read-only={readOnly} className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

const scopeGuide = {
  app: {
    title: "No app accounts",
    kind: "an app account",
    detail: (
      <>
        One account linked for everyone, such as a team API key. Callers, schedules and webhooks all
        use it, and the app reads it as <code>ctx.app.accounts</code>.
      </>
    ),
  },
  user: {
    title: "No user accounts",
    kind: "a user account",
    detail: (
      <>
        Each person links their own account, and the app reads the caller’s as{" "}
        <code>ctx.user.accounts</code>.
      </>
    ),
  },
} as const satisfies Record<
  AccountScope,
  { readonly title: string; readonly kind: string; readonly detail: ReactNode }
>;

const addAccountPrompt = (app: App, scope: AccountScope) => {
  const target = `my Executor app ${JSON.stringify(app.name)} (app ID: ${app.id})`;
  const read = `First read accounts.md in the Executor app's app-authoring skill and the app's current source. Declare the provider with defineProvider`;
  return scope === "app"
    ? `Add an app account to ${target}: one shared [service, for example Datadog] account that people who can edit the app link once for everyone. Every caller, schedule and webhook uses it. ${read}, add it under the app scope of the requirements, { app: { accounts } }, and read it in tools as ctx.app.accounts.<name>. Never put credentials in source. Deploy the updated app, then tell me to link the account under App accounts on its Accounts tab.`
    : `Add a user account to ${target} so each person who uses it connects their own [service, for example GitHub] account. ${read}, add it under the user scope of the requirements, { user: { accounts } }, and read the caller's account in tools as ctx.user.accounts.<name>. Never put credentials in source. Deploy the updated app, then tell me to link my account under Your accounts on its Accounts tab.`;
};

export function NoScopeAccounts({
  app,
  scope,
  canEdit,
}: {
  readonly app: App;
  readonly scope: AccountScope;
  readonly canEdit: boolean | undefined;
}) {
  const guide = scopeGuide[scope];
  return (
    <div className="rounded-lg border border-dashed px-4 py-3.5">
      <h3 className="text-[13px] font-medium">{guide.title}</h3>
      <p className="mt-1 max-w-xl text-pretty text-xs leading-5 text-muted-foreground">
        {guide.detail}
      </p>
      <div className="mt-3 flex min-h-9 items-center">
        {canEdit === undefined ? (
          <Skeleton className="h-9 w-32" />
        ) : canEdit ? (
          <CopyButton
            code={addAccountPrompt(app, scope)}
            label={`Copy prompt to add ${guide.kind}`}
            text="Copy prompt"
            variant="outline"
            size="default"
            inline
          />
        ) : (
          <p className="text-xs text-muted-foreground">People who can edit this app can add one.</p>
        )}
      </div>
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
      <AccountScopeSection title={title} description={description} readOnly={readOnly}>
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
      </AccountScopeSection>
    </Checking.Provider>
  );
}

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

const byName = <C extends { readonly account: AccountSummary }>(choices: readonly C[]) =>
  [...choices].sort(
    (a, b) =>
      accountName(a.account).localeCompare(accountName(b.account)) ||
      a.account.id.localeCompare(b.account.id),
  );

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
  const summarize = (account: Account): AccountSummary =>
    linked.find((item) => item.id === account.id) ??
    accounts.find((item) => item.id === account.id) ??
    account;
  const choices = byName(
    Option.match(loaded, {
      onNone: () => linked.map((account) => ({ account, linked: true })),
      onSome: (value) =>
        value.accounts.flatMap((choice) =>
          choice.linked || accounts.some((item) => item.id === choice.account.id)
            ? [{ account: summarize(choice.account), linked: choice.linked }]
            : [],
        ),
    }),
  );
  const ready = Option.isSome(loaded) && edit.connecting !== true;
  const rows = choices.map((choice) => (
    <ChoiceRow
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
        onClick={() => edit.connect(slot, requirement)}
      >
        <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden />
        Connect new account
      </Button>
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
}: {
  readonly app: App;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly choice: RequirementChoice<AccountSummary>;
  readonly plain: boolean;
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
  const change = async (next: boolean) => {
    setError(undefined);
    const exit = await (next ? runLink() : runUnlink());
    if (Exit.isFailure(exit)) setError(exit.cause);
    else if (!next) edit.onUnlinked?.(account.id);
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
            if (!linked) void change(true);
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
          onCheckedChange={(checked) => void change(checked === true)}
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
