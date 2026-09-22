import { EmptyState } from "./empty-state.tsx";
import { useState, type ReactNode, type ComponentType } from "react";
import { Exit, type Cause } from "effect";
import type { AccountId, AccountRequirement, App, SelectedAccounts } from "@executor-js/sdk";
import type { AccountSummary, FailureProps } from "../../contracts/dashboard.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../components/dialog.tsx";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
import { Input } from "../components/input.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";

/** Select saved accounts in place. Single choices commit immediately; multiple choices commit together. */
export function AccountPicker<E>({
  app,
  slot,
  requirement,
  accounts,
  save,
  Failure,
  connectAction,
  busy = false,
}: {
  readonly app: App;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly save: (accounts: SelectedAccounts) => Promise<Exit.Exit<App, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly connectAction?: (close: () => void) => ReactNode;
  readonly busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<readonly AccountId[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const selection = app.accounts[slot];
  const selected = typeof selection === "string" ? [selection] : (selection ?? []);
  const available = accounts.filter((account) => account.provider === requirement.provider);
  const many = requirement.cardinality === "many";
  const choose = async (value: AccountId | readonly AccountId[] | undefined) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const next = Object.fromEntries(Object.entries(app.accounts).filter(([key]) => key !== slot));
    const result = await save(value === undefined ? next : { ...next, [slot]: value });
    setPending(false);
    if (Exit.isFailure(result)) setError(result.cause);
    else setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (pending || busy) return;
        setOpen(value);
        if (value) {
          setDraft(selected);
          setSearch("");
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" loading={busy}>
          {many && selection !== undefined
            ? "Manage accounts"
            : selected.length
              ? "Change account"
              : "Use saved account"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[400px]">
        <DialogTitle>{requirement.definition.name} accounts</DialogTitle>
        <DialogDescription className="sr-only">
          {many
            ? "Choose the accounts this app can use."
            : "Select an account to use it in this app."}
        </DialogDescription>
        {available.length > 6 && (
          <Input
            aria-label="Search saved accounts"
            placeholder="Search accounts…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        <div className="flex flex-col gap-1">
          {available
            .filter((account) => account.label.toLowerCase().includes(search.toLowerCase()))
            .map((account) => {
              const duplicate = available.filter((item) => item.label === account.label).length > 1;
              const sameSecond = available.some(
                (item) =>
                  item.id !== account.id &&
                  item.label === account.label &&
                  item.createdAt.toLocaleString() === account.createdAt.toLocaleString(),
              );
              const auth = requirement.definition.auth[account.method];
              const detail = auth?.type === "oauth2" ? "Browser sign-in" : auth?.label;
              const content = (
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-medium">
                    {account.label || "Unnamed account"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {detail}
                    {duplicate &&
                      ` · Added ${sameSecond ? account.createdAt.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }) : account.createdAt.toLocaleString()}`}
                  </span>
                </span>
              );
              return many ? (
                <label
                  key={account.id}
                  className="flex min-h-14 cursor-pointer items-center gap-3 rounded-md border p-3 text-sm has-data-[state=checked]:border-foreground/40"
                >
                  <Checkbox
                    disabled={pending}
                    checked={draft.includes(account.id)}
                    onCheckedChange={(checked) =>
                      setDraft(
                        checked === true
                          ? [...draft, account.id]
                          : draft.filter((id) => id !== account.id),
                      )
                    }
                  />
                  {content}
                </label>
              ) : (
                <Button
                  key={account.id}
                  variant="ghost"
                  className="h-auto min-h-14 justify-start gap-3 p-3"
                  disabled={pending}
                  onClick={() => {
                    void choose(account.id);
                  }}
                >
                  {content}
                  {selected.includes(account.id) && (
                    <HugeiconsIcon icon={Tick02Icon} size={16} aria-label="In use" />
                  )}
                </Button>
              );
            })}
          {available.length === 0 && (
            <EmptyState size="compact" title="No saved accounts">
              Close this dialog and connect an account.
            </EmptyState>
          )}
        </div>
        {connectAction && (
          <div className="flex items-center gap-2 border-t pt-4">
            {connectAction(() => setOpen(false))}
          </div>
        )}
        {error && <Failure cause={error} />}
        <DialogFooter className="gap-2">
          {selection !== undefined && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                void choose(undefined);
              }}
            >
              Stop using {many ? "these accounts" : "this account"}
            </Button>
          )}
          {many && (
            <Button
              loading={pending}
              onClick={() => {
                void choose(draft);
              }}
            >
              {draft.length ? "Use selected accounts" : "Use without accounts"}
            </Button>
          )}
        </DialogFooter>
        {selection !== undefined && (
          <p className="text-xs text-muted-foreground">
            Removing an account from this app keeps it available to your other apps.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
