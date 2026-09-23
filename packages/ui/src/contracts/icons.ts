import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { Option } from "effect";
import { getDomain } from "tldts";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type { Query } from "./dashboard.ts";

/** Use the old product's logo proxy, sending only a registrable domain at double display resolution. */
export const faviconUrl = (url: string | null | undefined, size: number): string | null => {
  if (!url) return null;
  const domain = getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
  return domain === null ? null : `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
};

/** Exact catalog names can supply missing display metadata; ambiguous brands never guess a domain. */
export const catalogIconDomainsAtom = <E>(catalogAtom: Query<readonly CatalogEntry[], E>) =>
  Atom.make((get) => {
    const domains = new Map<string, string | null>();
    const catalog = AsyncResult.value(get(catalogAtom));
    if (Option.isNone(catalog)) return domains;
    for (const entry of catalog.value) {
      const name = entry.name.trim().toLowerCase();
      const domain = getDomain(entry.domain);
      if (domain === null) continue;
      domains.set(name, domains.has(name) && domains.get(name) !== domain ? null : domain);
    }
    return domains;
  });
