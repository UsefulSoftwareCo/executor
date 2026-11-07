/** Whether an installed catalog app rolls forward to the feed's current source. No I/O. */

/** Why the catalog's current source would leave a linked account or slot unusable. */
export type CatalogBreak = "removed" | "provider" | "scope" | "added" | "cardinality";

/** One account requirement, as a version declares it. */
export interface CatalogSlot {
  readonly provider: string;
  readonly scope: string;
  readonly cardinality: string;
}

/** One link to the app; `subject` is the linking member for a user requirement, else null. */
export interface CatalogLink {
  readonly requirement: string;
  readonly scope: string;
  readonly subject: string | null;
  readonly account: string;
  readonly provider: string;
}

/**
 * The feed entry an app was copied from, or undefined when its origin is anything else. The
 * reference format is the catalog source's own: `apps/<encoded id>.json` beside the index.
 */
export const catalogEntryId = (reference: string | undefined, feedUrl: string) => {
  const apps = new URL("apps/", feedUrl).href;
  if (reference === undefined || !reference.startsWith(apps) || !reference.endsWith(".json"))
    return undefined;
  const encoded = reference.slice(apps.length, -".json".length);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  try {
    const id = decodeURIComponent(encoded);
    return new URL(`apps/${encodeURIComponent(id)}.json`, feedUrl).href === reference
      ? id
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Before building: `record` when the active source already is the catalog's, `skip` for unsaved
 * workspace edits, otherwise `evaluate` the catalog source's requirements.
 */
export const decideCatalogUpdate = (input: {
  readonly unchanged: boolean;
  readonly clean: boolean;
}) => (input.unchanged ? "record" : input.clean ? "evaluate" : "skip");

/**
 * After building: deploy only an untouched copy no linked account breaks on. An install is
 * untouched while it has one version, or its active version is the one this feature recorded.
 * Anything else is an offer, and nothing is deployed, so no catalog migration runs on it.
 */
export const decideCatalogOffer = (input: {
  readonly versions: number;
  readonly active: string;
  readonly recorded: string | undefined;
  readonly breaking: boolean;
}) => {
  const untouched = input.versions === 1 || input.active === input.recorded;
  return { untouched, decision: untouched && !input.breaking ? "apply" : "offer" } as const;
};

const slotOf = (slots: Readonly<Record<string, CatalogSlot>>, name: string) =>
  Object.hasOwn(slots, name) ? slots[name] : undefined;

/**
 * Linked accounts the catalog source can no longer use, and why. A slot that is gone, needs
 * another provider or links in the other scope breaks its accounts. A new slot nobody linked
 * breaks the app until someone does. A slot that becomes single keeps one account per linker.
 */
export const breakingChanges = (
  links: ReadonlyArray<CatalogLink>,
  before: Readonly<Record<string, CatalogSlot>>,
  after: Readonly<Record<string, CatalogSlot>>,
) => {
  const reasons = new Set<CatalogBreak>();
  const broken = new Set<string>();
  const kept: CatalogLink[] = [];
  for (const link of links) {
    const slot = slotOf(after, link.requirement);
    const reason =
      slot === undefined
        ? "removed"
        : slot.provider !== link.provider
          ? "provider"
          : slot.scope !== link.scope
            ? "scope"
            : undefined;
    if (reason === undefined) kept.push(link);
    else {
      reasons.add(reason);
      broken.add(link.account);
    }
  }
  let extra = 0;
  for (const [name, slot] of Object.entries(after)) {
    if (slotOf(before, name) === undefined && !links.some((link) => link.requirement === name))
      reasons.add("added");
    if (slot.cardinality !== "one" || slotOf(before, name)?.cardinality !== "many") continue;
    const linkers = new Map<string | null, Set<string>>();
    for (const link of kept.filter((link) => link.requirement === name))
      linkers.set(link.subject, (linkers.get(link.subject) ?? new Set()).add(link.account));
    for (const accounts of linkers.values())
      if (accounts.size > 1) {
        reasons.add("cardinality");
        extra += accounts.size - 1;
      }
  }
  return { reconnect: broken.size + extra, reasons: [...reasons].sort() };
};
