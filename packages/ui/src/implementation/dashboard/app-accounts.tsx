import { useDashboard } from "./context.tsx";
import { useEffect, useRef, useState, type ReactNode, type ComponentType } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/reactivity";
import { Exit, type Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type {
  AccountAppHealth,
  App,
  AccountId,
  AccountRequirement,
  SelectedAccounts,
  Profile,
  ProfileInputs,
} from "@executor-js/sdk";
import {
  providerDisplayUrl,
  accountNeedsSignIn,
  type AccountDetail,
  type AccountSummary,
  type FailureProps,
} from "../../contracts/dashboard.ts";
import { ProviderIcon } from "./common.tsx";
import { AccountAvatar, AccountCheckResult } from "./account-health.tsx";
import { EmptyState } from "./empty-state.tsx";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
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

/** Explain a provider's account limit and offer a separate profile when the host permits it. */
export function ProviderAccountSupport({
  requirement,
  onCreateProfile,
}: {
  readonly requirement: AccountRequirement;
  readonly onCreateProfile?: (() => void) | undefined;
}) {
  const many = requirement.cardinality === "many";
  return (
    <>
      {many
        ? `This app supports using multiple ${requirement.definition.name} accounts.`
        : `This app only supports one ${requirement.definition.name} account${onCreateProfile ? ", create a" : "."}`}
      {onCreateProfile && (
        <span className={many ? "block text-pretty" : undefined}>
          {many ? "If you want to use a different combination of accounts,\u00a0" : " "}
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-foreground max-[740px]:min-h-0"
            aria-label="Create a profile"
            onClick={onCreateProfile}
          >
            {many ? "create a profile" : "profile"}
          </Button>
          {many ? "." : " to add more than one account."}
        </span>
      )}
    </>
  );
}

type AccountBindingProps<E> = {
  readonly profile: Profile;
  readonly slot: string;
  readonly account: AccountId;
  readonly label: string;
  /** Whether this profile selects the account; only a selected account can be removed from it. */
  readonly bound: boolean;
  readonly update: Atom.AtomResultFn<
    Omit<typeof ProfileInputs.update.Type, "app" | "profile">,
    Profile,
    E
  >;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onRemoved?: ((account: AccountId) => void) | undefined;
};

/** Remove only this binding; keep the reusable account and every other provider selection. */
function useRemoveAccountBinding<E>({
  profile,
  slot,
  account,
  update,
  onRemoved,
}: AccountBindingProps<E>) {
  const save = useAtomSet(update, { mode: "promiseExit" });
  const result = useAtomValue(update);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  return {
    pending,
    error,
    disabled: AsyncResult.isWaiting(result) || profile.status === "removing",
    remove: async () => {
      const current = profile.accounts[slot];
      const accounts: SelectedAccounts = Object.fromEntries(
        Object.entries(profile.accounts).filter(([name]) => name !== slot),
      );
      const next =
        current !== undefined && typeof current !== "string"
          ? { ...accounts, [slot]: current.filter((id) => id !== account) }
          : accounts;
      setError(undefined);
      setPending(true);
      const saved = await save({ accounts: next, expectedRevision: profile.revision });
      setPending(false);
      if (Exit.isFailure(saved)) setError(saved.cause);
      else onRemoved?.(account);
    },
  };
}

/**
 * An account's actions in this app: the host's items, then removal from the profile when the
 * profile selects it. Removal keeps the reusable account and every other provider selection.
 */
export function AccountBindingMenu<E>({
  children,
  ...props
}: AccountBindingProps<E> & { readonly children?: ReactNode }) {
  const removal = useRemoveAccountBinding(props);
  const { Failure } = props;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Manage ${props.label}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            loading={removal.pending}
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} size={14} strokeWidth={2} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {children}
          {children && props.bound && <DropdownMenuSeparator />}
          {props.bound && (
            <DropdownMenuItem
              variant="destructive"
              disabled={removal.disabled}
              onSelect={() => void removal.remove()}
            >
              Remove
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {removal.error && (
        <div className="basis-full text-xs">
          <Failure cause={removal.error} />
        </div>
      )}
    </>
  );
}

/**
 * Accounts are saved separately from the apps that select them, so removing one from an app
 * keeps it. After an explicit removal leaves no app selecting an account, offer to delete it.
 * Unselecting an account in a chooser is not a removal and does not prompt.
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
          Accounts are saved separately from apps, so any app can reuse them. Removing an account
          from an app keeps it saved. No app uses this account now.
        </DialogDescription>
        <p className="text-sm text-muted-foreground">
          Delete it if you no longer need it. This removes the saved credentials from Executor but
          does not revoke access at {provider}.
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

/** Saves one slot's next binding in place; rows stay disabled while a save is in flight. */
export interface AccountChooser {
  readonly choose: (slot: string, value: SelectedAccounts[string]) => void;
  readonly pending: boolean;
}

/**
 * One slot's rows. Choosing lists every compatible saved account oldest first, so a new account
 * joins the end; bound accounts that are no longer compatible stay visible to be removed.
 */
function slotRows(
  requirement: AccountRequirement,
  ids: readonly AccountId[],
  accounts: readonly AccountSummary[],
  choosing: boolean,
): readonly AccountId[] {
  if (!choosing) return ids;
  return [
    ...accounts
      .filter((account) => account.provider === requirement.provider)
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((account) => account.id),
    ...ids.filter(
      (id) =>
        !accounts.some((account) => account.id === id && account.provider === requirement.provider),
    ),
  ];
}

const selectedIds = (selected: SelectedAccounts[string] | undefined): readonly AccountId[] =>
  typeof selected === "string" ? [selected] : (selected ?? []);

/** How long a check result stays fresh before viewing the app's accounts checks again. */
const checkFreshFor = 5 * 60 * 1000;

/**
 * Stale while revalidate: rows show the recorded checks at once, and each listed account this
 * app checks is checked again in the background, once per view, when its result is missing,
 * outdated or older than `checkFreshFor`. Reads hide this app's result for an account it does
 * not select, so the reported identity's age stands in there.
 */
function useRevalidateChecks(
  app: App,
  selection: SelectedAccounts,
  accounts: readonly AccountSummary[],
  choosing: boolean,
  revalidate: ((account: AccountId) => Promise<unknown>) | undefined,
) {
  const started = useRef(new Set<AccountId>());
  useEffect(() => {
    if (revalidate === undefined) return;
    const now = Date.now();
    for (const [slot, requirement] of Object.entries(app.requirements.accounts)) {
      if (requirement.health !== true) continue;
      for (const id of slotRows(requirement, selectedIds(selection[slot]), accounts, choosing)) {
        const account = accounts.find((item) => item.id === id);
        if (
          account?.health === undefined ||
          started.current.has(id) ||
          accountNeedsSignIn(account) ||
          account.signIn?.state === "unavailable"
        )
          continue;
        const entry = account.health.apps.find((item) => item.app === app.id);
        const checkedAt =
          entry === undefined ? account.health.infoCheckedAt : (entry.check?.checkedAt ?? null);
        const fresh =
          checkedAt !== null &&
          entry?.check?.current !== false &&
          now - checkedAt.getTime() < checkFreshFor;
        if (fresh) continue;
        started.current.add(id);
        void revalidate(id);
      }
    }
  });
}

/** Provider rows show the account bindings inside one profile or its editor. */
export function AppAccounts({
  app,
  selection,
  accounts,
  chooser,
  chooseAction,
  reconnectAction,
  accountActions,
  removeAccountAction,
  onCreateProfile,
  revalidate,
}: {
  readonly app: App;
  readonly selection: SelectedAccounts;
  readonly accounts: readonly AccountSummary[];
  readonly chooser?: AccountChooser | undefined;
  readonly chooseAction?: ReactNode;
  readonly reconnectAction?: (account: AccountSummary) => ReactNode;
  readonly accountActions?: (slot: string, requirement: AccountRequirement) => ReactNode;
  readonly removeAccountAction?: (
    slot: string,
    account: AccountId,
    label: string,
    bound: boolean,
  ) => ReactNode;
  readonly onCreateProfile?: (() => void) | undefined;
  /** Check one account again; its result reaches `accounts` through the host's queries. */
  readonly revalidate?: ((account: AccountId) => Promise<unknown>) | undefined;
}) {
  const { AccountLink } = useDashboard();
  useRevalidateChecks(app, selection, accounts, chooser !== undefined, revalidate);
  const requirements = Object.entries(app.requirements.accounts);
  if (requirements.length === 0)
    return (
      <EmptyState size="compact" title="No accounts required">
        This app can run without a saved account.
      </EmptyState>
    );
  return (
    <div className="accounts-section space-y-5">
      {requirements.map(([slot, requirement]) => {
        const selected = selection[slot];
        const ids = selectedIds(selected);
        const many = requirement.cardinality === "many";
        const rows = slotRows(requirement, ids, accounts, chooser !== undefined);
        const action = accountActions?.(slot, requirement) ?? chooseAction;
        const showSlot = requirements.some(
          ([otherSlot, other]) =>
            otherSlot !== slot && other.definition.name === requirement.definition.name,
        );
        return (
          <section
            key={slot}
            aria-label={
              requirements.length > 1
                ? `${requirement.definition.name} (${slot})`
                : requirement.definition.name
            }
            className="min-w-0 space-y-2.5"
          >
            <div className="flex min-h-8 min-w-0 items-center gap-3 text-sm [&_.provider-icon]:size-14 [&_.provider-icon]:rounded-lg [&_.provider-icon]:border-0 [&_.provider-icon]:bg-muted/40 [&_.provider-icon>img]:size-8 [&_.provider-icon>svg]:size-8">
              <ProviderIcon
                name={requirement.definition.name}
                url={providerDisplayUrl(requirement.definition)}
                large
              />
              <div className="min-w-0">
                <p className="truncate font-medium">{requirement.definition.name}</p>
                <p className="text-pretty text-xs leading-4.5 text-muted-foreground">
                  {showSlot && `${slot} · `}
                  <ProviderAccountSupport
                    requirement={requirement}
                    onCreateProfile={onCreateProfile}
                  />
                </p>
              </div>
              {ids.length > 0 && (
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  {ids.length} {ids.length === 1 ? "account" : "accounts"}
                </span>
              )}
            </div>
            {(rows.length > 0 || action) && (
              <div
                className={
                  rows.length === 0
                    ? "overflow-hidden rounded-lg border border-dashed"
                    : "overflow-hidden rounded-lg border"
                }
              >
                {rows.length > 0 && (
                  <ul
                    role={chooser && !many ? "radiogroup" : undefined}
                    aria-label={chooser ? `${requirement.definition.name} accounts` : undefined}
                    className="divide-y divide-border/50 text-[13px]"
                  >
                    {rows.map((id) => {
                      const account = accounts.find((item) => item.id === id);
                      const label = account?.label || (account ? "Unnamed account" : undefined);
                      const bound = ids.includes(id);
                      const status =
                        account && accountNeedsSignIn(account) ? (
                          <span className="flex items-center gap-2 text-xs text-sign-in-warning">
                            Needs sign-in{reconnectAction?.(account)}
                          </span>
                        ) : account?.signIn?.state === "unavailable" ? (
                          <span className="text-xs text-sign-in-warning">Unavailable</span>
                        ) : (
                          <AppCheck
                            health={account?.health?.apps.find((entry) => entry.app === app.id)}
                          />
                        );
                      return (
                        <li
                          key={id}
                          className="group/account flex min-h-10 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2 transition-colors hover:bg-muted/25 focus-within:bg-muted/25"
                        >
                          {chooser ? (
                            <label
                              className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 ${bound ? "" : "text-muted-foreground hover:text-foreground"} has-disabled:cursor-default`}
                            >
                              {many ? (
                                <Checkbox
                                  checked={bound}
                                  disabled={chooser.pending}
                                  onCheckedChange={(checked) =>
                                    chooser.choose(
                                      slot,
                                      checked === true
                                        ? [...ids, id]
                                        : ids.filter((other) => other !== id),
                                    )
                                  }
                                />
                              ) : (
                                <input
                                  type="radio"
                                  name={`${app.id}-${slot}`}
                                  checked={bound}
                                  disabled={chooser.pending || (!bound && !account)}
                                  onChange={() => chooser.choose(slot, id)}
                                  className="size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-input shadow-xs outline-none transition-shadow checked:border-[5px] checked:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 dark:bg-input/30"
                                />
                              )}
                              <AccountAvatar info={account?.health?.info} className="size-5" />
                              <span className="min-w-0 flex-1 break-words">
                                {label ?? "Account disconnected"}
                              </span>
                            </label>
                          ) : (
                            <>
                              <AccountAvatar info={account?.health?.info} className="size-5" />
                              <span className="min-w-0 flex-1 break-words [&_a:hover]:underline">
                                {label ? (
                                  <AccountLink account={id}>{label}</AccountLink>
                                ) : (
                                  "Account disconnected"
                                )}
                              </span>
                            </>
                          )}
                          {status}
                          {/* Unchecking only unselects; removal is its own action and may offer deletion. */}
                          {removeAccountAction?.(slot, id, label ?? "Account disconnected", bound)}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {action && (
                  <div className={rows.length > 0 ? "border-t border-border/50" : undefined}>
                    {action}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** This app's check of a selected account; apps without a check show nothing. */
function AppCheck({ health }: { readonly health: AccountAppHealth | undefined }) {
  if (health === undefined || (!health.checkable && health.check === null)) return null;
  return <AccountCheckResult health={health} />;
}
