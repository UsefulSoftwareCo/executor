export type CatalogBreak = "removed" | "provider" | "scope" | "added" | "cardinality";

export interface CatalogSlot {
  readonly provider: string;
  readonly scope: string;
  readonly cardinality: string;
}

export interface CatalogLink {
  readonly requirement: string;
  readonly scope: string;
  readonly subject: string | null;
  readonly account: string;
  readonly provider: string;
}

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

export const decideCatalogUpdate = (input: {
  readonly unchanged: boolean;
  readonly clean: boolean;
}) => (input.unchanged ? "record" : input.clean ? "evaluate" : "skip");

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
