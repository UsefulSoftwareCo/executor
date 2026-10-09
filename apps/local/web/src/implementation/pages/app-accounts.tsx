import { useContext, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { Effect, Exit, type Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { accountSelectionAtom, profileMutations } from "../../contracts/profiles.ts";
import {
  accountAtom,
  accountUsageAtom,
  checkAccountAtom,
  disconnectAccountAtom,
} from "../../contracts/accounts.ts";
import type { DashboardError } from "../../contracts/errors.ts";
import { Failure, LoadingRows } from "../components/common.tsx";
import { AppAccountForm } from "./account-form.tsx";
import { ReplaceCredentials } from "./account-credentials.tsx";
import { LocalAccountDialog } from "./account-actions.tsx";
import { Button } from "@executor-js/ui/components/button";
import { DropdownMenuItem } from "@executor-js/ui/components/dropdown-menu";
import { QueryView } from "@executor-js/ui/dashboard/context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import {
  AppAccounts as SharedAccounts,
  AccountBindingMenu,
  useUnusedAccountPrompt,
} from "@executor-js/ui/dashboard/app-accounts";
import type {
  Account,
  AccountId,
  App,
  AccountRequirement,
  SelectedAccounts,
  Profile,
  ProfileId,
} from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";

/** A new profile starts with every multiple-account slot bound to no accounts. */
function emptySelection(app: App): SelectedAccounts {
  return Object.fromEntries(
    Object.entries(app.requirements.accounts)
      .filter(([, requirement]) => requirement.cardinality === "many")
      .map(([name]) => [name, []]),
  );
}

/** Save one slot of the shown profile, creating the profile on its first binding. */
export function useAccountChooser({
  app,
  profile,
  onSelected,
}: {
  readonly app: App;
  readonly profile: Profile | undefined;
  readonly onSelected: (id: ProfileId) => void;
}) {
  const registry = useContext(RegistryContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<DashboardError>>();
  const choose = async (slot: string, value: SelectedAccounts[string]) => {
    const base: SelectedAccounts = profile?.accounts ?? emptySelection(app);
    const mutation = accountSelectionAtom({
      app: app.id,
      target:
        profile === undefined
          ? { kind: "new", request: crypto.randomUUID() }
          : { kind: "saved", id: profile.id, revision: profile.revision },
    });
    setPending(true);
    setError(undefined);
    registry.set(mutation, { app: app.id, accounts: { ...base, [slot]: value } });
    const exit = await Effect.runPromiseExit(
      AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true }),
    );
    setPending(false);
    if (Exit.isFailure(exit)) setError(exit.cause);
    else if (exit.value.id !== profile?.id) onSelected(exit.value.id);
    return exit;
  };
  return { choose, pending, error };
}

/** Choose saved accounts in place and connect new ones without leaving the Accounts tab. */
export function AppAccounts({
  app,
  data,
  profile,
  onSelected,
  onCreateProfile,
}: {
  readonly onSelected: (id: ProfileId) => void;
  readonly onCreateProfile?: (() => void) | undefined;
  readonly app: App;
  readonly data: DashboardOverview;
  readonly profile: Profile | undefined;
}) {
  const chooser = useAccountChooser({ app, profile, onSelected });
  const registry = useContext(RegistryContext);
  const revalidate = (account: AccountId) => {
    const check = checkAccountAtom(account);
    registry.set(check, undefined);
    return Effect.runPromiseExit(
      AtomRegistry.getResult(registry, check, { suspendOnWaiting: true }),
    );
  };
  const unused = useUnusedAccountPrompt({
    usage: accountUsageAtom,
    remove: disconnectAccountAtom,
    Failure,
  });
  const [connection, setConnection] = useState<{
    readonly slot: string;
    readonly requirement: AccountRequirement;
  }>();
  const [connecting, setConnecting] = useState(false);
  // Credentials are replaced here, where the app shows which hosts receive them.
  const [replacing, setReplacing] = useState<{
    readonly slot: string;
    readonly requirement: AccountRequirement;
    readonly account: AccountId;
  }>();
  const [replacingBusy, setReplacingBusy] = useState(false);
  const [renaming, setRenaming] = useState<AccountId>();
  // A saved account shows at once. Drop it once the inventory lists it, so the inventory alone
  // decides later changes: a deleted account must not reappear from this copy.
  const [added, setAdded] = useState<readonly Account[]>([]);
  const pending = added.filter((account) => !data.accounts.some((item) => item.id === account.id));
  if (pending.length !== added.length) setAdded(pending);
  const accounts = [...data.accounts, ...pending];
  const replacingAccount = accounts.find((account) => account.id === replacing?.account);
  const replacingOAuth =
    replacing !== undefined &&
    replacingAccount !== undefined &&
    replacing.requirement.definition.auth[replacingAccount.method]?.type === "oauth2";
  const replace = (slot: string, account: AccountId) => {
    const requirement = app.requirements.accounts[slot];
    if (requirement !== undefined) setReplacing({ slot, requirement, account });
  };
  const boundSlot = (account: AccountId) =>
    Object.entries(profile?.accounts ?? {}).find(([, selected]) =>
      typeof selected === "string" ? selected === account : selected.includes(account),
    )?.[0];
  return (
    <>
      <SharedAccounts
        app={app}
        selection={profile?.accounts ?? {}}
        accounts={accounts}
        onCreateProfile={onCreateProfile}
        revalidate={revalidate}
        chooser={{
          pending: chooser.pending,
          choose: (slot, value) => void chooser.choose(slot, value),
        }}
        removeAccountAction={(slot, account, label, bound) => {
          if (profile === undefined) return null;
          const saved = accounts.find((item) => item.id === account);
          // An unselected account offers only its own actions; with none, it has no menu.
          if (!bound && saved === undefined) return null;
          const requirement = app.requirements.accounts[slot];
          return (
            <AccountBindingMenu
              profile={profile}
              slot={slot}
              account={account}
              label={label}
              bound={bound}
              update={profileMutations({ app: app.id, profile: profile.id }).update}
              Failure={Failure}
              onRemoved={(removed) => void unused.check(removed)}
            >
              {saved && (
                <>
                  <DropdownMenuItem onSelect={() => setRenaming(saved.id)}>Rename</DropdownMenuItem>
                  {requirement !== undefined && (
                    <DropdownMenuItem onSelect={() => replace(slot, saved.id)}>
                      {requirement.definition.auth[saved.method]?.type === "oauth2"
                        ? "Reconnect"
                        : "Update credentials"}
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </AccountBindingMenu>
          );
        }}
        accountActions={(slot, requirement) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-10 w-full justify-start rounded-none px-3.5 text-[13px] text-muted-foreground hover:text-foreground"
            disabled={chooser.pending}
            onClick={() => setConnection({ slot, requirement })}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden />
            Connect new account
          </Button>
        )}
        reconnectAction={(account) => {
          const slot = boundSlot(account.id);
          return (
            slot !== undefined && (
              <Button variant="outline" size="sm" onClick={() => replace(slot, account.id)}>
                Reconnect
              </Button>
            )
          );
        }}
      />
      {chooser.error && <Failure cause={chooser.error} />}
      {unused.prompt}
      <Dialog
        open={connection !== undefined}
        onOpenChange={(open) => {
          if (!open && !connecting) setConnection(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
          <DialogTitle>Connect {connection?.requirement.definition.name}</DialogTitle>
          <DialogDescription className="sr-only">
            Connect an account for {app.name}.
          </DialogDescription>
          {connection && (
            <AppAccountForm
              app={app.id}
              requirement={connection.slot}
              provider={{
                id: connection.requirement.provider,
                definition: connection.requirement.definition,
              }}
              profile={profile?.id}
              selection={profile?.accounts ?? emptySelection(app)}
              checkWith={connection.requirement.health === true}
              onPendingChange={setConnecting}
              onSaved={(account, saved) => {
                // The server selected the account for this profile as it saved it.
                setConnection(undefined);
                setAdded((current) => [...current, account]);
                if (saved !== profile?.id) onSelected(saved);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={replacing !== undefined}
        onOpenChange={(open) => {
          if (!open && !replacingBusy) setReplacing(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
          <DialogTitle>{replacingOAuth ? "Reconnect account" : "Update credentials"}</DialogTitle>
          <DialogDescription className="sr-only">
            Replace this account's credentials for {app.name}.
          </DialogDescription>
          {replacing && profile && (
            <QueryView
              key={replacing.account}
              query={accountAtom(replacing.account)}
              Failure={Failure}
              pending={<LoadingRows />}
            >
              {(detail) =>
                detail.canManage ? (
                  <ReplaceCredentials
                    data={detail}
                    app={app.id}
                    slot={replacing.slot}
                    requirement={replacing.requirement}
                    profile={profile}
                    onPendingChange={setReplacingBusy}
                    onDone={() => setReplacing(undefined)}
                  />
                ) : (
                  <p>This account is managed by the local server.</p>
                )
              }
            </QueryView>
          )}
        </DialogContent>
      </Dialog>
      {renaming && (
        <LocalAccountDialog id={renaming} dialog="edit" onClose={() => setRenaming(undefined)} />
      )}
    </>
  );
}
