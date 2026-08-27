// ---------------------------------------------------------------------------
// Stable Sentry grouping across deploys.
//
// Every bundle we ship names its chunks `<name>-<contentHash>.js`, and the
// hash rotates on every build. When a stack frame is not resolved back to
// source (no uploaded sourcemap for that release), Sentry groups on those
// minified names, so the SAME error opens a brand-new issue after each
// deploy — one bug spread over N issues, no counts, no regression history.
//
// The fix is a `beforeSend` that computes an explicit `fingerprint` from the
// event's grouping inputs with the volatile hash segment removed. The event
// itself is left untouched: filenames still carry their hashes so server-side
// sourcemap resolution keeps working — only the grouping key is normalized.
//
// Deliberately narrow: a fingerprint is returned ONLY for events that actually
// carry a content hash. Everything else keeps Sentry's default grouping.
// ---------------------------------------------------------------------------

/** The shape of a Sentry stack frame this module reads. Structural on purpose:
 * the same helper serves @sentry/cloudflare, /electron and /browser events. */
export type GroupingFrame = {
  readonly filename?: string | undefined;
  readonly abs_path?: string | undefined;
  readonly module?: string | undefined;
  readonly function?: string | undefined;
  readonly in_app?: boolean | undefined;
};

export type GroupingExceptionValue = {
  readonly type?: string | undefined;
  readonly value?: string | undefined;
  readonly stacktrace?: { readonly frames?: readonly GroupingFrame[] | undefined } | undefined;
  readonly mechanism?: { readonly type?: string | undefined } | undefined;
};

export type GroupingEvent = {
  readonly culprit?: string | undefined;
  readonly exception?: { readonly values?: readonly GroupingExceptionValue[] | undefined };
};

/**
 * A `-XXXXXXXX` tail that ends a path segment — i.e. is followed by nothing,
 * by file extensions, or by a delimiter such as the `)` in a Sentry culprit
 * (`orElse(execution-rate-limit-BAuwphPA)`). Eight characters is the Vite and
 * Rollup default; the hash alphabet includes `-` and `_`, so a hash can itself
 * contain a dash (`BCr-oWx4`) and the whole 8-char tail must go at once.
 */
const HASH_TAIL = /-([A-Za-z0-9_-]{8})(?=(?:\.[A-Za-z0-9]+)*(?:$|[)\]}'"\s,:;?#]))/g;

/**
 * Whether an 8-character segment reads like a content hash rather than a word.
 * Build hashes are random base64url, so they mix cases and digits; real name
 * segments (`callback`, `grouping`, `provider`) are all lowercase. Requiring
 * that mix is what keeps `oauth-callback` from collapsing to `oauth`. The cost
 * is that the occasional word-shaped hash (one capital, no digits) is left
 * alone and keeps re-grouping — 1 of 147 chunks in a sample desktop build. A
 * missed normalization is recoverable; a wrongly merged issue is not.
 */
const looksLikeContentHash = (segment: string): boolean => {
  let upper = 0;
  let digits = 0;
  for (const char of segment) {
    if (char >= "A" && char <= "Z") upper += 1;
    else if (char >= "0" && char <= "9") digits += 1;
  }
  return upper >= 2 || (upper >= 1 && digits >= 1) || digits >= 2;
};

/**
 * Remove build content hashes from a path, module name or culprit string,
 * leaving every other character in place.
 */
export const stripContentHashes = (value: string): string =>
  value.replace(HASH_TAIL, (match, segment: string) =>
    looksLikeContentHash(segment) ? "" : match,
  );

/** True when the value carries at least one build content hash. */
export const containsContentHash = (value: string): boolean => stripContentHashes(value) !== value;

/**
 * Minified identifiers rotate with every build exactly like chunk hashes, so a
 * fingerprint containing one is no more stable than the hash it replaced. Names
 * of three characters or fewer are treated as minified and dropped; the frame
 * still contributes its module.
 */
const MINIFIED_FUNCTION = /^[A-Za-z_$][A-Za-z0-9_$]{0,2}$/;

const usableFunction = (name: string | undefined): string | undefined => {
  if (!name || name === "<anonymous>" || name === "?") return undefined;
  return MINIFIED_FUNCTION.test(name) ? undefined : name;
};

/** Last path segment, without query or fragment. Chunk paths are served from
 * host- and port-specific origins (`http://127.0.0.1:4789/assets/…`), which are
 * volatile in their own right. */
const basename = (path: string): string => {
  const clean = path.split(/[?#]/)[0] ?? path;
  const segments = clean.split(/[/\\]/);
  return segments[segments.length - 1] || clean;
};

const frameLocation = (frame: GroupingFrame): string | undefined => {
  if (frame.module) return stripContentHashes(frame.module);
  const path = frame.filename ?? frame.abs_path;
  return path ? stripContentHashes(basename(path)) : undefined;
};

const frameKey = (frame: GroupingFrame): string | undefined => {
  const location = frameLocation(frame);
  if (!location) return undefined;
  const fn = usableFunction(frame.function);
  return fn ? `${fn}@${location}` : location;
};

const frameHasContentHash = (frame: GroupingFrame): boolean =>
  containsContentHash(frame.module ?? "") ||
  containsContentHash(frame.filename ?? "") ||
  containsContentHash(frame.abs_path ?? "");

/**
 * How many frames from the top of the stack enter the fingerprint. Bundlers
 * emit several unrelated chunks under the same name (nine different
 * `dist-<hash>.js` in one desktop build), so the top frame alone would merge
 * unrelated vendor code; the caller chain is what keeps them apart. The
 * resulting key is still strictly coarser than Sentry's default input — same
 * frames, minus the volatile hash and minified identifiers — so this can only
 * merge issues, never split one further.
 */
const FINGERPRINT_FRAMES = 8;

/**
 * A deploy-stable fingerprint for an event whose grouping input carries a build
 * content hash, or `undefined` to leave Sentry's default grouping in place.
 */
export const stableGroupingFingerprint = (event: GroupingEvent): readonly string[] | undefined => {
  const values = event.exception?.values ?? [];
  // Sentry orders chained exceptions innermost-first; the last entry is the one
  // the issue is titled with.
  const primary = values[values.length - 1];
  if (!primary) return undefined;

  const frames = primary.stacktrace?.frames ?? [];
  const culprit = event.culprit ?? "";
  if (!frames.some(frameHasContentHash) && !containsContentHash(culprit)) return undefined;

  const inApp = frames.filter((frame) => frame.in_app !== false);
  const considered = (inApp.length > 0 ? inApp : frames).slice(-FINGERPRINT_FRAMES).reverse();
  const keys = considered.flatMap((frame) => {
    const key = frameKey(frame);
    return key ? [key] : [];
  });

  const type = primary.type ?? "Error";
  if (keys.length > 0) return [type, ...keys];
  return culprit ? [type, stripContentHashes(culprit)] : undefined;
};

/**
 * The whole `beforeSend` contract: pin the deploy-stable fingerprint when the
 * event has a volatile grouping input, and forward the event untouched when it
 * does not. Every call site (cloud worker/DO, desktop main, desktop renderer)
 * installs this one symbol rather than its own copy, so the wiring is covered
 * by the tests below instead of being retyped per process.
 */
export const withStableGroupingFingerprint = <T extends GroupingEvent>(event: T): T => {
  const fingerprint = stableGroupingFingerprint(event);
  return fingerprint ? { ...event, fingerprint: [...fingerprint] } : event;
};
