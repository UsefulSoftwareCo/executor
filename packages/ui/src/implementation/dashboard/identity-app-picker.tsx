/** Start from the verified account row, then use the product's existing app connection form. */
import { useState, type ReactNode } from "react";
import type { AccountId, AccountRequirement, App } from "@executor-js/sdk";
import type { AccountSummary, Inventory } from "../../contracts/dashboard.ts";
import { identityAppTargets } from "../../contracts/identity-consent.ts";
import { Button } from "../components/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";
import { Label } from "../components/label.tsx";

export function IdentityAppPicker({
  bindings,
  inventory,
  children,
}: {
  readonly bindings: readonly AccountSummary[];
  readonly inventory: Inventory;
  readonly children: (input: {
    readonly app: App;
    readonly requirement: AccountRequirement;
    readonly slot: string;
    readonly method: string;
    readonly account: AccountId;
    readonly onDone: () => void;
    readonly onPendingChange: (pending: boolean) => void;
  }) => ReactNode;
}) {
  const account = bindings[0];
  const identity = account?.identity;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  if (identity === undefined || account === undefined) return null;
  const choices = identityAppTargets(inventory, identity.issuer).filter(
    (entry) =>
      !inventory.links.some(
        (link) =>
          link.app === entry.app.id &&
          bindings.some(
            (binding) => binding.id === link.account && binding.provider === entry.target.provider,
          ),
      ),
  );
  const chosen = choices.find((entry) => `${entry.app.id}:${entry.requirement}` === selected);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setSelected("");
          setOpen(true);
        }}
      >
        Add {identity.name} app
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
          <DialogTitle>Add {identity.name} app</DialogTitle>
          <DialogDescription>Use {identity.label} with another app.</DialogDescription>
          {choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every installed app for this account is connected. Install another app, then return
              here.
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="identity-app">App</Label>
              <Select value={selected} onValueChange={setSelected} disabled={busy}>
                <SelectTrigger id="identity-app" className="w-full">
                  <SelectValue placeholder="Choose an app" />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((entry) => (
                    <SelectItem
                      key={`${entry.app.id}:${entry.requirement}`}
                      value={`${entry.app.id}:${entry.requirement}`}
                    >
                      {entry.app.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {chosen !== undefined &&
            children({
              app: chosen.app,
              requirement: chosen.target,
              slot: chosen.requirement,
              method: chosen.method,
              account: account.id,
              onDone: () => setOpen(false),
              onPendingChange: setBusy,
            })}
        </DialogContent>
      </Dialog>
    </>
  );
}
