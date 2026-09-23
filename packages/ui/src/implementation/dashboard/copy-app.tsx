import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { App } from "@executor-js/sdk";
import type { AppAcknowledgement, AppManagementProps } from "../../contracts/app-management.ts";
import { AppCreateForm } from "./app-create.tsx";
import { Button } from "../components/button.tsx";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../components/dialog.tsx";

/** Both owned and public apps copy through the same operation and naming form. */
export function CopyApp<E>({
  app,
  atoms,
  Failure,
  onApp,
  onCopied,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly onApp: AppAcknowledgement;
  readonly onCopied: (app: App) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const mutation = atoms.copy({ app: app.id });
  const result = useAtomValue(mutation);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Make a copy
      </Button>
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (!result.waiting) setOpen(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Make a copy</DialogTitle>
          <DialogDescription>
            Create your own copy. Connected accounts and app data aren’t copied.
          </DialogDescription>
          <AppCreateForm
            mutation={mutation}
            Failure={Failure}
            initialName={app.name.length <= 115 ? `${app.name} copy` : ""}
            input={(name) => ({ name, onApp })}
            label="Make a copy"
            onCancel={() => setOpen(false)}
            onCreated={async (saved) => {
              setOpen(false);
              await onCopied(saved);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
