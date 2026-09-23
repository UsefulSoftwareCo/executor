import { useState, type ReactNode, type ComponentType } from "react";
import { Exit, type Cause } from "effect";
import type { AccountId, AccountRequirement, SelectedAccounts } from "@executor-js/sdk";
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

/** An open editor captures one confirmed selection and the command that saves its revision. */
export interface SavedAccountEdit<Saved, E> {
  readonly accounts: SelectedAccounts;
  readonly save: (accounts: SelectedAccounts) => Promise<Exit.Exit<Saved, E>>;
}

/** Select saved accounts in place. Single choices commit immediately; multiple choices commit together. */
export function SavedAccountPicker<E, Saved>({
  selectedAccounts,
  slot,
  requirement,
  accounts,
  prepare,
  Failure,
  connectAction,
  connectForm,
  busy = false,
  trigger,
}: {
  readonly selectedAccounts: SelectedAccounts;
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly accounts: readonly AccountSummary[];
  readonly prepare: () => Exit.Exit<SavedAccountEdit<Saved, E>, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly connectAction?: (close: () => void, appearance: "button" | "row") => ReactNode;
  readonly connectForm?: ((close: () => void) => ReactNode) | undefined;
  readonly busy?: boolean;
  readonly trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [connectOnOpen, setConnectOnOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<readonly AccountId[]>([]);
  const [pending, setPending] = useState(false);
  // Keep the bindings and revision captured when this editor opened.
  const [edit, setEdit] = useState<SavedAccountEdit<Saved, E>>();
  const [error, setError] = useState<Cause.Cause<E>>();
  const selection = edit === undefined ? selectedAccounts[slot] : edit.accounts[slot];
  const selected = typeof selection === "string" ? [selection] : (selection ?? []);
  const available = accounts.filter(
    (account) => account.provider === requirement.provider && !selected.includes(account.id),
  );
  const filtered = available.filter((account) =>
    account.label.toLowerCase().includes(search.toLowerCase()),
  );
  const many = requirement.cardinality === "many";
  const choose = async (value: AccountId | readonly AccountId[] | undefined) => {
    if (pending || busy || edit === undefined) return;
    setPending(true);
    setError(undefined);
    const next = Object.fromEntries(Object.entries(edit.accounts).filter(([key]) => key !== slot));
    const result = await edit.save(value === undefined ? next : { ...next, [slot]: value });
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
          const snapshot = prepare();
          setSearch("");
          if (Exit.isFailure(snapshot)) {
            setEdit(undefined);
            setConnectOnOpen(false);
            setError(snapshot.cause);
          } else {
            setEdit(snapshot.value);
            const current = snapshot.value.accounts[slot];
            const selected = typeof current === "string" ? [current] : (current ?? []);
            setDraft(selected);
            // A background account refresh must not replace an open connection draft.
            setConnectOnOpen(
              connectForm !== undefined &&
                !accounts.some(
                  (account) =>
                    account.provider === requirement.provider && !selected.includes(account.id),
                ),
            );
            setError(undefined);
          }
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" loading={busy}>
            {many && selection !== undefined
              ? "Manage accounts"
              : selected.length
                ? "Change account"
                : "Use saved account"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className={
          connectOnOpen
            ? "max-h-[85dvh] gap-5 overflow-x-hidden overflow-y-auto sm:max-w-[560px]"
            : "max-h-[85dvh] overflow-x-hidden overflow-y-auto sm:max-w-[440px]"
        }
      >
        {connectOnOpen && connectForm ? (
          <>
            {connectForm(() => setOpen(false))}
            {error && <Failure cause={error} />}
            {many && selectedAccounts[slot] === undefined && (
              <Button
                variant="ghost"
                loading={pending}
                disabled={busy}
                onClick={() => {
                  void choose([]);
                }}
              >
                Use without accounts
              </Button>
            )}
          </>
        ) : (
          <>
            <DialogTitle>{requirement.definition.name} accounts</DialogTitle>
            <DialogDescription>
              {many
                ? "Choose the accounts to use together."
                : selected.length > 0
                  ? "Choose an account to replace the current selection."
                  : "Choose one account."}
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
              {filtered.map((account) => {
                const duplicate =
                  available.filter((item) => item.label === account.label).length > 1;
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
                    className="flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted has-data-[state=checked]:bg-muted/50"
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
                  </Button>
                );
              })}
              {available.length > 0 && filtered.length === 0 && (
                <EmptyState
                  size="compact"
                  title="No matching accounts"
                  action={
                    <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                      Clear search
                    </Button>
                  }
                >
                  Try another account name.
                </EmptyState>
              )}
              {available.length === 0 && (
                <EmptyState
                  size="compact"
                  title={selected.length > 0 ? "No other saved accounts" : "No saved accounts"}
                >
                  {selected.length > 0
                    ? "No other saved accounts for this provider."
                    : "No saved accounts for this provider."}
                </EmptyState>
              )}
              {connectAction?.(() => setOpen(false), "row")}
            </div>
            {error && <Failure cause={error} />}
            <DialogFooter className="flex-wrap gap-2">
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
                Changing this selection keeps your saved accounts available to other profiles and
                apps.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
import { EmptyState } from "./empty-state.tsx";
