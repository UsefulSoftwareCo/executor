import { EmptyState } from "./empty-state.tsx";
import type { Account, App } from "@executor-js/sdk";
import { Exit, type Cause } from "effect";
import { useState, type ComponentType, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type { AccountDetail, AccountSummary, FailureProps } from "../../contracts/dashboard.ts";
import { providerDisplayUrl } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.tsx";
import {
  AccountDescriptionField,
  accountDescriptionValue,
  type AccountMetadataUpdate,
} from "./account-description.tsx";
import { ProviderIcon } from "./common.tsx";
import { useDashboard } from "./context.tsx";
import { useProductBrand } from "../hooks/product-brand.ts";
import { appDisplayName } from "../../contracts/product-brand.ts";

/** Account management lives on its list row; products supply the menu items they support. */
export function AccountActionsMenu({
  account,
  children,
}: {
  readonly account: Pick<AccountSummary, "label">;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Manage ${account.label || "unnamed account"}`}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One modal shell for every row action, titled for the action and identified by the account. */
export function AccountDialog({
  title,
  description,
  busy = false,
  onClose,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly busy?: boolean;
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
      <DialogContent className="max-h-[85dvh] gap-5 overflow-x-hidden overflow-y-auto sm:max-w-[560px]">
        <DialogTitle className="pr-7 text-base">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The account a dialog acts on, shown the same way in every action. */
export function AccountDialogIdentity({ data }: { readonly data: AccountDetail }) {
  const { account, provider } = data;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <ProviderIcon name={provider.definition.name} url={providerDisplayUrl(provider.definition)} />
      <div className="min-w-0 wrap-anywhere">
        <div className="text-sm font-medium">{account.label || "Unnamed account"}</div>
        <div className="text-xs text-muted-foreground">
          {provider.definition.name} ·{" "}
          {provider.definition.auth[account.method]?.type === "oauth2" ? "OAuth" : account.method}
        </div>
      </div>
    </div>
  );
}

/** Edit a saved account's name and agent-visible description; the product owns the mutation. */
export function EditAccountForm<E>({
  account,
  update,
  Failure,
  disabledReason,
  onPendingChange,
  onDone,
  cancel,
}: {
  readonly account: Pick<Account, "label" | "description">;
  readonly update: (changes: AccountMetadataUpdate) => Promise<Exit.Exit<unknown, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly disabledReason?: string | undefined;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onDone: () => void;
  readonly cancel: ReactNode;
}) {
  const [label, setLabel] = useState(account.label);
  const [description, setDescription] = useState(account.description ?? "");
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
        const nextLabel = label.trim();
        if (disabledReason !== undefined || pending || !nextLabel) return;
        const nextDescription = accountDescriptionValue(description);
        const changes = {
          ...(nextLabel === account.label ? {} : { label: nextLabel }),
          ...(nextDescription === account.description ? {} : { description: nextDescription }),
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
      <label className="flex flex-col gap-2 text-[13px] font-medium">
        Account name
        <Input
          autoFocus
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
          pattern=".*\S.*"
          maxLength={120}
          disabled={pending}
          disabledReason={disabledReason}
        />
      </label>
      <AccountDescriptionField
        value={description}
        onChange={setDescription}
        disabled={pending}
        disabledReason={disabledReason}
      />
      {error && <Failure cause={error} />}
      <div className="flex items-center gap-5 text-[13px] [&_a]:text-muted-foreground">
        <Button type="submit" loading={pending} disabledReason={disabledReason}>
          Save
        </Button>
        {cancel}
      </div>
    </form>
  );
}

/** Show affected apps before deleting credentials, using the host's typed mutation. */
export function DisconnectAccountForm<E>({
  data,
  disconnect,
  onDisconnected,
  onPendingChange,
  cancel,
  Failure,
  disabledReason,
  submitLabel = "Disconnect account",
  impact,
}: {
  readonly submitLabel?: string;
  readonly impact?: ReactNode;
  readonly data: AccountDetail;
  readonly disconnect: () => Promise<Exit.Exit<unknown, E>>;
  readonly onDisconnected: () => void;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly cancel: ReactNode;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly disabledReason?: string | undefined;
}) {
  const brand = useProductBrand();
  const { provider, apps } = data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  return (
    <div className="flex flex-col gap-5">
      <AccountDialogIdentity data={data} />
      <p className="text-sm text-muted-foreground">
        {data.revocation === "automatic"
          ? `This deletes the saved credentials from ${brand.name} and asks ${provider.definition.name} to revoke its access.`
          : `This deletes the saved credentials from ${brand.name} but does not revoke access at ${provider.definition.name}. To end access, revoke it there too.`}{" "}
        {apps.length === 0 && "No apps use this account."}
      </p>
      {apps.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium">
            Used by {apps.length} {apps.length === 1 ? "app" : "apps"}
          </h3>
          <div className="rounded-md border px-3">
            <AccountApps apps={apps} />
          </div>
          {impact ?? (
            <p className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
              These apps will need an account selected before they can run.
            </p>
          )}
        </section>
      )}
      {error && <Failure cause={error} />}
      <div className="flex items-center gap-5 text-[13px] [&_a]:text-muted-foreground">
        <Button
          variant="destructive"
          loading={pending}
          disabledReason={disabledReason}
          onClick={async () => {
            if (pending) return;
            setPending(true);
            onPendingChange?.(true);
            setError(undefined);
            const exit = await disconnect();
            setPending(false);
            onPendingChange?.(false);
            if (Exit.isFailure(exit)) {
              setError(exit.cause);
              return;
            }
            onDisconnected();
          }}
        >
          {submitLabel}
        </Button>
        {cancel}
      </div>
    </div>
  );
}

/** Links are managed on the app itself. */
export function AccountApps({ apps }: { readonly apps: readonly App[] }) {
  const brand = useProductBrand();
  const { AppLink } = useDashboard();
  return apps.length === 0 ? (
    <EmptyState size="compact" heading="h3" title="No connected apps">
      No apps use this account.
    </EmptyState>
  ) : (
    <div className="account-apps flex flex-col [&_>_a]:flex [&_>_a]:items-center [&_>_a]:justify-between [&_>_a]:gap-3 [&_>_a]:py-[13px] [&_>_a]:px-0 [&_>_a]:text-[14px] [&_>_a_+_a]:border-t [&_>_a_+_a]:border-t-border [&_>_a_>_span]:wrap-anywhere [&_>_a_>_span]:min-w-0 [&_>_a_>_svg]:shrink-0 [&_>_a_>_svg]:text-muted-foreground">
      {apps.map((app) => (
        <AppLink key={app.id} app={app.id} view="accounts">
          <span>{appDisplayName(app, brand)}</span>
          <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden size={14} />
        </AppLink>
      ))}
    </div>
  );
}
