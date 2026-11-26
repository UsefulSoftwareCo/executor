/** Portable browser-build inputs and output, independent of a compiler or host filesystem. */
import type { Effect } from "effect";
import type { AppUiDocument } from "apps/ui/contracts";
import type { RuntimeBuildFailed } from "./runtime.ts";

/** One complete retained browser object, relative to the app's asset root. */
export interface UiBuildFile {
  readonly path: string;
  readonly contentType: string;
  readonly body: Uint8Array;
}

/** Compiler output corresponding to an entry named by the authored HTML. */
export interface UiBuildEntry {
  readonly source: string;
  readonly path: string;
  readonly css?: string;
}

/** One authored page the build retains, as written. */
export interface UiBuildDocument {
  readonly kind: AppUiDocument;
  readonly html: string;
}

/**
 * One build's HTML plan: every page the app declares and the entries any of them names, once
 * each. Entry paths use canonical project-relative POSIX paths.
 */
export interface UiBuildPlan {
  readonly documents: readonly UiBuildDocument[];
  readonly entries: readonly string[];
  readonly finish: (
    files: readonly UiBuildFile[],
    entries: readonly UiBuildEntry[],
  ) => Effect.Effect<readonly UiBuildFile[], RuntimeBuildFailed>;
}
