import { useContext, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { RegistryContext, useAtomSet, useAtomMount } from "@effect/atom-react";
import { Option, Exit, Effect, type Cause } from "effect";
import { useQuery } from "@executor-js/ui/dashboard/context";
import { appAccessAtom } from "../../contracts/resource-access.ts";
import type {
  Provider,
  AccountRequirement,
  App,
  SelectedAccounts,
  Profile,
  ProfileId,
} from "@executor-js/sdk";
import {
  AppAccounts as SharedAccounts,
  AccountBindingMenu,
  useUnusedAccountPrompt,
} from "@executor-js/ui/dashboard/app-accounts";
import { DropdownMenuItem } from "@executor-js/ui/components/dropdown-menu";
import type { AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { Button } from "@executor-js/ui/components/button";
import { ConnectionDialogHeader, ConnectionModal } from "./connection-dialog.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { appConnectionAtoms, oauthSetupAtom } from "../../contracts/apps.ts";
import { HostedAccountForm, openAccountOAuth } from "./connect-account.tsx";
import type { HostedOAuthSignIn } from "@executor-js/hosted-server";
import type { AccountConnectionId, AccountId } from "@executor-js/sdk";
import type { HostedError } from "../../contracts/errors.ts";
import { accountSelectionAtom, profileMutations } from "../../contracts/profiles.ts";
import {
  accountUsageAtom,
  checkAccountAtom,
  disconnectAccountAtom,
} from "../../contracts/accounts.ts";
import { AtomRegistry } from "effect/reactivity";
import { HostedAccountDialog } from "./account-actions.tsx";

/** A new profile starts with every multiple-account slot bound to no accounts. */
function emptySelection(app: App): SelectedAccounts {
  return Object.fromEntries(
    Object.entries(app.requirements.accounts)
      .filter(([, requirement]) => requirement.cardinality === "many")
      .map(([name]) => [name, []]),
  );
}

/** Save one slot of the shown profile, creating the profile on its first binding. */
function useAccountChooser({
  app,
  profile,
  onSelected,
}: {
  readonly app: App;
  readonly profile: Profile | undefined;
  readonly onSelected: (id: ProfileId) => void;
}) {
  const { organization } = useOrganizationRoute();
  const registry = useContext(RegistryContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<HostedError>>();
  const choose = async (slot: string, value: SelectedAccounts[string]) => {
    const mutation = accountSelectionAtom({
      organization,
      app: app.id,
      target:
        profile === undefined
          ? { kind: "new", request: crypto.randomUUID() }
          : { kind: "saved", id: profile.id, revision: profile.revision },
    });
    setPending(true);
    setError(undefined);
    registry.set(mutation, {
      app: app.id,
      accounts: { ...(profile?.accounts ?? emptySelection(app)), [slot]: value },
    });
    const exit = await Effect.runPromiseExit(
      AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true }),
    );
    setPending(false);
    if (Exit.isFailure(exit)) setError(exit.cause);
    else if (exit.value.id !== profile?.id) onSelected(exit.value.id);
  };
  return { choose, pending, error };
}

/**
 * Choose saved accounts in place and connect new ones without leaving the Accounts tab.
 * The host still authorizes every selection and connection.
 */
export function AppAccounts({
  app,
  accounts,
  redirectUri,
  profile,
  onSelected,
  onCreateProfile,
}: {
  readonly profile?: Profile | undefined;
  readonly onSelected: (id: ProfileId) => void;
  readonly onCreateProfile?: (() => void) | undefined;
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly redirectUri: string;
}) {
  const { organization } = useOrganizationRoute();
  const { data } = useQuery(appAccessAtom({ organization, app: app.id }));
  const canUse = Option.isSome(data) && data.value.canUse;
  const editable = canUse && app.activeDeployment !== null;
  const chooser = useAccountChooser({ app, profile, onSelected });
  const registry = useContext(RegistryContext);
  const revalidate = (account: AccountId) => {
    const check = checkAccountAtom({ organization, account });
    registry.set(check, undefined);
    return Effect.runPromiseExit(
      AtomRegistry.getResult(registry, check, { suspendOnWaiting: true }),
    );
  };
  const unused = useUnusedAccountPrompt({
    usage: accountUsageAtom(organization),
    remove: (account) => disconnectAccountAtom({ organization, account }),
    Failure: HostedFailure,
  });
  const [connection, setConnection] = useState<{
    readonly slot: string;
    readonly requirement: AccountRequirement;
    readonly method: string;
    /** Set when replacing this account's credentials rather than adding an account. */
    readonly account?: AccountSummary | undefined;
  }>();
  const [renaming, setRenaming] = useState<AccountSummary["id"]>();
  const [connecting, setConnecting] = useState(false);
  const pending = chooser.pending || connecting;
  // Reconnecting through the app shows the hosts this app's declaration grants.
  const reconnect = (slot: string, account: AccountSummary) => {
    const requirement = app.requirements.accounts[slot];
    if (requirement !== undefined)
      setConnection({ slot, requirement, method: account.method, account });
  };
  const boundSlot = (account: AccountSummary["id"]) =>
    Object.entries(profile?.accounts ?? {}).find(([, selected]) =>
      typeof selected === "string" ? selected === account : selected.includes(account),
    )?.[0];
  return (
    <>
      <SharedAccounts
        app={app}
        selection={profile?.accounts ?? {}}
        accounts={accounts}
        onCreateProfile={canUse ? onCreateProfile : undefined}
        revalidate={canUse ? revalidate : undefined}
        chooser={
          editable
            ? { pending, choose: (slot, value) => void chooser.choose(slot, value) }
            : undefined
        }
        removeAccountAction={(slot, account, label, bound) => {
          if (!canUse || profile === undefined) return null;
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
              update={profileMutations({ organization, app: app.id, profile: profile.id }).update}
              Failure={HostedFailure}
              onRemoved={(removed) => void unused.check(removed)}
            >
              {saved && (
                <>
                  <DropdownMenuItem onSelect={() => setRenaming(saved.id)}>
                    Edit details
                  </DropdownMenuItem>
                  {editable && requirement !== undefined && (
                    <DropdownMenuItem disabled={pending} onSelect={() => reconnect(slot, saved)}>
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
        {...(editable
          ? {
              reconnectAction: (account: AccountSummary) => {
                const slot = boundSlot(account.id);
                return (
                  slot !== undefined && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => reconnect(slot, account)}
                    >
                      Reconnect
                    </Button>
                  )
                );
              },
            }
          : {})}
        {...(editable
          ? {
              accountActions: (slot: string, requirement: AccountRequirement) => (
                <ConnectNewAccount
                  requirement={requirement}
                  disabled={pending}
                  onConnect={(method) => setConnection({ slot, requirement, method })}
                />
              ),
            }
          : {})}
      />
      {chooser.error && <HostedFailure cause={chooser.error} />}
      {unused.prompt}
      <ConnectionModal
        open={connection !== undefined}
        busy={connecting}
        onClose={() => setConnection(undefined)}
      >
        {connection && (
          <AppConnectionDialogContent
            app={app}
            selection={profile?.accounts ?? emptySelection(app)}
            slot={connection.slot}
            requirement={connection.requirement}
            accounts={accounts}
            method={connection.method}
            redirectUri={redirectUri}
            profile={profile?.id}
            onSelected={onSelected}
            account={connection.account}
            onPendingChange={setConnecting}
            onSaved={() => setConnection(undefined)}
          />
        )}
      </ConnectionModal>
      {renaming && (
        <HostedAccountDialog id={renaming} dialog="edit" onClose={() => setRenaming(undefined)} />
      )}
    </>
  );
}

/** The last row of a requirement opens the connection form for its preferred sign-in method. */
function ConnectNewAccount({
  requirement,
  disabled,
  onConnect,
}: {
  readonly requirement: AccountRequirement;
  readonly disabled: boolean;
  readonly onConnect: (method: string) => void;
}) {
  const methods = Object.entries(requirement.definition.auth).sort(
    ([, a], [, b]) => Number(b.type === "oauth2") - Number(a.type === "oauth2"),
  );
  const preferred = methods[0];
  return (
    <>
      {methods
        .filter(([, auth]) => auth.type === "oauth2")
        .map(([method]) => (
          <PrefetchOAuthSetup key={method} provider={requirement.provider} method={method} />
        ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-10 w-full justify-start rounded-none px-3.5 text-[13px] text-muted-foreground hover:text-foreground"
        disabled={disabled || preferred === undefined}
        onClick={() => {
          if (preferred) onConnect(preferred[0]);
        }}
      >
        <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden />
        Connect new account
      </Button>
    </>
  );
}

function PrefetchOAuthSetup({
  provider,
  method,
}: {
  readonly provider: Provider["id"];
  readonly method: string;
}) {
  const { organization } = useOrganizationRoute();
  useAtomMount(oauthSetupAtom({ organization, provider, method }));
  return null;
}

type ConnectionDialog = {
  readonly provider: Provider;
  readonly redirectUri: string;
  readonly method: string;
};

/** Keep one provider snapshot and draft from the first dialog through submission. */
function AppConnectionDialogContent({
  app,
  selection,
  slot,
  requirement,
  accounts,
  method,
  redirectUri,
  profile,
  onSelected,
  account,
  onPendingChange,
  onSaved,
}: {
  readonly app: App;
  readonly account?: AccountSummary | undefined;
  readonly selection: SelectedAccounts;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly method: string;
  readonly redirectUri: string;
  readonly profile?: ProfileId | undefined;
  readonly onSelected: (id: ProfileId) => void;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaved: () => void;
}) {
  const [form] = useState<ConnectionDialog>(() => ({
    method,
    provider: { id: requirement.provider, definition: requirement.definition },
    redirectUri,
  }));
  const selected = selection[slot];
  const currentAccount =
    typeof selected === "string" ? accounts.find((account) => account.id === selected) : undefined;
  return (
    <>
      <ConnectionDialogHeader
        provider={form.provider}
        action={account ? "Reconnect" : "Connect"}
        notice={
          account
            ? `Apps using ${account.label} will use the new credentials.`
            : currentAccount
              ? `Replaces ${currentAccount.label} in this profile.`
              : undefined
        }
      />
      <AppConnectionFields
        app={app.id}
        account={account}
        accounts={selection}
        profile={profile}
        onSelected={onSelected}
        slot={slot}
        form={form}
        checks={requirement.health === true}
        onPendingChange={onPendingChange}
        onSaved={onSaved}
      />
    </>
  );
}

/** This form renders the page's cached provider and host metadata without a connection read. */
function AppConnectionFields({
  app,
  slot,
  form,
  onPendingChange,
  onSaved,
  accounts,
  profile,
  onSelected,
  checks,
  account,
}: {
  /** Set when replacing this account's credentials rather than adding an account. */
  readonly account?: AccountSummary | undefined;
  readonly accounts: SelectedAccounts;
  readonly profile?: ProfileId | undefined;
  readonly onSelected: (id: ProfileId) => void;
  /** The slot's provider defines a check, so entered credentials can be validated. */
  readonly checks: boolean;
  readonly app: App["id"];
  readonly slot: string;
  readonly form: ConnectionDialog;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaved: () => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const [atoms] = useState(() =>
    appConnectionAtoms({
      organization,
      app,
      requirement: slot,
      provider: form.provider.id,
      accounts,
      profile,
      account: account?.id,
    }),
  );
  useAtomMount(atoms.request);
  useAtomMount(atoms.profile);
  const submit = useAtomSet(atoms.submit, { mode: "promiseExit" });
  const start = useAtomSet(atoms.startOAuth, { mode: "promiseExit" });
  return (
    <HostedAccountForm<
      HostedOAuthSignIn & {
        readonly connection: AccountConnectionId;
        readonly profile: ProfileId;
      }
    >
      provider={form.provider}
      app={checks ? app : undefined}
      {...(account ? { account } : {})}
      redirectUri={form.redirectUri}
      initialMethod={form.method}
      submit={(input) =>
        submit(input).then((exit) =>
          Exit.map(exit, (saved) => {
            onSelected(saved.profile);
            return saved.account;
          }),
        )
      }
      start={(input) =>
        start(input).then((exit) =>
          Exit.map(exit, (result) => {
            if (result.status === "completed") onSelected(result.profile);
            return result;
          }),
        )
      }
      onPendingChange={onPendingChange}
      onSaved={onSaved}
      onAuthorized={(value) =>
        openAccountOAuth(
          {
            organization,
            organizationSlug,
            app,
            connection: value.connection,
            profile: value.profile,
            redirectUri: value.redirectUri,
            ...(account ? { reconnect: true } : {}),
            manualClient: value.manualClient,
          },
          value.authorizationUrl,
        )
      }
    />
  );
}
