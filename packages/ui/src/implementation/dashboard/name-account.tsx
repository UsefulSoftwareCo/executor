import type { Account, AccountHealth, AppId, Provider } from "@executor-js/sdk";
import { Exit, type Cause } from "effect";
import { useState, type ComponentType, type ReactNode } from "react";
import { providerDisplayUrl, type FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog.tsx";
import { Input } from "../components/input.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import {
  AccountDescriptionField,
  accountDescriptionValue,
  type AccountMetadataUpdate,
} from "./account-description.tsx";
import { ProviderIcon } from "./common.tsx";

export interface AccountToName {
  readonly account: Account["id"];
  readonly app?: AppId;
  readonly saved?: { readonly account: Pick<Account, "label">; readonly provider: Provider };
}

export const suggestedAccountName = (health: AccountHealth | undefined) =>
  health?.info?.displayName ?? health?.info?.username ?? health?.info?.email;

export function NameAccountModal({
  handoff,
  busy,
  onClose,
  children,
}: {
  readonly handoff: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        {...(handoff ? { "data-name-account-handoff": "" } : {})}
        {...(handoff ? { overlayClassName: "name-account-handoff" } : {})}
        className="max-h-[85dvh] gap-5 overflow-x-hidden overflow-y-auto sm:max-w-[560px]"
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function NameAccountHeader({ provider }: { readonly provider?: Provider | undefined }) {
  return (
    <div className="flex items-center gap-3 pr-7">
      {provider && (
        <ProviderIcon
          name={provider.definition.name}
          url={providerDisplayUrl(provider.definition)}
        />
      )}
      <DialogTitle className="min-w-0 text-base">Name this account</DialogTitle>
      <DialogDescription className="sr-only">
        {provider
          ? `Name the ${provider.definition.name} account you connected.`
          : "Loading the connected account."}
      </DialogDescription>
    </div>
  );
}

export function NameAccountForm<E>({
  account,
  providerName,
  update,
  Failure,
  identity,
  onPendingChange,
  onDone,
}: {
  readonly account: Pick<Account, "label">;
  readonly providerName: string;
  readonly identity?:
    | { readonly resolving: true }
    | { readonly resolving: false; readonly name: string | undefined };
  readonly update: (changes: AccountMetadataUpdate) => Promise<Exit.Exit<unknown, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onDone: () => void;
}) {
  const [draft, setLabel] = useState<string>();
  const resolving = identity?.resolving === true;
  const label =
    draft ??
    (identity?.resolving === false && identity.name !== undefined
      ? identity.name.slice(0, 120)
      : account.label);
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const updatePending = (value: boolean) => {
    setPending(value);
    onPendingChange?.(value);
  };
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        const next = label.trim();
        if (pending || !next) return;
        const described = accountDescriptionValue(description);
        const changes = {
          ...(next === account.label ? {} : { label: next }),
          ...(described === null ? {} : { description: described }),
        };
        if (Object.keys(changes).length === 0) return onDone();
        updatePending(true);
        setError(undefined);
        const exit = await update(changes);
        updatePending(false);
        if (Exit.isFailure(exit)) return setError(exit.cause);
        onDone();
      }}
    >
      <p className="text-xs leading-relaxed text-muted-foreground">
        {providerName} is connected. Choose a name you’ll recognize.
      </p>
      <label className="flex flex-col gap-2 text-[13px] font-medium">
        Account name
        {resolving ? (
          <Skeleton
            className="h-9 w-full max-[740px]:h-11"
            aria-label="Reading the account's name"
          />
        ) : (
          <Input
            autoFocus
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            disabled={pending}
            maxLength={120}
          />
        )}
      </label>
      <AccountDescriptionField
        value={description}
        onChange={setDescription}
        disabled={pending || resolving}
      />
      {error && <Failure cause={error} />}
      <Button
        type="submit"
        className="w-full"
        loading={pending}
        disabled={resolving || !label.trim()}
      >
        Save name
      </Button>
    </form>
  );
}
