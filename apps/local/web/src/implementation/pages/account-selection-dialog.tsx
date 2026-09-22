import { QueryView } from "@executor-js/ui/dashboard/context";
import { accountSelectionAtom, profilesAtom } from "../../contracts/profiles.ts";
import { useAtomSet } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import { Exit } from "effect";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@executor-js/ui/components/dialog";
import { AccountSelectionForm } from "@executor-js/ui/dashboard/account-selection";
import type {
  App,
  AccountId,
  AccountRequirement,
  SelectedAccounts,
  Profile,
  ProfileId,
} from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import type { SetupSearch } from "../../contracts/navigation.ts";
import { Failure, LoadingRows } from "../components/common.tsx";
import { AccountForm } from "./add-account.tsx";

/** Account selection and connection stay over the Accounts tab. */
export function AccountSelectionDialog({
  app,
  data,
  profile,
  selected,
  slot,
  trigger,
  defaultOpen = false,
  onClose,
  onSelected,
}: {
  readonly app: App;
  readonly data: DashboardOverview;
  readonly trigger?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly onClose?: () => void;
  readonly onSelected?: (id: ProfileId) => void;
} & SetupSearch) {
  const [open, setOpen] = useState(defaultOpen);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) setOpen(true);
        else close();
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[480px]">
        <DialogTitle>Choose accounts</DialogTitle>
        <DialogDescription>
          Choose the accounts {app.name} uses. You can use saved accounts or connect a new one.
        </DialogDescription>
        <QueryView
          query={profilesAtom({ app: app.id })}
          Failure={Failure}
          pending={<LoadingRows />}
        >
          {(entries) =>
            profile !== undefined && !entries.some((item) => item.id === profile) ? (
              <p role="alert">This profile is unavailable.</p>
            ) : (
              <SelectionForm
                app={app}
                data={data}
                initial={entries.find((item) => item.id === profile)}
                selected={selected}
                slot={slot}
                onCancel={close}
                onSaved={(saved) => {
                  onSelected?.(saved.id);
                  close();
                }}
              />
            )
          }
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}
function SelectionForm({
  app,
  data,
  selected,
  slot,
  initial: saved,
  onSaved,
  onCancel,
}: {
  readonly app: App;
  readonly data: DashboardOverview;
  readonly initial: Profile | undefined;
  readonly onSaved: (saved: Profile) => void;
  readonly onCancel: () => void;
} & SetupSearch) {
  const [connection, setConnection] = useState<{
    readonly slot: string;
    readonly requirement: AccountRequirement;
  }>();
  const [candidate, setCandidate] = useState<{
    readonly selected: AccountId;
    readonly slot: string;
  }>();
  const [connecting, setConnecting] = useState(false);
  const selectedAccount = candidate?.selected ?? selected;
  const selectedSlot = candidate?.slot ?? slot;
  const [working, setWorking] = useState(saved),
    [request] = useState(() => crypto.randomUUID());
  const mutation = accountSelectionAtom({
    app: app.id,
    target:
      working === undefined
        ? { kind: "new", request }
        : { kind: "saved", id: working.id, revision: working.revision },
  });
  const save = useAtomSet(mutation, { mode: "promiseExit" });
  const requirements = Object.fromEntries(
    Object.entries(app.requirements.accounts).filter(
      ([slot]) => !Object.hasOwn(app.accounts, slot),
    ),
  );
  let initial: SelectedAccounts =
    working?.accounts ??
    Object.fromEntries(
      Object.entries(requirements)
        .filter(([, requirement]) => requirement.cardinality === "many")
        .map(([slot]) => [slot, []]),
    );
  if (selectedAccount && selectedSlot && app.requirements.accounts[selectedSlot]) {
    const requirement = app.requirements.accounts[selectedSlot];
    const previous = initial[selectedSlot];
    initial = {
      ...initial,
      [selectedSlot]:
        requirement.cardinality === "many"
          ? [...new Set([...(Array.isArray(previous) ? previous : []), selectedAccount])]
          : selectedAccount,
    };
  }
  return (
    <>
      <AccountSelectionForm
        key={selectedAccount ?? "selection"}
        mutation={mutation}
        Failure={Failure}
        app={{
          ...app,
          accounts: initial,
          requirements: { ...app.requirements, accounts: requirements },
        }}
        available={data.accounts}
        initialAccounts={initial}
        addedAccounts={saved?.accounts}
        connectAction={(slot, requirement, accounts) => (
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              const result = await save({ app: app.id, accounts });
              if (Exit.isFailure(result)) return;
              setWorking(result.value);
              setConnection({ slot, requirement });
            }}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} />
            Connect account
          </Button>
        )}
        finishAction={
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        }
        onSaved={onSaved}
      />
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
            <AccountForm
              provider={{
                id: connection.requirement.provider,
                definition: connection.requirement.definition,
              }}
              returnTo={{ app: app.id, slot: connection.slot, profile: working?.id }}
              onPendingChange={setConnecting}
              onSaved={(account) => {
                setCandidate({ selected: account.id, slot: connection.slot });
                setConnection(undefined);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
