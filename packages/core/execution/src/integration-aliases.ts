/**
 * Integration alias resolution shared by every discovery surface: the
 * passthrough `search`/`integrations` MCP tools and the sandbox
 * `tools.search({ namespace })` call resolve the name a person would use
 * (`gmail`, `Google Calendar`) to the catalog slug the same way.
 */

/** What `integrations` and `search` resolve aliases against. */
export type IntegrationCatalogEntry = {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
};

/**
 * How an `integration` argument resolved: `exact` is the slug as given,
 * `alias` is one unambiguous match, `ambiguous` lists every slug that fits,
 * `none` matched nothing. The caller decides what to do with each.
 */
export type IntegrationResolution =
  | { readonly kind: "exact" | "alias"; readonly slug: string }
  | { readonly kind: "ambiguous"; readonly slugs: readonly string[] }
  | { readonly kind: "none" };

const aliasTokens = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const squash = (value: string): string => aliasTokens(value).join("");

/**
 * Resolve a human alias to catalog slugs: `gmail` → `google_gmail`,
 * `Google Calendar` → `google_calendar`. Exact slug first; then a slug or
 * name that is the same once separators and case are dropped; then every
 * alias word appearing in the slug or name; last, every word appearing in
 * the description. The first tier with any match decides.
 */
export const resolveIntegrationAlias = (
  input: string,
  catalog: readonly IntegrationCatalogEntry[],
): IntegrationResolution => {
  const trimmed = input.trim();
  if (catalog.some((entry) => entry.slug === trimmed)) return { kind: "exact", slug: trimmed };
  const words = aliasTokens(trimmed);
  const squashed = squash(trimmed);
  if (words.length === 0) return { kind: "none" };
  const covers = (haystack: readonly string[]) => words.every((word) => haystack.includes(word));
  const tiers: ReadonlyArray<(entry: IntegrationCatalogEntry) => boolean> = [
    (entry) => squash(entry.slug) === squashed || squash(entry.name) === squashed,
    (entry) => covers([...aliasTokens(entry.slug), ...aliasTokens(entry.name)]),
    (entry) => covers(aliasTokens(entry.description ?? "")),
  ];
  for (const matches of tiers) {
    const slugs = [...new Set(catalog.filter(matches).map((entry) => entry.slug))].sort();
    if (slugs.length === 1) return { kind: "alias", slug: slugs[0]! };
    if (slugs.length > 1) return { kind: "ambiguous", slugs };
  }
  return { kind: "none" };
};

/**
 * Display-name text per slug for ranking, limited to words the slug does not
 * already have: `google_gmail` / "Gmail" adds nothing; `scrape_api` /
 * "ScrapeCreators" adds "creators scrapecreators" (the split words and the
 * one-word spelling a person types).
 */
export const integrationAliasText = (
  catalog: readonly IntegrationCatalogEntry[],
): ReadonlyMap<string, string> => {
  const aliases = new Map<string, string>();
  for (const entry of catalog) {
    const slugTokens = new Set(aliasTokens(entry.slug));
    const nameTokens = aliasTokens(entry.name);
    const candidates = nameTokens.length > 1 ? [...nameTokens, nameTokens.join("")] : nameTokens;
    const extra = [...new Set(candidates)].filter((token) => !slugTokens.has(token));
    if (extra.length > 0) aliases.set(entry.slug, extra.join(" "));
  }
  return aliases;
};
