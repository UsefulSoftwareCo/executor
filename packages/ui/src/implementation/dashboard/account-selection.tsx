import { Exit } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import type { App, AccountRequirement, SelectedAccounts } from "@executor-js/sdk";
import {
  providerDisplayUrl,
  type AccountSummary,
  type MutationProps,
  type SelectAccounts,
} from "../../contracts/dashboard.ts";
import { Empty, ProviderIcon } from "./common.tsx";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

/** Draft a selection once; the product supplies connect actions and the save resolver. */
export function AccountSelectionForm<A, E>({
  mutation,
  Failure,
  app,
  available,
  initialAccounts,
  addedAccounts,
  notice,
  connectAction,
  finishAction,
  onSaved,
  accountMeta,
}: MutationProps<SelectAccounts, A, E> & {
  readonly app: App;
  readonly available: readonly AccountSummary[];
  readonly initialAccounts?: SelectedAccounts;
  readonly addedAccounts?: SelectedAccounts | undefined;
  readonly notice?: ReactNode;
  readonly connectAction: (
    slot: string,
    requirement: AccountRequirement,
    accounts: SelectedAccounts,
  ) => ReactNode;
  readonly finishAction: ReactNode;
  readonly onSaved: (saved: A) => void | Promise<void>;
  readonly accountMeta?: (account: AccountSummary) => ReactNode;
}) {
  const [draftAccounts, setAccounts] = useState<SelectedAccounts>();
  const accounts = draftAccounts ?? initialAccounts ?? app.accounts;
  const [pending, setPending] = useState(false);
  const result = useAtomValue(mutation);
  const save = useAtomSet(mutation, { mode: "promiseExit" });
  const requirements = Object.entries(app.requirements.accounts);
  const valid = requirements.every(([slot, requirement]) => {
    const selection = accounts[slot];
    if (selection === undefined) return true;
    const ids = typeof selection === "string" ? [selection] : selection;
    return (
      (requirement.cardinality === "one"
        ? typeof selection === "string"
        : typeof selection !== "string") &&
      ids.every((id) =>
        available.some((account) => account.id === id && account.provider === requirement.provider),
      )
    );
  });
  const clear = (slot: string) =>
    setAccounts(Object.fromEntries(Object.entries(accounts).filter(([name]) => name !== slot)));
  return (
    <>
      {notice}
      <form
        className="setup-form max-w-145 flex flex-col gap-5.75 pt-2.5 max-[740px]:gap-5.25"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending || !valid) return;
          setPending(true);
          void save({ app: app.id, accounts }).then((exit) => {
            setPending(false);
            if (Exit.isSuccess(exit)) {
              void onSaved(exit.value);
            }
          });
        }}
      >
        {requirements.length === 0 ? (
          <Empty title="No account required">This app is ready to use.</Empty>
        ) : (
          requirements.map(([slot, requirement]) => {
            const options = available.filter(
              (account) => account.provider === requirement.provider,
            );
            const added = addedAccounts?.[slot];
            const addedIds = typeof added === "string" ? [added] : (added ?? []);
            const choices = options.filter((account) => !addedIds.includes(account.id));
            const selection = accounts[slot];
            const selectedIds = typeof selection === "string" ? [selection] : (selection ?? []);
            return (
              <section
                className="selection-slot flex flex-col gap-4.25 pb-5.5 border-b border-b-border [&_[data-slot='select-trigger']]:w-full"
                key={slot}
              >
                <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
                  <ProviderIcon
                    name={requirement.definition.name}
                    url={providerDisplayUrl(requirement.definition)}
                  />
                  <div>
                    <h2>{requirement.definition.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {requirements.some(
                        ([other, value]) =>
                          other !== slot && value.provider === requirement.provider,
                      ) && `${slot} · `}
                      <ProviderAccountSupport requirement={requirement} />
                    </p>
                  </div>
                </div>
                {requirement.cardinality === "one" ? (
                  <Select
                    value={typeof selection === "string" ? selection : "unselected"}
                    onValueChange={(value) => {
                      if (value === "unselected") {
                        clear(slot);
                        return;
                      }
                      const account = options.find((option) => option.id === value);
                      if (account) setAccounts({ ...accounts, [slot]: account.id });
                    }}
                    disabled={pending}
                  >
                    <SelectTrigger aria-label={`${requirement.definition.name} account`}>
                      <SelectValue
                        placeholder={choices.length ? "Choose an account" : "No other accounts"}
                      >
                        {typeof selection === "string"
                          ? (options.find((account) => account.id === selection)?.label ??
                            "Account unavailable")
                          : "Choose an account"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unselected">No account selected</SelectItem>
                      {typeof selection === "string" &&
                        !options.some((account) => account.id === selection) && (
                          <SelectItem value={selection} disabled>
                            {available.some((account) => account.id === selection)
                              ? "Account no longer compatible"
                              : "Account disconnected"}
                          </SelectItem>
                        )}
                      {choices.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.label || "Unnamed account"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <fieldset className="space-y-1">
                    <legend className="mb-3 flex w-full items-center justify-between text-sm">
                      <span>Accounts for this app</span>
                      <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                        {selectedIds.length} selected
                      </span>
                    </legend>
                    {choices.map((account) => {
                      const checked = selectedIds.includes(account.id);
                      return (
                        <label
                          key={account.id}
                          className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md px-3 py-2 ${checked ? "bg-muted/50" : "hover:bg-muted/30"}`}
                        >
                          <ProviderIcon
                            name={requirement.definition.name}
                            url={providerDisplayUrl(requirement.definition)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              <span className="break-words">
                                {account.label || "Unnamed account"}
                              </span>
                              {accountMeta?.(account)}
                            </span>
                          </span>
                          <span className="shrink-0">
                            <Checkbox
                              aria-label={account.label || "Unnamed account"}
                              checked={checked}
                              disabled={pending}
                              onCheckedChange={(value) =>
                                setAccounts({
                                  ...accounts,
                                  [slot]:
                                    value === true
                                      ? [...selectedIds, account.id]
                                      : selectedIds.filter((id) => id !== account.id),
                                })
                              }
                            />
                          </span>
                        </label>
                      );
                    })}
                    {!choices.length && (
                      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                        {addedIds.length > 0
                          ? "No other saved accounts for this provider."
                          : "No saved accounts for this provider."}
                      </p>
                    )}
                    <label className="flex min-h-12 items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/30">
                      <Checkbox
                        aria-label="Use without accounts"
                        checked={Array.isArray(selection) && !selection.length}
                        disabled={pending}
                        onCheckedChange={(checked) => {
                          if (checked === true) setAccounts({ ...accounts, [slot]: [] });
                        }}
                      />
                      Use without accounts
                    </label>
                  </fieldset>
                )}
                {selectedIds.some((id) => !options.some((account) => account.id === id)) && (
                  <p className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
                    A selected account is unavailable. Choose another account or clear this
                    selection.
                  </p>
                )}
                {selection !== undefined && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="clear-selection self-start"
                    disabled={pending}
                    onClick={() => clear(slot)}
                  >
                    Clear selection
                  </Button>
                )}
                {selection === undefined && (
                  <p className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
                    This app needs a selection before it can run.
                  </p>
                )}
                <div className="self-start">{connectAction(slot, requirement, accounts)}</div>
              </section>
            );
          })
        )}
        {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
        {!valid && (
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
            Clear or replace unavailable selections before saving.
          </span>
        )}
        <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
          Clearing a selection keeps the saved account.
        </span>
        <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px] max-[480px]:[&_>_button]:basis-full">
          <Button disabled={pending || !valid} type="submit">
            {pending ? "Saving…" : "Save selection"}
          </Button>
          {finishAction}
        </div>
      </form>
    </>
  );
}
import { ProviderAccountSupport } from "./app-accounts.tsx";
