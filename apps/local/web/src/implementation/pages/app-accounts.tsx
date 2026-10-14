import { useContext, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { Effect } from "effect";
import {
  accountAtom,
  accountUsageAtom,
  checkAccountAtom,
  disconnectAccountAtom,
} from "../../contracts/accounts.ts";
import {
  linkAccountAtom,
  requirementChoicesAtom,
  unlinkAccountAtom,
} from "../../contracts/app-accounts.ts";
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
  LinkedAccountMenu,
  useUnusedAccountPrompt,
  type ScopeAccounts,
} from "@executor-js/ui/dashboard/app-accounts";
import type { RequirementLink } from "@executor-js/ui/contracts/app-accounts";
import type { AccountSummary } from "@executor-js/ui/contracts/dashboard";
import type { AccountId, AccountScope, App, AccountRequirement } from "@executor-js/sdk";
import type { DashboardError } from "../../contracts/errors.ts";

/**
 * The app's accounts in two sections: App accounts, linked for every call and the app's background
 * work, and Your accounts. Locally the owner changes both: choose a saved account, clear one from a
 * many() requirement, or connect a new account, which saves it and links it in one step. The
 * account stays saved when it is unlinked.
 */
export function AppAccounts({
  app,
  appLinks,
  userLinks,
  accounts,
}: {
  readonly app: App;
  /** The app links, oldest first per requirement, with their sign-in details. */
  readonly appLinks: readonly RequirementLink<AccountSummary>[];
  /** The user links, oldest first per requirement, with their sign-in details. */
  readonly userLinks: readonly RequirementLink<AccountSummary>[];
  /** Every saved account. */
  readonly accounts: readonly AccountSummary[];
}) {
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
    readonly scope: AccountScope;
    readonly slot: string;
    readonly requirement: AccountRequirement;
  }>();
  const [connecting, setConnecting] = useState(false);
  // Credentials are replaced here, where the app shows which hosts receive them.
  const [replacing, setReplacing] = useState<{
    readonly scope: AccountScope;
    readonly slot: string;
    readonly requirement: AccountRequirement;
    readonly account: AccountSummary;
  }>();
  const [replacingBusy, setReplacingBusy] = useState(false);
  const [renaming, setRenaming] = useState<AccountId>();
  const replacingOAuth =
    replacing !== undefined &&
    replacing.requirement.definition.auth[replacing.account.method]?.type === "oauth2";
  const target = (scope: AccountScope) => ({
    app: app.id,
    deployment: app.activeDeployment,
    scope,
  });
  const scopeAccounts = (
    scope: AccountScope,
    links: readonly RequirementLink<AccountSummary>[],
  ): ScopeAccounts<DashboardError> => ({
    links,
    revalidate,
    edit: {
      choices: (slot) => requirementChoicesAtom({ app: app.id, scope, requirement: slot }),
      link: (slot, account) => linkAccountAtom({ ...target(scope), requirement: slot, account }),
      unlink: (slot, account) =>
        unlinkAccountAtom({ ...target(scope), requirement: slot, account }),
      connect: (slot, requirement) => setConnection({ scope, slot, requirement }),
      connecting,
      onUnlinked: (account) => void unused.check(account),
    },
    accountMenu: (account, slot, requirement, linked) =>
      linked && (
        <LinkedAccountMenu
          label={account.label || "Unnamed account"}
          unlink={unlinkAccountAtom({ ...target(scope), requirement: slot, account: account.id })}
          Failure={Failure}
          onUnlinked={() => void unused.check(account.id)}
        >
          <DropdownMenuItem onSelect={() => setRenaming(account.id)}>Edit details</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setReplacing({ scope, slot, requirement, account })}>
            {requirement.definition.auth[account.method]?.type === "oauth2"
              ? "Reconnect"
              : "Update credentials"}
          </DropdownMenuItem>
        </LinkedAccountMenu>
      ),
    reconnectAction: (account, slot, requirement) => (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setReplacing({ scope, slot, requirement, account })}
      >
        Reconnect
      </Button>
    ),
  });
  return (
    <>
      <SharedAccounts
        app={app}
        accounts={accounts}
        Failure={Failure}
        appAccounts={scopeAccounts("app", appLinks)}
        yourAccounts={scopeAccounts("user", userLinks)}
      />
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
              deployment={app.activeDeployment}
              scope={connection.scope}
              requirement={connection.slot}
              provider={{
                id: connection.requirement.provider,
                definition: connection.requirement.definition,
              }}
              checkWith={connection.requirement.health === true}
              onPendingChange={setConnecting}
              onSaved={() => setConnection(undefined)}
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
          {replacing && (
            <QueryView
              key={replacing.account.id}
              query={accountAtom(replacing.account.id)}
              Failure={Failure}
              pending={<LoadingRows />}
            >
              {(detail) =>
                detail.canManage ? (
                  <ReplaceCredentials
                    data={detail}
                    app={app}
                    scope={replacing.scope}
                    slot={replacing.slot}
                    requirement={replacing.requirement}
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
