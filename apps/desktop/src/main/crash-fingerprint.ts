/**
 * Grouping keys for desktop crash reports.
 *
 * Two things split one desktop problem across many Sentry issues:
 *
 *  - Chromium's soft-assert path (`NOTREACHED()`/`DCHECK`) calls
 *    `DumpWithoutCrashing`, which files a minidump and lets the process carry
 *    on. Sentry titles each one with the faulting load address, so the same
 *    condition arrives as a new issue every time the address moves.
 *  - Renderer and main bundles ship as content-hashed chunks, so unresolved
 *    frames name `atoms-<hash>` and re-group on every release.
 *
 * Both are grouping problems only: nothing here drops, downgrades or edits an
 * event, and the frames keep their hashes so sourcemap resolution still works.
 */

import {
  stableGroupingFingerprint,
  type GroupingEvent,
  type GroupingFrame,
} from "@executor-js/sdk/sentry-grouping";

export type CrashEvent = GroupingEvent;

export const CHROMIUM_SOFT_ASSERT_FINGERPRINT = "chromium-dump-without-crashing";

const isSoftAssertFrame = (frame: GroupingFrame): boolean =>
  (frame.function ?? "").includes("DumpWithoutCrashing");

/**
 * The fingerprint to attach to a crash event, or `undefined` to keep Sentry's
 * default grouping (which is right for a real native abort — one issue per
 * distinct stack is what we want there).
 */
export const crashReportFingerprint = (event: CrashEvent): readonly string[] | undefined => {
  const frames = (event.exception?.values ?? []).flatMap((value) => value.stacktrace?.frames ?? []);
  if (frames.some(isSoftAssertFrame)) return [CHROMIUM_SOFT_ASSERT_FINGERPRINT];
  return stableGroupingFingerprint(event);
};
