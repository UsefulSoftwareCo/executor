import { useAtomSet, useAtomValue } from "@effect/atom-react";
/** The last card on cloud organization settings: irreversible, owner-only removal. */
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { Input } from "@executor-js/ui/components/input";
import { useOrganization } from "@executor-js/hosted-web/organization";
import { inventoryAtom, organizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { forgetOrganization } from "@executor-js/hosted-web/session-hint";
import {
  deleteOrganizationAtom,
  organizationRemovalError,
} from "../../contracts/organization-removal.ts";

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

export function DeleteOrganization() {
  const organization = useOrganization();
  const navigate = useNavigate();
  const remove = useAtomSet(deleteOrganizationAtom(organization.organization), {
    mode: "promiseExit",
  });
  const state = useAtomValue(deleteOrganizationAtom(organization.organization));
  const inventory = useAtomValue(inventoryAtom(organization.organization));
  const organizations = useAtomValue(organizationsAtom);
  const session = useAtomValue(sessionAtom);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string>();
  const held = Option.getOrUndefined(AsyncResult.value(inventory));
  const remaining = Option.getOrUndefined(AsyncResult.value(organizations))?.filter(
    (entry) => entry.id !== organization.organization,
  );
  const userId = Option.getOrUndefined(AsyncResult.value(session))?.user.id;
  const close = () => {
    setOpen(false);
    setConfirmation("");
    setError(undefined);
  };
  // Admins manage the organization; only an owner can end it. The server checks this too.
  const disabledReason =
    organization.role === "owner"
      ? undefined
      : "Only an organization owner can delete the organization.";
  return (
    <Card className="gap-0 border-destructive/40 py-0">
      <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
        <CardTitle>
          <h2>Delete organization</h2>
        </CardTitle>
        <CardDescription>
          {held === undefined
            ? "Everything this organization owns is deleted with it."
            : `${count(held.apps.length, "app")} and ${count(held.accounts.length, "account")}, with their saved credentials, are deleted with it.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <Button variant="destructive" disabledReason={disabledReason} onClick={() => setOpen(true)}>
          Delete organization
        </Button>
      </CardContent>
      <CardFooter className="border-t bg-muted/30 px-4 py-3 text-[11px] text-muted-foreground">
        <p>This cannot be undone.</p>
      </CardFooter>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !state.waiting) close();
        }}
      >
        <DialogContent>
          <DialogTitle>Delete {organization.name}?</DialogTitle>
          <DialogDescription>
            Its apps, accounts, saved credentials, deployments and MCP connections are deleted
            permanently. Members lose access immediately. Any paid subscription is cancelled.
          </DialogDescription>
          <label className="flex flex-col gap-2 text-[13px]">
            <span>
              Type <span className="font-mono">{organization.slug}</span> to confirm.
            </span>
            <Input
              aria-label="Confirm organization URL"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                setError(undefined);
              }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={state.waiting}
            />
          </label>
          {error && (
            <p className="auth-error text-destructive text-[13px]" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={state.waiting} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={state.waiting}
              disabled={confirmation !== organization.slug}
              onClick={async () => {
                if (state.waiting || confirmation !== organization.slug) return;
                setError(undefined);
                const result = await remove();
                if (Exit.isFailure(result)) {
                  setError(organizationRemovalError(result.cause));
                  return;
                }
                // Drop the remembered destination before leaving, or entry returns here.
                if (userId !== undefined) forgetOrganization(userId, organization.organization);
                setOpen(false);
                const next = remaining?.[0];
                await navigate(
                  next === undefined
                    ? { to: "/", replace: true }
                    : {
                        to: "/org/$organizationSlug/apps",
                        params: { organizationSlug: next.slug },
                        replace: true,
                      },
                );
              }}
            >
              Delete organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
