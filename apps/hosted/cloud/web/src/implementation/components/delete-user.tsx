import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
/** The last card on the cloud profile page: irreversible deletion of the signed-in user. */
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
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
import { Skeleton } from "@executor-js/ui/components/skeleton";
import type { UserRemovalPreview } from "@executor-js/hosted-server";
import { clearLastOrganization } from "@executor-js/hosted-web/last-organization";
import {
  deleteUserAtom,
  userRemovalError,
  userRemovalPreviewAtom,
} from "../../contracts/user-removal.ts";

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
const outcomeLabel = {
  delete: "Deleted, with everything in it",
  leave: "You leave; your personal accounts there are deleted",
  blocked: "You are its only owner. Delete it first",
} as const;

/** One plain sentence per consequence, so the dialog says exactly what is about to go. */
const summary = (preview: UserRemovalPreview) => {
  const deleted = preview.organizations.filter((entry) => entry.outcome === "delete").length;
  return [
    deleted === 0
      ? undefined
      : `${count(deleted, "organization")} where you are the only member ${deleted === 1 ? "is" : "are"} deleted with every app, account and credential in ${deleted === 1 ? "it" : "them"}.`,
    preview.personalAccounts === 0
      ? undefined
      : `${count(preview.personalAccounts, "personal account")} in your other organizations ${preview.personalAccounts === 1 ? "is" : "are"} deleted.`,
    "You are signed out everywhere.",
  ]
    .filter((sentence) => sentence !== undefined)
    .join(" ");
};

function Consequences({ preview }: { readonly preview: UserRemovalPreview }) {
  if (preview.organizations.length === 0) return null;
  return (
    <ul className="divide-y rounded-[6px] border" aria-label="What happens to your organizations">
      {preview.organizations.map((organization) => (
        <li
          key={organization.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{organization.name}</span>
          <span
            className={
              organization.outcome === "blocked" ? "text-destructive" : "text-muted-foreground"
            }
          >
            {outcomeLabel[organization.outcome]}
          </span>
          {organization.outcome === "blocked" && (
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/org/$organizationSlug/organization"
                params={{ organizationSlug: organization.slug }}
              >
                Settings
              </Link>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function DeleteUser({ email }: { readonly email: string }) {
  const preview = useAtomValue(userRemovalPreviewAtom);
  const retry = useAtomRefresh(userRemovalPreviewAtom);
  const remove = useAtomSet(deleteUserAtom, { mode: "promiseExit" });
  const state = useAtomValue(deleteUserAtom);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string>();
  const held = Option.getOrUndefined(AsyncResult.value(preview));
  const blocked = held?.organizations.some((organization) => organization.outcome === "blocked");
  const close = () => {
    setOpen(false);
    setConfirmation("");
    setError(undefined);
  };
  // The server refuses this too; the reason is shown before anyone types a confirmation.
  const disabledReason =
    held === undefined
      ? "Checking what deleting your account would remove."
      : blocked
        ? "Delete the organizations you are the only owner of first."
        : undefined;
  return (
    <Card className="gap-0 border-destructive/40 py-0">
      <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
        <CardTitle>
          <h2>Delete account</h2>
        </CardTitle>
        <CardDescription>
          Your sign-in methods, sessions, passkeys, API keys and MCP connections are deleted, with
          your personal accounts and their saved credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 pb-4">
        {AsyncResult.isFailure(preview) && held === undefined ? (
          <div className="flex items-center justify-between gap-2 text-[13px] text-destructive">
            <span role="alert">Could not check what deleting your account would remove.</span>
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : held === undefined ? (
          <Skeleton className="h-9 w-full" aria-label="Loading organizations" />
        ) : (
          <Consequences preview={held} />
        )}
        <div>
          <Button
            variant="destructive"
            disabledReason={disabledReason}
            onClick={() => setOpen(true)}
          >
            Delete account
          </Button>
        </div>
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
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogDescription>
            {held === undefined
              ? "Everything that belongs to you is deleted permanently."
              : summary(held)}
          </DialogDescription>
          <label className="flex flex-col gap-2 text-[13px]">
            <span>
              Type <span className="font-mono">{email}</span> to confirm.
            </span>
            <Input
              aria-label="Confirm your email"
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
              disabled={confirmation !== email}
              onClick={async () => {
                if (state.waiting || confirmation !== email) return;
                setError(undefined);
                const result = await remove();
                if (Exit.isFailure(result)) {
                  setError(userRemovalError(result.cause));
                  retry();
                  return;
                }
                // Every session is gone; load the public root, as signing out does.
                clearLastOrganization();
                window.location.replace("/");
              }}
            >
              Delete account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
