import { useDashboard } from "./context.tsx";
import { useState, type ReactNode, type ComponentType } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { Exit, type Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDataTransferHorizontalIcon,
  Cancel01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import type {
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
  type AccountSummary,
  type FailureProps,
} from "../../contracts/dashboard.ts";
import { ProviderIcon } from "./common.tsx";
import { EmptyState } from "./empty-state.tsx";
import { Button, type ButtonProps } from "../components/button.tsx";

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

/** Add an account or replace the binding for a provider that uses one account. */
export function AccountSelectionTrigger({
  requirement,
  selection,
  ...props
}: ButtonProps & {
  readonly requirement: AccountRequirement;
  readonly selection: SelectedAccounts[string] | undefined;
}) {
  const switching = requirement.cardinality === "one" && typeof selection === "string";
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-10 w-full justify-start rounded-none px-3.5 text-[13px] text-muted-foreground hover:text-foreground"
      aria-label={`${switching ? "Switch" : "Add"} ${requirement.definition.name} account`}
      {...props}
    >
      <HugeiconsIcon
        icon={switching ? ArrowDataTransferHorizontalIcon : Add01Icon}
        size={14}
        aria-hidden
      />
      {switching ? "Switch account" : "Add account"}
    </Button>
  );
}

/** Remove only this binding; keep the reusable account and every other provider selection. */
export function RemoveAccountBinding<E>({
  profile,
  slot,
  account,
  label,
  update,
  Failure,
}: {
  readonly profile: Profile;
  readonly slot: string;
  readonly account: AccountId;
  readonly label: string;
  readonly update: Atom.AtomResultFn<
    Omit<typeof ProfileInputs.update.Type, "app" | "profile">,
    Profile,
    E
  >;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const save = useAtomSet(update, { mode: "promiseExit" });
  const result = useAtomValue(update);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${label}`}
        title="Remove from this profile"
        className="shrink-0 text-muted-foreground hover:text-destructive [@media(hover:hover)]:opacity-0 group-hover/account:opacity-100 group-focus-within/account:opacity-100 focus-visible:opacity-100 data-loading:opacity-100"
        loading={pending}
        disabled={AsyncResult.isWaiting(result) || profile.status === "removing"}
        onClick={async () => {
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
        }}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={13} aria-hidden />
      </Button>
      {error && (
        <div className="basis-full text-xs">
          <Failure cause={error} />
        </div>
      )}
    </>
  );
}

/** Provider rows show the account bindings inside one profile or its editor. */
export function AppAccounts({
  app,
  accounts,
  chooseAction,
  reconnectAction,
  accountActions,
  removeAccountAction,
  onCreateProfile,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly chooseAction?: ReactNode;
  readonly reconnectAction?: (account: AccountSummary) => ReactNode;
  readonly accountActions?: (slot: string, requirement: AccountRequirement) => ReactNode;
  readonly removeAccountAction?: (slot: string, account: AccountId, label: string) => ReactNode;
  readonly onCreateProfile?: (() => void) | undefined;
}) {
  const { AccountLink } = useDashboard();
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
        const selected = app.accounts[slot];
        const ids = typeof selected === "string" ? [selected] : (selected ?? []);
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
            {(ids.length > 0 || action) && (
              <div
                className={
                  ids.length === 0
                    ? "overflow-hidden rounded-lg border border-dashed"
                    : "overflow-hidden rounded-lg border"
                }
              >
                {ids.length > 0 && (
                  <ul className="divide-y divide-border/50 text-[13px]">
                    {ids.map((id) => {
                      const account = accounts.find((item) => item.id === id);
                      return (
                        <li
                          key={id}
                          className="group/account flex min-h-10 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2 transition-colors hover:bg-muted/25 focus-within:bg-muted/25"
                        >
                          <HugeiconsIcon
                            icon={UserCircleIcon}
                            size={16}
                            className="shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 break-words [&_a:hover]:underline">
                            {account ? (
                              <AccountLink account={id}>
                                {account.label || "Unnamed account"}
                              </AccountLink>
                            ) : (
                              "Account disconnected"
                            )}
                          </span>
                          {account && accountNeedsSignIn(account) ? (
                            <span className="flex items-center gap-2 text-xs text-sign-in-warning">
                              Needs sign-in{reconnectAction?.(account)}
                            </span>
                          ) : account?.signIn?.state === "unavailable" ? (
                            <span className="text-xs text-sign-in-warning">Unavailable</span>
                          ) : null}
                          {removeAccountAction?.(
                            slot,
                            id,
                            account?.label || "Account disconnected",
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {action && (
                  <div className={ids.length > 0 ? "border-t border-border/50" : undefined}>
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
