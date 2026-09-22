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
import { providerDisplayUrl, type AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { ProviderIcon } from "@executor-js/ui/dashboard/common";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
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
      app={{ ...app, accounts: { ...app.accounts, ...profile?.accounts } }}
      accounts={accounts}
      onCreateProfile={canUse ? onCreateProfile : undefined}
      removeAccountAction={(slot, account, label) =>
        canUse &&
        profile !== undefined &&
        !Object.hasOwn(app.accounts, slot) && (
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
            accountActions: (slot: string, requirement: AccountRequirement) =>
              !Object.hasOwn(app.accounts, slot) && (
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
  if (app.activeDeployment === null || !canUse || Object.hasOwn(app.accounts, slot)) return null;
  const defaults = Object.fromEntries(
    Object.entries(app.requirements.accounts)
      .filter(([name, value]) => !Object.hasOwn(app.accounts, name) && value.cardinality === "many")
      .map(([name]) => [name, []]),
  );
  const selectedApp = { ...app, accounts: profile?.accounts ?? defaults };
  return (
    <>
      {Object.entries(requirement.definition.auth)
        .filter(([, auth]) => auth.type === "oauth2")
        .map(([method]) => (
          <PrefetchOAuthSetup key={method} provider={requirement.provider} method={method} />
        ))}
      <ConnectAppAccount
        app={selectedApp}
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
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly prepare: () => Exit.Exit<SavedAccountEdit<Profile, HostedError>, HostedError>;
  readonly connectLabel?: string | undefined;
  readonly redirectUri: string;
}) {
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<ConnectionDialog>();
  const methods = Object.entries(requirement.definition.auth).sort(
    ([, a], [, b]) => Number(b.type === "oauth2") - Number(a.type === "oauth2"),
  );
  const preferred = methods[0];
  const selected = app.accounts[slot];
  const inUse = typeof selected === "string" || (selected !== undefined && selected.length > 0);
  const begin = (method: string) => {
    const labels = new Set(
      accounts
        .filter((account) => account.provider === requirement.provider)
        .map((account) => account.label),
    );
    let label = "Default";
    for (let number = 2; labels.has(label); number++) label = `Default ${number}`;
    setDialog({
      method,
      label,
      provider: { id: requirement.provider, definition: requirement.definition },
      redirectUri,
    });
  };
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
        begin(preferred[0]);
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
  const picker = (
    <SavedAccountPicker<HostedError, Profile>
      app={app}
      slot={slot}
      requirement={requirement}
      accounts={accounts}
      prepare={prepare}
      Failure={HostedFailure}
      connectAction={buttons}
      trigger={trigger}
    />
  );
  const currentAccount =
    typeof selected === "string" ? accounts.find((account) => account.id === selected) : undefined;
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
      <Dialog
        open={dialog !== undefined}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setDialog(undefined);
          }
        }}
      >
        <DialogContent className="max-h-[85dvh] gap-5 overflow-y-auto sm:max-w-[560px]">
          <div className="flex items-center gap-3 pr-7">
            <ProviderIcon
              name={requirement.definition.name}
              url={providerDisplayUrl(requirement.definition)}
            />
            <div className="min-w-0">
              <DialogTitle className="text-base">Connect {requirement.definition.name}</DialogTitle>
              <DialogDescription className={currentAccount ? "mt-1 text-xs" : "sr-only"}>
                {currentAccount
                  ? `Replaces ${currentAccount.label} in this profile.`
                  : `Connect an account for this profile of ${app.name}.`}
              </DialogDescription>
            </div>
          </div>
          {dialog && (
            <AppConnectionFields
              app={app.id}
              accounts={app.accounts}
              profile={profile}
              onSelected={onSelected}
              slot={slot}
              form={dialog}
              onPendingChange={setPending}
              onSaved={() => setDialog(undefined)}
            />
          )}
        </DialogContent>
      </Dialog>
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
