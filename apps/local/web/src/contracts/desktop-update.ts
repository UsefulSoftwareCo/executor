/**
 * The desktop app's update, shown in the dashboard's sidebar. The desktop window has no preload
 * or IPC bridge, so its main process writes the update on the dashboard's document, as this
 * attribute's JSON, and announces each change with this event. The sidebar's action is a link to
 * `executor-update:restart`, which the main process intercepts as it does the recovery page's
 * links. A dashboard outside the desktop never gets the attribute and shows nothing.
 */
import { Option, Schema } from "effect";
import { isPlainNote } from "@executor-js/utils/release-notes";
import { compareReleaseVersions, ReleaseVersion } from "@executor-js/utils/release-version";

/** One release's notes, as the update feed lists them: plain sentences, never Markdown or HTML. */
export const DesktopRelease = Schema.Struct({
  version: Schema.String,
  notes: Schema.Array(Schema.String),
});
export type DesktopRelease = typeof DesktopRelease.Type;

export const DesktopUpdate = Schema.Struct({
  /** `downloading` while the desktop fetches it; `ready` once a restart installs it. */
  state: Schema.Literals(["downloading", "ready"]),
  version: Schema.String,
  /** The version running now; a development build's is no release version. */
  current: Schema.optional(Schema.String),
  /**
   * The releases the update feed has notes for, newest first, up to `version`, once it is ready.
   * Absent when the feed has none; the dashboard shows the version alone then.
   */
  releases: Schema.optional(Schema.Array(DesktopRelease)),
  /**
   * The release after which `releases` lists every one, as the update feed states it
   * (`releaseNotesSince`). Absent when the feed does not say; then the notes may have gaps.
   */
  releasesSince: Schema.optional(Schema.String),
});
export type DesktopUpdate = typeof DesktopUpdate.Type;

export const desktopUpdateAttribute = "data-desktop-update";
export const desktopUpdateEvent = "executor:desktop-update";
export const desktopUpdateRestartUrl = "executor-update:restart";

/**
 * The script the desktop runs in the dashboard's page to show `update`, or to clear it. The value
 * is JSON, written into the script as a string literal.
 */
export const desktopUpdateScript = (update: DesktopUpdate | undefined) =>
  `((value) => {
  const root = document.documentElement;
  if (value === null) root.removeAttribute(${JSON.stringify(desktopUpdateAttribute)});
  else root.setAttribute(${JSON.stringify(desktopUpdateAttribute)}, value);
  window.dispatchEvent(new Event(${JSON.stringify(desktopUpdateEvent)}));
})(${JSON.stringify(update === undefined ? null : JSON.stringify(update))});`;

const FeedNotes = Schema.Array(
  Schema.Struct({ version: Schema.Unknown, note: Schema.optional(Schema.NullOr(Schema.Unknown)) }),
);
const decodeVersion = Schema.decodeUnknownOption(ReleaseVersion);

/**
 * The releases an update feed's `releaseNotes` lists (scripts/releases/desktop-feed.ts), newest
 * first, up to `ready`: each a release version and its notes, one per line, keeping only those
 * the release notes' allow-list accepts. Anything else in the feed is left out, never shown.
 * Undefined when the feed lists no notes in that form.
 */
export const feedReleases = (
  releaseNotes: unknown,
  ready: string,
): ReadonlyArray<DesktopRelease> | undefined => {
  const listed = Schema.decodeUnknownOption(FeedNotes)(releaseNotes);
  const upTo = decodeVersion(ready);
  if (Option.isNone(listed) || Option.isNone(upTo)) return undefined;
  return listed.value
    .flatMap((entry) => {
      const version = decodeVersion(entry.version);
      if (Option.isNone(version) || compareReleaseVersions(version.value, upTo.value) > 0)
        return [];
      const note = typeof entry.note === "string" ? entry.note : "";
      return [{ version: version.value, notes: note.split("\n").filter(isPlainNote) }];
    })
    .sort((left, right) => compareReleaseVersions(right.version, left.version));
};

/**
 * The releases between the version running now and the ready one, newest first, with only the
 * notes the allow-list accepts: the dashboard checks again what the desktop sent. Every release up
 * to the ready one when the running version is not a release.
 */
export const releasesSince = (update: DesktopUpdate): ReadonlyArray<DesktopRelease> => {
  const current = decodeVersion(update.current);
  const ready = decodeVersion(update.version);
  if (Option.isNone(ready)) return [];
  return (update.releases ?? []).flatMap((release) => {
    const version = decodeVersion(release.version);
    if (Option.isNone(version) || compareReleaseVersions(version.value, ready.value) > 0) return [];
    if (Option.isSome(current) && compareReleaseVersions(version.value, current.value) <= 0)
      return [];
    return [{ version: version.value, notes: release.notes.filter(isPlainNote) }];
  });
};

/** The version running now, when it is a release version; a development build has none. */
export const runningRelease = (update: DesktopUpdate) =>
  Option.getOrUndefined(decodeVersion(update.current));

const FeedSince = Schema.Struct({ releaseNotesSince: ReleaseVersion });

/**
 * The release after which an update feed file lists every release's notes (its
 * `releaseNotesSince`, scripts/releases/desktop-feed.ts), or undefined when it states none or no
 * release version. electron-updater keeps the file's other fields on the update's info.
 */
export const feedReleasesSince = (updateInfo: unknown) =>
  Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(FeedSince)(updateInfo), (feed) => feed.releaseNotesSince),
  );

/**
 * Whether `releasesSince` lists every release since the version running now: only when the feed
 * says its notes are whole back to that version or before it. The feed holds only the latest
 * releases and may leave one out, so neither the oldest version listed nor the versions in between
 * tell; nothing but the feed's own statement does.
 */
export const listsEverySince = (update: DesktopUpdate) => {
  const current = decodeVersion(update.current);
  const since = decodeVersion(update.releasesSince);
  return (
    Option.isSome(current) &&
    Option.isSome(since) &&
    compareReleaseVersions(current.value, since.value) >= 0
  );
};
