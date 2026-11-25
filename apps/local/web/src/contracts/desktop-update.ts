import { Option, Schema } from "effect";
import { isPlainNote } from "@executor-js/utils/release-notes";
import { compareReleaseVersions, ReleaseVersion } from "@executor-js/utils/release-version";

export const DesktopRelease = Schema.Struct({
  version: Schema.String,
  notes: Schema.Array(Schema.String),
});
export type DesktopRelease = typeof DesktopRelease.Type;

export const DesktopUpdate = Schema.Struct({
  state: Schema.Literals(["downloading", "ready"]),
  version: Schema.String,
  current: Schema.optional(Schema.String),
  releases: Schema.optional(Schema.Array(DesktopRelease)),
  releasesSince: Schema.optional(Schema.String),
});
export type DesktopUpdate = typeof DesktopUpdate.Type;

export const desktopUpdateAttribute = "data-desktop-update";
export const desktopUpdateEvent = "executor:desktop-update";
export const desktopUpdateRestartUrl = "executor-update:restart";

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

export const runningRelease = (update: DesktopUpdate) =>
  Option.getOrUndefined(decodeVersion(update.current));

const FeedSince = Schema.Struct({ releaseNotesSince: ReleaseVersion });

export const feedReleasesSince = (updateInfo: unknown) =>
  Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(FeedSince)(updateInfo), (feed) => feed.releaseNotesSince),
  );

export const listsEverySince = (update: DesktopUpdate) => {
  const current = decodeVersion(update.current);
  const since = decodeVersion(update.releasesSince);
  return (
    Option.isSome(current) &&
    Option.isSome(since) &&
    compareReleaseVersions(current.value, since.value) >= 0
  );
};
