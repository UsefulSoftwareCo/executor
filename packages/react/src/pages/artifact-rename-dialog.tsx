import { useId, useState } from "react";

import { Button } from "../components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/dialog";
import { Input } from "../components/input";
import { Label } from "../components/label";

/**
 * Rename affordance shared by the artifacts list and the artifact detail page.
 *
 * The draft title lives inside the dialog, so closing it discards the edit and
 * reopening always starts from the artifact's current title — no stale draft
 * survives a cancel. The parent owns the write and the failure toast.
 */
export function RenameArtifactDialog(props: {
  readonly currentTitle: string;
  readonly onRename: (title: string) => void;
  /** Rendered as the trigger; defaults to the list row's hover-revealed button. */
  readonly trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {props.trigger ?? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
          >
            Rename
          </Button>
        )}
      </DialogTrigger>
      {/* Remounted per open so the draft always starts from the current title. */}
      {open ? (
        <RenameArtifactForm
          currentTitle={props.currentTitle}
          onRename={props.onRename}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Dialog>
  );
}

function RenameArtifactForm(props: {
  readonly currentTitle: string;
  readonly onRename: (title: string) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState(props.currentTitle);
  const trimmed = draft.trim();
  const unchanged = trimmed === props.currentTitle;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed || unchanged) {
      props.onClose();
      return;
    }
    props.onRename(trimmed);
    props.onClose();
  };

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>Rename Artifact</DialogTitle>
          <DialogDescription>
            Agents find an artifact by its title, so name it the way you would ask for it.
          </DialogDescription>
        </DialogHeader>
        <div className="my-4">
          <Label htmlFor={titleId} className="text-sm font-medium">
            Title
          </Label>
          <Input
            id={titleId}
            autoFocus
            value={draft}
            onChange={(event) => setDraft((event.target as HTMLInputElement).value)}
            className="mt-1.5 h-9 text-sm"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!trimmed || unchanged}>
            Save Title
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
