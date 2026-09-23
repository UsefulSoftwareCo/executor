import { useContext, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { RegistryContext, useAtomSet, useAtomMount } from "@effect/atom-react";
import { Option, Exit, Effect } from "effect";
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
  AccountSelectionTrigger,
  RemoveAccountBinding,
} from "@executor-js/ui/dashboard/app-accounts";
import {
  SavedAccountPicker,
  type SavedAccountEdit,
} from "@executor-js/ui/dashboard/saved-account-picker";
import type { AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { Button } from "@executor-js/ui/components/button";
import { ConnectionDialogHeader, ConnectionModal } from "./connection-dialog.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { appConnectionAtoms, oauthSetupAtom } from "../../contracts/apps.ts";
import { HostedAccountForm, openAccountOAuth } from "./connect-account.tsx";
import type { HostedOAuthSignIn } from "@executor-js/hosted-server";
import type { AccountConnectionId } from "@executor-js/sdk";
import type { HostedError } from "../../contracts/errors.ts";
import { accountSelectionAtom, profilesAtom, profileMutations } from "../../contracts/profiles.ts";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { ProfileNotFound } from "@executor-js/sdk";

/** Account actions stay on the app; the host still authorizes every selection and connection. */
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
  return (
    <SharedAccounts
      app={app}
      selection={profile?.accounts ?? {}}
      accounts={accounts}
      onCreateProfile={canUse ? onCreateProfile : undefined}
      removeAccountAction={(slot, account, label) =>
        canUse &&
        profile !== undefined && (
          <RemoveAccountBinding
            profile={profile}
            slot={slot}
            account={account}
            label={label}
            update={profileMutations({ organization, app: app.id, profile: profile.id }).update}
            Failure={HostedFailure}
          />
        )
      }
      {...(canUse
        ? {
            accountActions: (slot: string, requirement: AccountRequirement) => (
              <AppAccountActions
                key={slot}
                app={app}
                slot={slot}
                requirement={requirement}
                accounts={accounts}
                redirectUri={redirectUri}
                profile={profile}
                onSelected={onSelected}
                trigger={
                  <AccountSelectionTrigger
                    requirement={requirement}
                    selection={profile?.accounts[slot]}
                  />
                }
              />
            ),
          }
        : {})}
    />
  );
}

/** Reuse authorized connection and selection controls on the overview and Accounts tab. */
export function AppAccountActions({
  app,
  slot,
  requirement,
  accounts,
  connectLabel,
  redirectUri,
  profile,
  onSelected,
  trigger,
}: {
  readonly trigger?: ReactNode;
  readonly profile?: Profile | undefined;
  readonly onSelected: (id: ProfileId) => void;
  readonly app: App;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly connectLabel?: string;
  readonly redirectUri: string;
}) {
  const { organization } = useOrganizationRoute();
  const { data } = useQuery(appAccessAtom({ organization, app: app.id }));
  const canUse = Option.isSome(data) && data.value.canUse;
  const registry = useContext(RegistryContext);
  if (app.activeDeployment === null || !canUse) return null;
  const defaults = Object.fromEntries(
    Object.entries(app.requirements.accounts)
      .filter(([, value]) => value.cardinality === "many")
      .map(([name]) => [name, []]),
  );
  const selection = profile?.accounts ?? defaults;
  return (
    <>
      {Object.entries(requirement.definition.auth)
        .filter(([, auth]) => auth.type === "oauth2")
        .map(([method]) => (
          <PrefetchOAuthSetup key={method} provider={requirement.provider} method={method} />
        ))}
      <ConnectAppAccount
        app={app}
        selection={selection}
        profile={profile?.id}
        onSelected={onSelected}
        slot={slot}
        requirement={requirement}
        accounts={accounts}
        prepare={() => {
          const current = AsyncResult.value(
            registry.get(profilesAtom({ organization, app: app.id })),
          );
          const saved = Option.isSome(current)
            ? current.value.find((item) => item.id === profile?.id)
            : undefined;
          if (profile !== undefined && saved === undefined)
            return Exit.fail(new ProfileNotFound({ app: app.id, profile: profile.id }));
          const target =
            saved === undefined
              ? { kind: "new" as const, request: crypto.randomUUID() }
              : { kind: "saved" as const, id: saved.id, revision: saved.revision };
          const mutation = accountSelectionAtom({ organization, app: app.id, target });
          return Exit.succeed({
            accounts: saved?.accounts ?? defaults,
            save: (accounts: SelectedAccounts) => {
              registry.set(mutation, { app: app.id, accounts });
              return Effect.runPromiseExit(
                AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true }),
              ).then((exit) =>
                Exit.map(exit, (result) => {
                  onSelected(result.id);
                  return result;
                }),
              );
            },
          });
        }}
        connectLabel={connectLabel}
        trigger={trigger}
        redirectUri={redirectUri}
      />
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
  readonly label: string;
};

function ConnectAppAccount({
  app,
  selection,
  slot,
  requirement,
  accounts,
  prepare,
  connectLabel,
  redirectUri,
  profile,
  onSelected,
  trigger,
}: {
  readonly trigger?: ReactNode;
  readonly profile?: ProfileId | undefined;
  readonly onSelected: (id: ProfileId) => void;
  readonly app: App;
  readonly selection: SelectedAccounts;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly prepare: () => Exit.Exit<SavedAccountEdit<Profile, HostedError>, HostedError>;
  readonly connectLabel?: string | undefined;
  readonly redirectUri: string;
}) {
  const [pending, setPending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const methods = Object.entries(requirement.definition.auth).sort(
    ([, a], [, b]) => Number(b.type === "oauth2") - Number(a.type === "oauth2"),
  );
  const preferred = methods[0];
  const selected = selection[slot];
  const inUse = typeof selected === "string" || (selected !== undefined && selected.length > 0);
  const buttons = (close?: () => void, appearance: "button" | "row" = "button") => (
    <Button
      size="sm"
      aria-label={
        appearance === "row" ? "Connect new account" : `Connect ${requirement.definition.name}`
      }
      variant={appearance === "row" ? "ghost" : "default"}
      className={
        appearance === "row"
          ? "min-h-12 w-full justify-start gap-3 px-3 text-sm font-normal text-muted-foreground hover:text-foreground"
          : undefined
      }
      disabled={!preferred || pending}
      onClick={() => {
        if (!preferred) return;
        close?.();
        setConnecting(true);
      }}
    >
      {appearance === "row" ? (
        <>
          <HugeiconsIcon icon={Add01Icon} size={16} aria-hidden />
          Connect new account
        </>
      ) : (
        (connectLabel ?? `Connect ${requirement.definition.name}`)
      )}
    </Button>
  );
  const form = (close: () => void) =>
    preferred && (
      <AppConnectionDialogContent
        app={app}
        selection={selection}
        slot={slot}
        requirement={requirement}
        accounts={accounts}
        method={preferred[0]}
        redirectUri={redirectUri}
        profile={profile}
        onSelected={onSelected}
        onPendingChange={setPending}
        onSaved={close}
      />
    );
  const picker = (
    <SavedAccountPicker<HostedError, Profile>
      selectedAccounts={selection}
      slot={slot}
      requirement={requirement}
      accounts={accounts}
      prepare={prepare}
      Failure={HostedFailure}
      connectAction={buttons}
      connectForm={preferred ? form : undefined}
      busy={pending}
      trigger={trigger}
    />
  );
  return (
    <>
      {trigger !== undefined || inUse || selected !== undefined ? (
        picker
      ) : (
        <>
          {buttons()}
          {(accounts.some((account) => account.provider === requirement.provider) ||
            requirement.cardinality === "many") &&
            picker}
        </>
      )}
      <ConnectionModal open={connecting} busy={pending} onClose={() => setConnecting(false)}>
        {connecting && form(() => setConnecting(false))}
      </ConnectionModal>
    </>
  );
}

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
  onPendingChange,
  onSaved,
}: {
  readonly app: App;
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
  const [form] = useState<ConnectionDialog>(() => {
    const labels = new Set(
      accounts
        .filter((account) => account.provider === requirement.provider)
        .map((account) => account.label),
    );
    let label = "Default";
    for (let number = 2; labels.has(label); number++) label = `Default ${number}`;
    return {
      method,
      label,
      provider: { id: requirement.provider, definition: requirement.definition },
      redirectUri,
    };
  });
  const selected = selection[slot];
  const currentAccount =
    typeof selected === "string" ? accounts.find((account) => account.id === selected) : undefined;
  return (
    <>
      <ConnectionDialogHeader
        provider={form.provider}
        action="Connect"
        notice={currentAccount ? `Replaces ${currentAccount.label} in this profile.` : undefined}
      />
      <AppConnectionFields
        app={app.id}
        accounts={selection}
        profile={profile}
        onSelected={onSelected}
        slot={slot}
        form={form}
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
}: {
  readonly accounts: SelectedAccounts;
  readonly profile?: ProfileId | undefined;
  readonly onSelected: (id: ProfileId) => void;
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
      redirectUri={form.redirectUri}
      initialMethod={form.method}
      initialLabel={form.label}
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
            label: value.label,
            manualClient: value.manualClient,
          },
          value.authorizationUrl,
        )
      }
    />
  );
}
