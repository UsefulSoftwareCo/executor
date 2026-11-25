import { useRef, useState } from "react";
import bundled from "virtual:cloud-release-notes";
import { isPlainNote, type NoteKind, whatsNewHeadline } from "@executor-js/utils/release-notes";
import { ReleaseNotesDialog, SidebarNews } from "@executor-js/ui/dashboard/sidebar-news";

type CloudNote = { readonly date: string; readonly text: string; readonly kind: NoteKind };

export const cloudNotes: ReadonlyArray<CloudNote> =
  bundled === null ? [] : bundled.notes.filter((note) => isPlainNote(note.text));

const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export const whatsNewTitle = "See recent changes to Executor Cloud.";

export function CloudWhatsNew({ notes }: { readonly notes: ReadonlyArray<CloudNote> }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const days = [...new Set(notes.map((note) => note.date))];
  return (
    <>
      <SidebarNews
        tag="What's new"
        open={{ label: "Open what's new", onOpen: () => setOpen(true) }}
        buttonRef={opener}
      >
        {whatsNewHeadline(notes)?.text ?? whatsNewTitle}
      </SidebarNews>
      <ReleaseNotesDialog
        open={open}
        onOpenChange={setOpen}
        returnFocus={opener}
        title="What's new"
        description="Changes to Executor Cloud in the last 30 days."
        releases={days.map((date) => ({
          key: date,
          heading: day(date),
          notes: notes.filter((note) => note.date === date).map((note) => note.text),
        }))}
      />
    </>
  );
}
