import { useContext, useState } from "react";
import { RegistryContext, useAtomSet, useAtomMount } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { Effect, Option } from "effect";
import { useQuery } from "@executor-js/ui/dashboard/context";
import { appAccessAtom } from "../../contracts/resource-access.ts";
import type { Provider, AccountRequirement, AccountScope, App } from "@executor-js/sdk";
import {
  AppAccounts as SharedAccounts,
  LinkedAccountMenu,
  useUnusedAccountPrompt,
  type LinkEditing,
  type ScopeAccounts,
} from "@executor-js/ui/dashboard/app-accounts";
import type { RequirementLink } from "@executor-js/ui/contracts/app-accounts";
import { DropdownMenuItem } from "@executor-js/ui/components/dropdown-menu";
import type { AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { Button } from "@executor-js/ui/components/button";
import { ConnectionDialogHeader, ConnectionModal } from "./connection-dialog.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { appConnectionAtoms, oauthSetupAtom } from "../../contracts/apps.ts";
import { HostedAccountForm, openAccountOAuth } from "./connect-account.tsx";
import type { HostedOAuthSignIn } from "@executor-js/hosted-server";
import type { AccountConnectionId } from "@executor-js/sdk";
import {
  linkAccountAtom,
  requirementChoicesAtom,
  unlinkAccountAtom,
} from "../../contracts/app-accounts.ts";
import {
  accountUsageAtom,
  checkAppAccountAtom,
  disconnectAccountAtom,
} from "../../contracts/accounts.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { HostedAccountDialog } from "./account-actions.tsx";

/** A requirement's sign-in methods, OAuth first: connecting a new account starts with the first. */
const methodsOf = (requirement: AccountRequirement) =>
  Object.entries(requirement.definition.auth).sort(
    ([, a], [, b]) => Number(b.type === "oauth2") - Number(a.type === "oauth2"),
  );

/**
 * The app's accounts in two sections. App accounts are linked for everyone: people who can edit
 * the app choose them, link another account they can use, or connect a new one; everyone else sees
 * them greyed out, without their upstream identity. Your accounts are the caller's own links. The
 * host still authorizes every link and connection.
 */
export function AppAccounts({
  app,
  appLinks,
  userLinks,
  canManage,
  accounts,
  redirectUri,
}: {
  readonly app: App;
  /** The app links, oldest first per requirement. */
  readonly appLinks: readonly RequirementLink<AccountSummary>[];
  /** The caller's user links, oldest first per requirement. */
  readonly userLinks: readonly RequirementLink<AccountSummary>[];
  /** Whether the caller can edit the app, and so change its app links. */
  readonly canManage: boolean;
  /** Every account the caller can use in this organization. */
  readonly accounts: readonly AccountSummary[];
  readonly redirectUri: string;
}) {
  const { organization } = useOrganizationRoute();
  const { data } = useQuery(appAccessAtom({ organization, app: app.id }));
  const canUse = Option.isSome(data) && data.value.canUse;
  const deployed = app.activeDeployment !== null;
  const registry = useContext(RegistryContext);
  const revalidate = (account: AccountSummary["id"]) => {
    const check = checkAppAccountAtom({ organization, app: app.id, account });
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
    readonly scope: AccountScope;
    readonly slot: string;
    readonly requirement: AccountRequirement;
    readonly method: string;
    /** Set when replacing this account's credentials rather than adding an account. */
    readonly account?: AccountSummary | undefined;
  }>();
  const [renaming, setRenaming] = useState<AccountSummary["id"]>();
  const [connecting, setConnecting] = useState(false);
  // Reconnecting through the app shows the hosts this app's declaration grants. Replacing an
  // account's credentials needs use of the account.
  const usable = (account: AccountSummary) => accounts.some((item) => item.id === account.id);
  const reconnect = (scope: AccountScope, slot: string, account: AccountSummary) => {
    const requirement = app.requirements.accounts[slot];
    if (requirement !== undefined)
      setConnection({ scope, slot, requirement, method: account.method, account });
  };
  const target = (scope: AccountScope) => ({
    organization,
    app: app.id,
    deployment: app.activeDeployment,
    scope,
  });
  const editing = (scope: AccountScope): LinkEditing<HostedError> => ({
    choices: (slot) =>
      requirementChoicesAtom({ organization, app: app.id, scope, requirement: slot }),
    link: (slot, account) => linkAccountAtom({ ...target(scope), requirement: slot, account }),
    unlink: (slot, account) => unlinkAccountAtom({ ...target(scope), requirement: slot, account }),
    connect: (slot, requirement) => {
      const [preferred] = methodsOf(requirement);
      if (preferred !== undefined)
        setConnection({ scope, slot, requirement, method: preferred[0] });
    },
    connecting,
    onUnlinked: (account) => void unused.check(account),
  });
  const scopeAccounts = (
    scope: AccountScope,
    links: readonly RequirementLink<AccountSummary>[],
    editable: boolean,
    readOnly: string,
  ): ScopeAccounts<HostedError> =>
    editable
      ? {
          links,
          edit: editing(scope),
          revalidate,
          accountMenu: (account, slot, requirement, linked) =>
            linked && (
              <LinkedAccountMenu
                label={account.label || "Unnamed account"}
                unlink={unlinkAccountAtom({
                  ...target(scope),
                  requirement: slot,
                  account: account.id,
                })}
                Failure={HostedFailure}
                onUnlinked={() => void unused.check(account.id)}
              >
                {usable(account) && (
                  <DropdownMenuItem onSelect={() => setRenaming(account.id)}>
                    Edit details
                  </DropdownMenuItem>
                )}
                {usable(account) && (
                  <DropdownMenuItem
                    disabled={connecting}
                    onSelect={() => reconnect(scope, slot, account)}
                  >
                    {requirement.definition.auth[account.method]?.type === "oauth2"
                      ? "Reconnect"
                      : "Update credentials"}
                  </DropdownMenuItem>
                )}
              </LinkedAccountMenu>
            ),
          reconnectAction: (account, slot) =>
            usable(account) && (
              <Button
                variant="outline"
                size="sm"
                disabled={connecting}
                onClick={() => reconnect(scope, slot, account)}
              >
                Reconnect
              </Button>
            ),
        }
      : { links, readOnly };
  const notDeployed = "Deploy this app to link accounts.";
  return (
    <>
      {Object.values(app.requirements.accounts).flatMap((requirement) =>
        deployed && (requirement.scope === "app" ? canManage : canUse)
          ? methodsOf(requirement)
              .filter(([, auth]) => auth.type === "oauth2")
              .map(([method]) => (
                <PrefetchOAuthSetup
                  key={`${requirement.provider}:${method}`}
                  provider={requirement.provider}
                  method={method}
                />
              ))
          : [],
      )}
      <SharedAccounts
        app={app}
        accounts={accounts}
        Failure={HostedFailure}
        appAccounts={scopeAccounts(
          "app",
          appLinks,
          canManage && deployed,
          canManage ? notDeployed : "Only people who can edit this app can change these accounts.",
        )}
        yourAccounts={scopeAccounts("user", userLinks, canUse && deployed, notDeployed)}
      />
      {unused.prompt}
      <ConnectionModal
        open={connection !== undefined}
        busy={connecting}
        onClose={() => setConnection(undefined)}
      >
        {connection && (
          <AppConnectionDialogContent
            app={app}
            scope={connection.scope}
            slot={connection.slot}
            requirement={connection.requirement}
            method={connection.method}
            redirectUri={redirectUri}
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
  scope,
  slot,
  requirement,
  method,
  redirectUri,
  account,
  onPendingChange,
  onSaved,
}: {
  readonly app: App;
  /** Set when replacing this account's credentials rather than adding an account. */
  readonly account?: AccountSummary | undefined;
  readonly scope: AccountScope;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly method: string;
  readonly redirectUri: string;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaved: () => void;
}) {
  const [form] = useState<ConnectionDialog>(() => ({
    method,
    provider: { id: requirement.provider, definition: requirement.definition },
    redirectUri,
  }));
  return (
    <>
      <ConnectionDialogHeader
        provider={form.provider}
        action={account ? "Reconnect" : "Connect"}
        notice={account ? `Apps using ${account.label} will use the new credentials.` : undefined}
      />
      <AppConnectionFields
        app={app}
        account={account}
        scope={scope}
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
  app: current,
  scope,
  slot,
  form,
  onPendingChange,
  onSaved,
  checks,
  account,
}: {
  /** Set when replacing this account's credentials rather than adding an account. */
  readonly account?: AccountSummary | undefined;
  /** The slot's provider defines a check, so entered credentials can be validated. */
  readonly checks: boolean;
  readonly app: App;
  readonly scope: AccountScope;
  readonly slot: string;
  readonly form: ConnectionDialog;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaved: () => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const app = current.id;
  const [atoms] = useState(() =>
    appConnectionAtoms({
      organization,
      app,
      deployment: current.activeDeployment,
      scope,
      requirement: slot,
      provider: form.provider.id,
      account: account?.id,
    }),
  );
  useAtomMount(atoms.request);
  const submit = useAtomSet(atoms.submit, { mode: "promiseExit" });
  const start = useAtomSet(atoms.startOAuth, { mode: "promiseExit" });
  return (
    <HostedAccountForm<HostedOAuthSignIn & { readonly connection: AccountConnectionId }>
      provider={form.provider}
      app={checks ? app : undefined}
      {...(account ? { account } : {})}
      redirectUri={form.redirectUri}
      initialMethod={form.method}
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
            ...(account ? { reconnect: true } : {}),
            manualClient: value.manualClient,
          },
          value.authorizationUrl,
        )
      }
    />
  );
}
