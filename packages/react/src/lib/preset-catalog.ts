import type { IntegrationPreset } from "@executor-js/sdk/client";

import { curatedFamily, familyLabel } from "./integration-grouping";

// ---------------------------------------------------------------------------
// The connect picker's browsable catalog.
//
// Plugins contribute a flat preset list each, which adds up to ~85 entries —
// half of them services of two providers ("Users", "Directory", "Profile" mean
// nothing on their own). Browsing wants those collapsed per provider; searching
// wants them flat, because someone typing "outlook" is looking for the service,
// not the provider card hiding it.
//
// Everything here is pure so the picker's behavior is testable without a DOM.
// ---------------------------------------------------------------------------

/** The slice of `IntegrationPlugin` the catalog reads. */
export interface PresetSourcePlugin {
  readonly key: string;
  readonly label: string;
  readonly presets?: readonly IntegrationPreset[];
}

export interface PresetEntry {
  readonly preset: IntegrationPreset;
  readonly pluginKey: string;
  readonly pluginLabel: string;
}

export interface PresetFamilyCard {
  readonly type: "family";
  readonly family: string;
  readonly label: string;
  readonly members: readonly PresetEntry[];
}

export interface PresetSingleCard {
  readonly type: "single";
  readonly entry: PresetEntry;
}

export type PresetCatalogItem = PresetFamilyCard | PresetSingleCard;

export interface PresetTypeFacet {
  /** `null` is the "All" facet. */
  readonly key: string | null;
  readonly label: string;
  /** Cards this protocol contributes for the active query. */
  readonly count: number;
}

export interface PresetFilter {
  readonly query?: string;
  /** Plugin key, or `null`/absent for every protocol. */
  readonly pluginKey?: string | null;
}

/** Flatten every plugin's presets, keeping the curated order plugins ship. */
export const presetCatalogEntries = (
  plugins: readonly PresetSourcePlugin[],
): readonly PresetEntry[] =>
  plugins.flatMap((plugin) =>
    (plugin.presets ?? []).map((preset) => ({
      preset,
      pluginKey: plugin.key,
      pluginLabel: plugin.label,
    })),
  );

/** The searchable text for one entry: what it is, what it does, whose it is,
 *  and how it connects. */
const searchCorpus = (entry: PresetEntry): string => {
  const { preset } = entry;
  const family = preset.family ? `${preset.family} ${familyLabel(preset.family)}` : "";
  return `${preset.name} ${preset.summary} ${family} ${preset.specFormat ?? ""} ${entry.pluginLabel}`.toLowerCase();
};

export const filterPresetEntries = (
  entries: readonly PresetEntry[],
  filter: PresetFilter,
): readonly PresetEntry[] => {
  const query = (filter.query ?? "").trim().toLowerCase();
  const pluginKey = filter.pluginKey ?? null;

  return entries.filter((entry) => {
    if (pluginKey !== null && entry.pluginKey !== pluginKey) return false;
    return query.length === 0 || searchCorpus(entry).includes(query);
  });
};

/** Collapse each curated provider with more than one service into a single
 *  card, in the position of its first member. A family of one browses better as
 *  itself, and a family the app doesn't group elsewhere isn't grouped here. */
export const groupPresetEntriesByFamily = (
  entries: readonly PresetEntry[],
): readonly PresetCatalogItem[] => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const family = curatedFamily(entry.preset.family);
    if (family) counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  const items: PresetCatalogItem[] = [];
  const indexByFamily = new Map<string, number>();

  for (const entry of entries) {
    const family = curatedFamily(entry.preset.family);
    if (!family || (counts.get(family) ?? 0) < 2) {
      items.push({ type: "single", entry });
      continue;
    }

    const at = indexByFamily.get(family);
    if (at === undefined) {
      indexByFamily.set(family, items.length);
      items.push({ type: "family", family, label: familyLabel(family), members: [entry] });
    } else {
      const card = items[at] as PresetFamilyCard;
      items[at] = { ...card, members: [...card.members, entry] };
    }
  }

  return items;
};

const isFeaturedCard = (item: PresetCatalogItem): boolean =>
  item.type === "family"
    ? item.members.some((member) => member.preset.featured === true)
    : item.entry.preset.featured === true;

/** Curated favourites first, everything else in catalog order. Plugins are
 *  registered in an order nobody chose for browsing, so without this the two
 *  provider cards standing in for half the library sort into the middle. */
const featuredFirst = (items: readonly PresetCatalogItem[]): readonly PresetCatalogItem[] => [
  ...items.filter(isFeaturedCard),
  ...items.filter((item) => !isFeaturedCard(item)),
];

/** What the picker shows for the current search and protocol filter.
 *
 *  Browsing groups a provider's services behind one card. Searching does NOT:
 *  someone who typed "outlook" has already told us they want the service, and
 *  re-collapsing the matches into the Microsoft card they were trying to look
 *  past hands back the same haystack. */
export const presetCatalogItems = (
  entries: readonly PresetEntry[],
  filter: PresetFilter,
): readonly PresetCatalogItem[] => {
  const matching = filterPresetEntries(entries, filter);
  const searching = (filter.query ?? "").trim().length > 0;
  // Search results keep relevance-neutral catalog order: the query already
  // ranked them, and reshuffling by "featured" fights what was typed.
  return searching
    ? matching.map((entry) => ({ type: "single", entry }))
    : featuredFirst(groupPresetEntriesByFamily(matching));
};

/** "All" plus one facet per protocol, each counting the CARDS it contributes
 *  for the active query — the number of results the chip actually reveals. */
export const presetTypeFacets = (
  entries: readonly PresetEntry[],
  query: string,
): readonly PresetTypeFacet[] => {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (!labels.has(entry.pluginKey)) labels.set(entry.pluginKey, entry.pluginLabel);
  }

  const cardCount = (pluginKey: string | null): number =>
    presetCatalogItems(entries, { query, pluginKey }).length;

  return [
    { key: null, label: "All", count: cardCount(null) },
    ...[...labels].map(([key, label]) => ({ key, label, count: cardCount(key) })),
  ];
};

/** The services behind one provider card, for the drill-down view. */
const familyMemberEntries = (
  entries: readonly PresetEntry[],
  family: string,
): readonly PresetEntry[] => entries.filter((entry) => entry.preset.family === family);

/** What the picker shows once a provider card is open: its services, each as
 *  itself, narrowed by the protocol chip still on screen.
 *
 *  There is no query here on purpose. Typing exits the drill-down, because a
 *  search scoped to the open provider would quietly hide the rest of the
 *  catalog from someone who asked it a question. */
export const familyDrillDownItems = (
  entries: readonly PresetEntry[],
  family: string,
  pluginKey: string | null,
): readonly PresetCatalogItem[] =>
  familyMemberEntries(entries, family)
    .filter((entry) => pluginKey === null || entry.pluginKey === pluginKey)
    .map((entry) => ({ type: "single", entry }));
