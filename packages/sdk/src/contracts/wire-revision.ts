/**
 * Clients from earlier releases keep calling a host after it changes: an installed CLI, desktop app
 * or local server, and readers of the public registry. A client states the newest wire revision it
 * reads in {@link wireRevisionHeader}; a request without one comes from a client released before
 * revisions, which reads revision 0; every release through 2.0.0-beta.29 sends none. A host writes
 * each response in its client's revision, so a format that released clients decode is widened by
 * adding a revision, never by changing one.
 */

/** The request header that states the client's wire revision. */
export const wireRevisionHeader = "executor-wire-revision";

/**
 * The newest revision, which this release's clients state.
 * - 0: package names have no dot in their scope, as clients up to 2.0.0-beta.15 decode them.
 * - 1: package names are under publisher scopes, such as `@acme.executor.community/notes`.
 */
export const wireRevision = 1;

/** The revision a request's client reads: the one it states, at most {@link wireRevision}, else 0. */
export const requestWireRevision = (headers: Readonly<Record<string, string | undefined>>) => {
  const stated = Number(headers[wireRevisionHeader]);
  return Number.isSafeInteger(stated) && stated > 0 ? Math.min(stated, wireRevision) : 0;
};
