import { useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import type { App, Profile } from "@executor-js/sdk";
import type { MutationProps, SelectAccounts } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../components/dialog.tsx";

/** Name a separate setup; its accounts are configured after creation in Accounts. */
export function SetupDialog<E>({
  app,
  mutation,
  Failure,
  onClose,
  onSaved,
}: MutationProps<SelectAccounts, Profile, E> & {
  readonly app: App;
  readonly onClose: () => void;
  readonly onSaved: (profile: Profile) => void;
}) {
  const result = useAtomValue(mutation);
  const create = useAtomSet(mutation, { mode: "promiseExit" });
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const accounts = Object.fromEntries(
    Object.entries(app.requirements.accounts)
      .filter(([, requirement]) => requirement.cardinality === "many")
      .map(([slot]) => [slot, []]),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogTitle>Create a new profile</DialogTitle>
        <DialogDescription>
          Profiles let you use this app with different combinations of accounts. Each profile has
          its own webhooks and schedules. Give this profile a name, then add accounts.
        </DialogDescription>
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting.current || !name.trim()) return;
            submitting.current = true;
            setPending(true);
            try {
              const exit = await create({ app: app.id, name: name.trim(), accounts });
              if (active.current && Exit.isSuccess(exit)) {
                onSaved(exit.value);
                onClose();
              }
            } finally {
              submitting.current = false;
              if (active.current) setPending(false);
            }
          }}
        >
          <label className="flex flex-col gap-2 text-sm font-medium">
            Name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Work"
              maxLength={128}
              required
              disabled={pending}
            />
          </label>
          {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create profile"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
