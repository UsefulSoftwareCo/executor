import type { App } from "@executor-js/sdk";
import { Exit, type Cause } from "effect";
import { useState, type ComponentType } from "react";
import type { FailureProps } from "../../contracts/dashboard.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../components/dialog.tsx";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";

/** One rename interaction; products supply their authorized mutation and exact error renderer. */
export function RenameApp<E>({
  app,
  rename,
  Failure,
}: {
  readonly app: App;
  readonly rename: (name: string) => Promise<Exit.Exit<App, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(app.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (pending) return;
        setOpen(open);
        setError(undefined);
        if (open) setName(app.name);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Rename app</DialogTitle>
        <DialogDescription>Choose a name for this app.</DialogDescription>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            setPending(true);
            setError(undefined);
            const result = await rename(name.trim());
            setPending(false);
            if (Exit.isFailure(result)) setError(result.cause);
            else setOpen(false);
          }}
        >
          <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
            App name
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              pattern=".*\S.*"
              maxLength={120}
              disabled={pending}
            />
          </label>
          {error && <Failure cause={error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button loading={pending} disabled={!name.trim()}>
              Save name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
