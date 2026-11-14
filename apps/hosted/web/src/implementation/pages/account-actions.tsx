import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import type { AccountDetail, AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { useAtomSet } from "@effect/atom-react";
import type { AccountId } from "@executor-js/sdk";
import { useState, type ReactNode } from "react";
import {
  AccountActionsMenu,
  AccountDialog,
  DisconnectAccountForm,
  EditAccountForm,
} from "@executor-js/ui/dashboard/account-actions";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { AccountHealthPanel } from "@executor-js/ui/dashboard/account-health";
import { Button } from "@executor-js/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@executor-js/ui/components/dropdown-menu";
import {
  accountAtom,
  checkAccountAtom,
  disconnectAccountAtom,
  updateAccountAtom,
} from "../../contracts/accounts.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

/** The list page owns an open dialog, so it outlives the row if the account changes underneath it. */
export type AccountDialogKind = "edit" | "health" | "delete";

/**
 * Row actions replace the account page: name, health and deletion, in place. Credentials
 * are replaced from an app that uses the account, which knows the hosts they are sent to.
 */
export function HostedAccountActions({
  account,
  open,
}: {
  readonly account: AccountSummary;
  readonly open: (dialog: AccountDialogKind) => void;
}) {
  return (
    <AccountActionsMenu account={account}>
      <DropdownMenuItem onSelect={() => open("edit")}>Edit details</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => open("health")}>Check health</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => open("delete")}>
        Delete account
      </DropdownMenuItem>
    </AccountActionsMenu>
  );
}

const titles = {
  edit: "Edit account",
  health: "Account health",
  delete: "Delete account?",
} satisfies Record<AccountDialogKind, string>;

/** Editing, health and deletion load the account themselves and report it if it disappears. */
export function HostedAccountDialog({
  id,
  dialog,
  onClose,
}: {
  readonly id: AccountId;
  readonly dialog: AccountDialogKind;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const [busy, setBusy] = useState(false);
  return (
    <AccountDialog
      title={titles[dialog]}
      description={`${titles[dialog]} for this saved account.`}
      busy={busy}
      onClose={onClose}
    >
      <QueryView
        pending={<DetailSkeleton label="Loading account" />}
        query={accountAtom({ organization, account: id })}
        Failure={HostedFailure}
      >
        {(data) =>
          dialog === "edit" ? (
            <EditDialogBody data={data} onPendingChange={setBusy} onClose={onClose} />
          ) : dialog === "health" ? (
            <HealthDialogBody data={data} onClose={onClose} />
          ) : (
            <DeleteDialogBody data={data} onPendingChange={setBusy} onClose={onClose} />
          )
        }
      </QueryView>
    </AccountDialog>
  );
}

const cancelButton = (onClose: () => void): ReactNode => (
  <Button variant="ghost" onClick={onClose}>
    Cancel
  </Button>
);

function HealthDialogBody({
  data,
  onClose,
}: {
  readonly data: AccountDetail;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const check = useAtomSet(checkAccountAtom({ organization, account: data.account.id }), {
    mode: "promiseExit",
  });
  return (
    <AccountHealthPanel<HostedError>
      data={data}
      check={() => check()}
      Failure={HostedFailure}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    />
  );
}

function EditDialogBody({
  data,
  onPendingChange,
  onClose,
}: {
  readonly data: AccountDetail;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const update = useAtomSet(updateAccountAtom({ organization, account: data.account.id }), {
    mode: "promiseExit",
  });
  return (
    <EditAccountForm<HostedError>
      account={data.account}
      update={update}
      Failure={HostedFailure}
      onPendingChange={onPendingChange}
      onDone={onClose}
      cancel={cancelButton(onClose)}
    />
  );
}

function DeleteDialogBody({
  data,
  onPendingChange,
  onClose,
}: {
  readonly data: AccountDetail;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const disconnect = useAtomSet(disconnectAccountAtom({ organization, account: data.account.id }), {
    mode: "promiseExit",
  });
  return (
    <DisconnectAccountForm<HostedError>
      submitLabel="Delete account"
      impact={
        <p className="text-[12px] leading-[1.5] text-muted-foreground">
          These apps lose this account. Their other linked accounts stay linked.
        </p>
      }
      data={data}
      Failure={HostedFailure}
      disconnect={() => disconnect()}
      onPendingChange={onPendingChange}
      onDisconnected={onClose}
      cancel={cancelButton(onClose)}
    />
  );
}
