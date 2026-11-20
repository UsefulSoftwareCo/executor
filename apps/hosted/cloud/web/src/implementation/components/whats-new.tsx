import { useRef, useState } from "react";
import bundled from "virtual:cloud-release-notes";
import { isPlainNote, type NoteKind, whatsNewHeadline } from "@executor-js/utils/release-notes";
import { ReleaseNotesDialog, SidebarNews } from "@executor-js/ui/dashboard/sidebar-news";

/** One of Cloud's notes: the day its change reached main, its text and the kind its writer gave it. */
type CloudNote = { readonly date: string; readonly text: string; readonly kind: NoteKind };

/**
 * The notes this build holds (`release-notes.ts` beside the Vite config), newest first, that the
 * release notes' allow-list accepts. None for a build given no notes. They are the notes of the
 * 30 days before the deployed commit, and Cloud deploys every merge to main, so there is nothing
 * to filter by the browser's clock.
 */
export const cloudNotes: ReadonlyArray<CloudNote> =
  bundled === null ? [] : bundled.notes.filter((note) => isPlainNote(note.text));

const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** The block's line when none of the notes is a feature or an improvement. */
export const whatsNewTitle = "See recent changes to Executor Cloud.";

/**
 * Cloud's "What's new", after PlanetScale's sidebar changelog: a "What's new" tag and the newest
 * note that is a feature or an improvement (`whatsNewHeadline`), or `whatsNewTitle` when there is
 * none, as one button that opens every one of `notes`, fixes included, by the day it reached
 * Cloud. Every member sees it; it cannot be dismissed, and it goes with the first deploy that has
 * no note new enough. Render it only when `cloudNotes` has one.
 */
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
