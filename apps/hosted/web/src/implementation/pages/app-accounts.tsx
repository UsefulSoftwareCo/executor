import { useState } from "react";
import { useAtomSet, useAtomMount } from "@effect/atom-react";
import { Option, type Exit } from "effect";
import { useQuery } from "@executor-js/ui/dashboard/context";
import { appAccessAtom } from "../../contracts/resource-access.ts";
import type { Provider, AccountRequirement, App, SelectedAccounts } from "@executor-js/sdk";
import { AppAccounts as SharedAccounts } from "@executor-js/ui/dashboard/app-accounts";
import { AccountPicker } from "@executor-js/ui/dashboard/account-picker";
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
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { appConnectionAtoms, oauthSetupAtom } from "../../contracts/apps.ts";
import { HostedAccountForm, openAccountOAuth } from "./connect-account.tsx";
import type { HostedOAuthSignIn } from "@executor-js/hosted-server";
import type { AccountConnectionId } from "@executor-js/sdk";
import type { HostedError } from "../../contracts/errors.ts";

/** Account actions stay on the app; the host still authorizes every selection and connection. */
export function AppAccounts({
  app,
  accounts,
  redirectUri,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly redirectUri: string;
}) {
  const { organization } = useOrganizationRoute();
  const { data } = useQuery(appAccessAtom({ organization, app: app.id }));
  const canManage = Option.isSome(data) && data.value.canManage;
  return (
    <SharedAccounts
      app={app}
      accounts={accounts}
      {...(canManage
        ? {
            accountActions: (slot: string, requirement: AccountRequirement) => (
              <AppAccountActions
                key={slot}
                app={app}
                slot={slot}
                requirement={requirement}
                accounts={accounts}
                redirectUri={redirectUri}
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
}: {
  readonly app: App;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly connectLabel?: string;
  readonly redirectUri: string;
}) {
  const { organization } = useOrganizationRoute();
  const { data } = useQuery(appAccessAtom({ organization, app: app.id }));
  const canManage = Option.isSome(data) && data.value.canManage;
  const atoms = useDashboardAtoms();
  const select = useAtomSet(atoms.selectAccounts(app.id), { mode: "promiseExit" });
  if (app.activeDeployment === null || !canManage) return null;
  return (
    <>
      {Object.entries(requirement.definition.auth)
        .filter(([, auth]) => auth.type === "oauth2")
        .map(([method]) => (
          <PrefetchOAuthSetup key={method} provider={requirement.provider} method={method} />
        ))}
      <ConnectAppAccount
        app={app}
        slot={slot}
        requirement={requirement}
        accounts={accounts}
        save={select}
        connectLabel={connectLabel}
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
  save,
  connectLabel,
  redirectUri,
}: {
  readonly app: App;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly save: (accounts: SelectedAccounts) => Promise<Exit.Exit<App, HostedError>>;
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
  const buttons = (close?: () => void) => (
    <Button
      size="sm"
      aria-label={inUse ? "Connect another account" : `Connect ${requirement.definition.name}`}
      variant={inUse ? "outline" : "default"}
      disabled={!preferred || pending}
      onClick={() => {
        if (!preferred) return;
        close?.();
        begin(preferred[0]);
      }}
    >
      {inUse
        ? "Connect another account"
        : (connectLabel ?? `Connect ${requirement.definition.name}`)}
    </Button>
  );
  const picker = (
    <AccountPicker<HostedError>
      app={app}
      slot={slot}
      requirement={requirement}
      accounts={accounts}
      save={save}
      Failure={HostedFailure}
      connectAction={buttons}
    />
  );
  const currentAccount =
    typeof selected === "string" ? accounts.find((account) => account.id === selected) : undefined;
  return (
    <>
      {inUse || selected !== undefined ? (
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
                  ? `Replaces ${currentAccount.label} for this app.`
                  : `Connect an account for ${app.name}.`}
              </DialogDescription>
            </div>
          </div>
          {dialog && (
            <AppConnectionFields
              app={app.id}
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
}: {
  readonly app: App["id"];
  readonly slot: string;
  readonly form: ConnectionDialog;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaved: () => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const [atoms] = useState(() =>
    appConnectionAtoms({ organization, app, requirement: slot, provider: form.provider.id }),
  );
  useAtomMount(atoms.request);
  const submit = useAtomSet(atoms.submit, { mode: "promiseExit" });
  const start = useAtomSet(atoms.startOAuth, { mode: "promiseExit" });
  return (
    <HostedAccountForm<HostedOAuthSignIn & { readonly connection: AccountConnectionId }>
      provider={form.provider}
      redirectUri={form.redirectUri}
      initialMethod={form.method}
      initialLabel={form.label}
      submit={submit}
      start={start}
      onPendingChange={onPendingChange}
      onSaved={onSaved}
      onAuthorized={(value) =>
        openAccountOAuth(
          {
            organization,
            organizationSlug,
            app,
            connection: value.connection,
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
